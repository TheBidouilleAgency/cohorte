from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Literal

from cohorte.domain.models import (
    AgentDefaults,
    CheckDefinition,
    MetadataMode,
    ProjectProfile,
    Provider,
    Surface,
    VcsConfig,
    slugify,
)


def _git(root: Path, *args: str) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=False, timeout=5
    )
    return result.stdout.strip() if result.returncode == 0 else None


def discover_project(root: Path, language: str = "fr") -> tuple[ProjectProfile, list[str]]:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("project root is not a directory")
    checks: list[CheckDefinition] = []
    surfaces: list[Surface] = []
    questions: list[str] = []

    if (root / "pyproject.toml").is_file():
        checks.extend(
            [
                CheckDefinition(
                    id="tests", argv=["uv", "run", "pytest", "-q"], timeout_seconds=900
                ),
                CheckDefinition(
                    id="lint", argv=["uv", "run", "ruff", "check", "."], timeout_seconds=120
                ),
            ]
        )
        paths = [path for path in ["src", "tests"] if (root / path).exists()] or ["."]
        surfaces.append(
            Surface(
                id="python",
                label="Python",
                paths=paths,
                role_profile="implementer",
                check_ids=["tests", "lint"],
            )
        )
    elif (root / "package.json").is_file():
        package_manager = "pnpm" if (root / "pnpm-lock.yaml").is_file() else "npm"
        run = [package_manager, "test"]
        checks.append(CheckDefinition(id="tests", argv=run, timeout_seconds=900))
        workspace_manifests = [*root.glob("*/package.json"), *root.glob("*/*/package.json")]
        workspace_roots = [
            path.parent.relative_to(root).as_posix()
            for path in workspace_manifests
            if not {"node_modules", ".git"}.intersection(path.relative_to(root).parts)
        ]
        paths = sorted(set(workspace_roots)) or ["src" if (root / "src").exists() else "."]
        for path in paths:
            identifier = slugify(Path(path).name if path != "." else root.name)
            surfaces.append(
                Surface(
                    id=identifier,
                    label=path,
                    paths=[path],
                    role_profile="implementer",
                    check_ids=["tests"],
                )
            )
        if len(paths) > 1:
            questions.append("Confirmer l'ownership des fichiers partagés et du lockfile.")
    else:
        surfaces.append(
            Surface(id="project", label="Project", paths=["."], role_profile="implementer")
        )
        questions.append("Aucun manifest reconnu : définir les commandes de test et de lint.")

    branch = _git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "--short")
    default_branch = branch.split("/", 1)[1] if branch and "/" in branch else "main"
    remote_url = _git(root, "remote", "get-url", "origin") or ""
    host: Literal["github", "gitlab", "other"] = (
        "github" if "github" in remote_url else "gitlab" if "gitlab" in remote_url else "other"
    )
    profile = ProjectProfile(
        project_id=slugify(root.name),
        name=root.name,
        language=language,
        metadata_mode=MetadataMode.LOCAL,
        vcs=VcsConfig(host=host, default_branch=default_branch),
        surfaces=surfaces,
        checks=checks,
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )
    return profile, questions


def profile_provenance(root: Path) -> dict[str, Any]:
    names = ["pyproject.toml", "package.json", "pnpm-workspace.yaml", ".github/workflows"]
    return {name: (root / name).exists() for name in names}
