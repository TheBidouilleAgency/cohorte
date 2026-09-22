from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

_RUNTIME_DIRECTORIES = frozenset({"__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"})
_RUNTIME_FILES = frozenset({".coverage"})
_RUNTIME_SUFFIXES = frozenset({".pyc", ".pyo"})


def _is_runtime_artifact(path: str) -> bool:
    candidate = Path(path)
    return (
        any(part in _RUNTIME_DIRECTORIES for part in candidate.parts)
        or candidate.name in _RUNTIME_FILES
        or candidate.suffix in _RUNTIME_SUFFIXES
    )


class GitRepository:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)
        self._run("rev-parse", "--is-inside-work-tree")

    def _run(self, *args: str, cwd: Path | None = None) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd or self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            message = (result.stderr or result.stdout).strip()
            raise RuntimeError(f"git {' '.join(args)} failed: {message}")
        return result.stdout.strip()

    @property
    def head(self) -> str:
        return self._run("rev-parse", "HEAD")

    def create_worktree(
        self, destination: Path, branch: str, start_point: str | None = None
    ) -> GitRepository:
        destination = destination.resolve()
        if destination.exists():
            raise ValueError(f"worktree destination already exists: {destination}")
        self._run("worktree", "add", "-b", branch, str(destination), start_point or self.head)
        return GitRepository(destination)

    def changed_files(self, base_commit: str) -> list[str]:
        tracked = self._run("diff", "--name-only", "--relative", base_commit, "--").splitlines()
        untracked = self._run("ls-files", "--others", "--exclude-standard", "-z").split("\0")
        visible_untracked = [path for path in untracked if path and not _is_runtime_artifact(path)]
        return sorted({path for path in [*tracked, *visible_untracked] if path})

    def diff(self, base_commit: str) -> str:
        return self._run("diff", "--binary", "--no-ext-diff", base_commit, "--")

    def commit_all(self, message: str, run_id: str) -> str:
        self._run("add", "--all", "--")
        self._run("commit", "-m", message, "-m", f"Cohorte-Run: {run_id}")
        return self.head

    def commit_task(self, message: str, run_id: str, task_id: str) -> str:
        self._run("add", "--all", "--")
        self._run(
            "commit",
            "-m",
            message,
            "-m",
            f"Cohorte-Run: {run_id}\nCohorte-Task: {task_id}",
        )
        return self.head

    def cherry_pick(self, commit: str) -> str:
        try:
            self._run("cherry-pick", commit)
        except RuntimeError:
            subprocess.run(
                ["git", "cherry-pick", "--abort"],
                cwd=self.root,
                capture_output=True,
                check=False,
            )
            raise
        return self.head

    def commits_since(self, base_commit: str) -> list[str]:
        output = self._run("rev-list", "--reverse", f"{base_commit}..HEAD")
        return output.splitlines() if output else []

    def is_dirty(self) -> bool:
        return bool(self._run("status", "--porcelain=v1", "--untracked-files=all"))

    def commit_for_run(self, run_id: str) -> str | None:
        marker = self._run("log", "-1", "--format=%B")
        return self.head if f"Cohorte-Run: {run_id}" in marker else None

    def commit_for_task(self, run_id: str, task_id: str) -> str | None:
        marker = self._run("log", "-1", "--format=%B")
        required = (f"Cohorte-Run: {run_id}", f"Cohorte-Task: {task_id}")
        return self.head if all(value in marker for value in required) else None

    def remote_head(self, remote: str, branch: str) -> str | None:
        output = self._run("ls-remote", "--heads", remote, f"refs/heads/{branch}")
        return output.split()[0] if output else None

    def push_branch(self, remote: str, branch: str) -> str:
        self._run("push", remote, f"HEAD:refs/heads/{branch}")
        head = self.remote_head(remote, branch)
        if head != self.head:
            raise RuntimeError("remote branch does not match the local commit after push")
        return head

    def snapshot_digest(self) -> str:
        digest = hashlib.sha256()
        for directory, names, files in os.walk(self.root):
            names[:] = sorted(
                name for name in names if name != ".git" and name not in _RUNTIME_DIRECTORIES
            )
            for name in sorted(files):
                path = Path(directory, name)
                if ".git" in path.relative_to(self.root).parts:
                    continue
                relative = path.relative_to(self.root).as_posix()
                if _is_runtime_artifact(relative):
                    continue
                digest.update(relative.encode())
                digest.update(b"\0")
                digest.update(path.read_bytes())
                digest.update(b"\0")
        return digest.hexdigest()


def path_is_owned(path: str, allowed: list[str]) -> bool:
    candidate = Path(path)
    return any(candidate == Path(root) or Path(root) in candidate.parents for root in allowed)
