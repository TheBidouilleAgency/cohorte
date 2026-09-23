from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Literal

import yaml  # type: ignore[import-untyped]

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


def _package_manifest(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError(f"package manifest must be an object: {path}")
    return document


def _workspace_patterns(root: Path, package: dict[str, Any]) -> list[str]:
    pnpm = root / "pnpm-workspace.yaml"
    if pnpm.is_file():
        document = yaml.safe_load(pnpm.read_text(encoding="utf-8")) or {}
        if not isinstance(document, dict) or not isinstance(document.get("packages"), list):
            raise ValueError("pnpm-workspace.yaml needs a packages list")
        if not all(isinstance(item, str) for item in document["packages"]):
            raise ValueError("pnpm-workspace.yaml packages must be strings")
        return [str(item) for item in document["packages"]]
    workspaces = package.get("workspaces", [])
    if isinstance(workspaces, dict):
        workspaces = workspaces.get("packages", [])
    if isinstance(workspaces, list):
        if not all(isinstance(item, str) for item in workspaces):
            raise ValueError("package.json workspaces must be strings")
        return [str(item) for item in workspaces]
    return []


def _workspace_manifests(root: Path, patterns: list[str]) -> list[Path]:
    if not patterns:
        return sorted(
            path
            for path in [*root.glob("*/package.json"), *root.glob("*/*/package.json")]
            if not {"node_modules", ".git"}.intersection(path.relative_to(root).parts)
            and path.resolve().is_relative_to(root)
        )
    included: set[Path] = set()
    excluded: set[Path] = set()
    for raw in patterns:
        negated = raw.startswith("!")
        pattern = raw[1:] if negated else raw
        if not pattern or Path(pattern).is_absolute() or ".." in Path(pattern).parts:
            raise ValueError(f"unsafe workspace pattern: {raw}")
        target = excluded if negated else included
        for directory in root.glob(pattern):
            resolved = directory.resolve()
            if not resolved.is_relative_to(root) or not directory.is_dir():
                continue
            manifest = directory / "package.json"
            if manifest.is_file():
                target.add(manifest)
    return sorted(included - excluded)


def _node_checks(package_manager: str, scripts: dict[str, Any]) -> list[CheckDefinition]:
    definitions: list[CheckDefinition] = []
    for check_id, script in (
        ("tests", "test"),
        ("lint", "lint"),
        ("types", "check-types"),
        ("format", "format:check"),
    ):
        if isinstance(scripts.get(script), str):
            command = (
                [package_manager, "run", script]
                if package_manager == "npm"
                else [package_manager, script]
            )
            definitions.append(CheckDefinition(id=check_id, argv=command, timeout_seconds=900))
    return definitions


def _workspace_paths(root: Path) -> list[str]:
    candidates = (
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
        "package-lock.json",
        "turbo.json",
        "nx.json",
        "AGENTS.md",
        "README.md",
        "scripts",
        "patches",
        "docker",
        ".github/workflows",
        ".changeset",
    )
    return [path for path in candidates if (root / path).exists()]


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
        package = _package_manifest(root / "package.json")
        package_manager = (
            "pnpm"
            if (root / "pnpm-lock.yaml").is_file()
            or (root / "pnpm-workspace.yaml").is_file()
            or str(package.get("packageManager", "")).startswith("pnpm@")
            else "npm"
        )
        scripts = package.get("scripts", {})
        checks = _node_checks(package_manager, scripts if isinstance(scripts, dict) else {})
        if not checks:
            questions.append("Aucun check racine reconnu : définir les commandes de validation.")
        patterns = _workspace_patterns(root, package)
        manifests = _workspace_manifests(root, patterns)
        if manifests:
            paths = [path.parent.relative_to(root).as_posix() for path in manifests]
            identifiers: dict[str, str] = {}
            used_ids: set[str] = set()
            for path in paths:
                identifier = slugify(Path(path).name)
                if identifier in used_ids:
                    identifier = slugify(path)
                if identifier in used_ids:
                    raise ValueError(f"duplicate workspace surface id: {identifier}")
                identifiers[path] = identifier
                used_ids.add(identifier)
            packages = {path: _package_manifest(root / path / "package.json") for path in paths}
            names: dict[str, str] = {}
            duplicate_names: set[str] = set()
            for path, manifest in packages.items():
                name = manifest.get("name")
                if isinstance(name, str):
                    if name in names:
                        duplicate_names.add(name)
                    else:
                        names[name] = identifiers[path]
            for name in duplicate_names:
                names.pop(name, None)
            if duplicate_names:
                questions.append(
                    "Corriger les noms de packages dupliqués avant de figer les dépendances."
                )
            check_ids = [check.id for check in checks]
            for path in paths:
                manifest = packages[path]
                dependencies = {
                    names[name]
                    for field in ("dependencies", "devDependencies", "optionalDependencies")
                    for name in manifest.get(field, {})
                    if name in names and names[name] != identifiers[path]
                }
                surfaces.append(
                    Surface(
                        id=identifiers[path],
                        label=path,
                        paths=[path],
                        depends_on=sorted(dependencies),
                        role_profile="implementer",
                        check_ids=check_ids,
                        uses_design=(root / path / "design-reference").is_dir(),
                    )
                )
            shared_paths = _workspace_paths(root)
            if shared_paths:
                workspace_id = "workspace"
                if workspace_id in used_ids:
                    workspace_id = "workspace-root"
                surfaces.append(
                    Surface(
                        id=workspace_id,
                        label="Shared workspace files",
                        paths=shared_paths,
                        role_profile="implementer",
                        check_ids=check_ids,
                    )
                )
            questions.append("Confirmer l'ownership des fichiers partagés et du lockfile.")
            if (root / "packages/shared-types").is_dir():
                questions.append(
                    "Confirmer si packages/shared-types porte un contrat entre surfaces."
                )
            if any(surface.uses_design for surface in surfaces):
                questions.append(
                    "Confirmer la source et les règles du design system avant de l'activer."
                )
        else:
            path = "src" if (root / "src").exists() else "."
            surfaces.append(
                Surface(
                    id=slugify(root.name),
                    label=path,
                    paths=[path],
                    role_profile="implementer",
                    check_ids=[check.id for check in checks],
                )
            )
        ci = root / ".github/workflows/ci.yml"
        if ci.is_file() and "services:" in ci.read_text(encoding="utf-8"):
            questions.append(
                "Confirmer les services et migrations à préparer pour les checks locaux."
            )
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
