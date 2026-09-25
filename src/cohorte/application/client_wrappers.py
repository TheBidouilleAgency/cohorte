"""Optional host-client shortcuts; Cohorte CLI remains the sole workflow engine."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

RUNTIME_PATHS = {
    "claude": ".claude/commands/cohorte.md",
    "codex": ".agents/skills/cohorte/SKILL.md",
    "cursor": ".cursor/commands/cohorte.md",
    "gemini": ".gemini/commands/cohorte.toml",
    "opencode": ".opencode/commands/cohorte.md",
}

_BODY = (
    "Cohorte is the workflow engine for this project. The CLI owns project profiling, "
    "agent selection, decisions, checks, reviews, persistence and delivery. "
    "You are only a thin client: do not reproduce the workflow in this chat or choose "
    "answers for the user.\n\n"
    "For the requested Cohorte command, use the installed `cohorte` CLI in this project's "
    "root. Inspect `cohorte --help` or `cohorte <command> --help` if syntax is unclear. "
    "Run only a complete, explicit command; ask the user for missing arguments. "
    "Interactive commands need a real terminal. If your shell cannot provide one, show a "
    "copy-ready CLI command instead of pretending to finish it. Preserve JSON output, "
    "decision requests and errors verbatim enough for the user to act. "
    "Explain that Claude Code and Codex are Cohorte's native agent providers; this client "
    "is a wrapper, not another execution provider.\n\n"
)


def _render_legacy(runtime: str) -> str:
    if runtime == "gemini":
        return (
            'description = "Use the Cohorte CLI workflow engine"\n'
            'prompt = """\n'
            + _BODY.replace('"""', "")
            + "Requested Cohorte command: {{args}}\n"
            + '"""\n'
        )
    if runtime == "codex":
        return (
            "---\nname: cohorte\ndescription: Delegate requested Cohorte workflows "
            "to the installed Cohorte CLI.\n---\n\n"
            + _BODY
            + "Use this skill when the user explicitly asks to run Cohorte.\n"
        )
    frontmatter = (
        "---\ndescription: Use the Cohorte CLI workflow engine\n---\n\n"
        if runtime in {"claude", "opencode"}
        else ""
    )
    arguments = "$ARGUMENTS" if runtime in {"claude", "opencode"} else "the user's arguments"
    return frontmatter + _BODY + f"Requested Cohorte command: {arguments}\n"


def _render(runtime: str) -> str:
    marker = (
        "# Managed by Cohorte; update with cohorte update-pipeline.\n"
        if runtime == "gemini"
        else "<!-- Managed by Cohorte; update with cohorte update-pipeline. -->\n"
    )
    return _render_legacy(runtime) + marker


def installed_wrappers(root: Path) -> list[str]:
    root = root.resolve(strict=True)
    return [
        runtime
        for runtime, relative in RUNTIME_PATHS.items()
        if (root / relative).exists() or (root / relative).is_symlink()
    ]


def wrapper_plan(root: Path, runtimes: list[str]) -> list[dict[str, Any]]:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("wrapper root must be a directory")
    if not runtimes or len(runtimes) != len(set(runtimes)):
        raise ValueError("select distinct wrapper runtimes")
    if unknown := sorted(set(runtimes) - RUNTIME_PATHS.keys()):
        raise ValueError(f"unknown wrapper runtimes: {', '.join(unknown)}")
    plan: list[dict[str, Any]] = []
    for runtime in runtimes:
        relative = RUNTIME_PATHS[runtime]
        destination = root / relative
        if any(
            part.is_symlink()
            for part in (destination, *destination.parents)
            if part != root and part.is_relative_to(root)
        ):
            raise ValueError(f"wrapper destination contains a symlink: {relative}")
        content = _render(runtime)
        existing = destination.read_text(encoding="utf-8") if destination.is_file() else None
        occupied = destination.exists() or destination.is_symlink()
        plan.append(
            {
                "runtime": runtime,
                "path": relative,
                "status": "current"
                if existing == content
                else "update"
                if existing == _render_legacy(runtime)
                else "conflict"
                if occupied
                else "create",
                "sha256": hashlib.sha256(content.encode()).hexdigest(),
            }
        )
    return plan


def apply_wrappers(root: Path, runtimes: list[str]) -> list[dict[str, Any]]:
    root = root.resolve(strict=True)
    plan = wrapper_plan(root, runtimes)
    if any(item["status"] == "conflict" for item in plan):
        raise ValueError("wrapper file already exists with different content; no file was changed")
    for item in plan:
        if item["status"] not in {"create", "update"}:
            continue
        destination = root / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + ".cohorte.tmp")
        temporary.write_text(_render(item["runtime"]), encoding="utf-8")
        os.replace(temporary, destination)
    return wrapper_plan(root, runtimes)
