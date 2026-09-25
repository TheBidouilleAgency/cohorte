from __future__ import annotations

import json
import subprocess
import tomllib
from pathlib import Path
from typing import Any, Literal

import yaml  # type: ignore[import-untyped]

from cohorte.domain.models import (
    AgentDefaults,
    CheckDefinition,
    CheckScope,
    ContractConfig,
    Integrations,
    MetadataMode,
    ProjectProfile,
    Provider,
    Surface,
    VcsConfig,
    slugify,
)
from cohorte.domain.redaction import redact_text


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


def _surface_checks(
    package_manager: str, surface_id: str, path: str, manifest: dict[str, Any]
) -> list[CheckDefinition]:
    scripts = manifest.get("scripts", {})
    if not isinstance(scripts, dict):
        return []
    checks: list[CheckDefinition] = []
    for suffix, script in (
        ("tests", "test"),
        ("lint", "lint"),
        ("types", "check-types" if "check-types" in scripts else "typecheck"),
        ("format", "format:check"),
        ("build", "build"),
    ):
        if not isinstance(scripts.get(script), str):
            continue
        argv = (
            ["npm", "run", script, "--workspace", path]
            if package_manager == "npm"
            else [package_manager, "--filter", f"./{path}", script]
        )
        checks.append(
            CheckDefinition(
                id=f"{surface_id}-{suffix}",
                argv=argv,
                timeout_seconds=900,
                scope=CheckScope.SURFACE,
            )
        )
    return checks


def _surface_role(manifest: dict[str, Any]) -> str:
    packages = {
        name for field in ("dependencies", "devDependencies") for name in manifest.get(field, {})
    }
    frontend = bool(packages & {"react", "vue", "svelte", "next", "@angular/core"})
    backend = bool(packages & {"@adonisjs/core", "@nestjs/core", "fastify", "express"})
    if frontend and backend:
        return "fullstack"
    if frontend:
        return "frontend"
    if backend:
        return "backend"
    if packages & {"zod", "@sinclair/typebox"} or "types" in str(manifest.get("name", "")):
        return "contract"
    return "implementer"


def _detect_contract(root: Path, surfaces: list[Surface]) -> ContractConfig:
    if (root / "contract").is_dir():
        return ContractConfig(enabled=True, mechanism="shared-types", paths=["contract"])
    explicit = [
        path
        for path in ("openapi.yaml", "openapi.yml", "openapi.json", "schema.graphql")
        if (root / path).is_file()
    ]
    if explicit:
        return ContractConfig(
            enabled=True,
            mechanism="openapi" if explicit[0].startswith("openapi") else "graphql",
            paths=explicit,
        )
    for surface in surfaces:
        if "shared-types" in surface.id:
            return ContractConfig(enabled=True, mechanism="shared-types", paths=surface.paths)
    for surface in surfaces:
        if "api-kit" in surface.id:
            return ContractConfig(enabled=True, mechanism="shared-types", paths=surface.paths)
    return ContractConfig()


def _detect_design(root: Path) -> bool:
    return any(
        (root / path).is_dir()
        for path in ("design-reference", "src/components/ui", "components/ui")
    )


def _detect_release_notes(root: Path, package: dict[str, Any]) -> dict[str, Any]:
    if (root / ".changeset/config.json").is_file():
        return {"enabled": True, "provider": "changesets", "path": ".changeset"}
    if (root / "CHANGELOG.md").is_file() and (
        (root / ".github/workflows/release.yml").is_file()
        or "release:version" in package.get("scripts", {})
    ):
        return {"enabled": True, "provider": "changelog", "path": "CHANGELOG.md"}
    return {"enabled": False}


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


def _project_description(root: Path) -> str:
    readme = root / "README.md"
    if not readme.is_file() or readme.stat().st_size > 160_000:
        return ""
    lines = readme.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in lines[:80]:
        candidate = line.strip()
        if (
            candidate
            and not candidate.startswith(("#", "[", "!", "<", "`", "-", "*", ">"))
            and len(candidate) >= 25
        ):
            return candidate[:1000]
    return ""


def _discovery_signals(root: Path) -> dict[str, list[str]]:
    conventions = [
        path
        for path in (
            "AGENTS.md",
            "PIPELINE.md",
            "CONTRIBUTING.md",
            ".github/copilot-instructions.md",
            ".cursor/rules",
        )
        if (root / path).exists()
    ]
    design = [
        path
        for path in (
            "design-reference",
            "docs/design-system.md",
            "src/components/ui",
            "components/ui",
            "src/styles/tokens.css",
            "tokens",
        )
        if (root / path).exists()
    ]
    isolation = [
        path
        for path in (
            "Dockerfile",
            "docker-compose.yml",
            "compose.yml",
            "compose.yaml",
            ".devcontainer/devcontainer.json",
        )
        if (root / path).exists()
    ]
    retrieval: list[str] = []
    for relative in (".mcp.json", ".cursor/mcp.json", ".claude/settings.json"):
        path = root / relative
        try:
            resolved = path.resolve(strict=True)
            if (
                not resolved.is_relative_to(root)
                or not resolved.is_file()
                or resolved.stat().st_size > 64_000
            ):
                continue
        except OSError:
            continue
        try:
            document = json.loads(resolved.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if not isinstance(document, dict):
            continue
        for key in ("mcpServers", "mcp_servers", "servers"):
            servers = document.get(key)
            if isinstance(servers, dict):
                retrieval.extend(
                    f"{relative}:{name}"
                    for name in servers
                    if isinstance(name, str)
                    and any(provider in name.casefold() for provider in ("serena", "graphify"))
                )
    return {
        "conventions": conventions,
        "design": design,
        "retrieval": sorted(set(retrieval)),
        "isolation": isolation,
    }


def _convention_candidates(root: Path, sources: list[str]) -> list[dict[str, Any]]:
    """Offer bounded repository rules for explicit acceptance, never import them silently."""
    candidates: list[dict[str, Any]] = []
    for relative in sources:
        source = root / relative
        if source.is_symlink() or not source.is_file() or source.stat().st_size > 128_000:
            continue
        for number, raw in enumerate(
            source.read_text(encoding="utf-8", errors="replace").splitlines(), 1
        ):
            line = raw.strip()
            if not line.startswith(("- ", "* ")):
                continue
            rule = redact_text(line[2:].strip())
            if 15 <= len(rule) <= 300:
                candidates.append({"source": relative, "line": number, "rule": rule})
            if len(candidates) >= 20:
                return candidates
    return candidates


def discover_project(root: Path, language: str = "fr") -> tuple[ProjectProfile, list[str]]:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("project root is not a directory")
    checks: list[CheckDefinition] = []
    surfaces: list[Surface] = []
    questions: list[str] = []
    integrations = Integrations()

    if (root / "pyproject.toml").is_file():
        pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
        tooling = pyproject.get("tool", {})
        uv_project = (root / "uv.lock").is_file()
        uv_extras: list[str] = []
        if uv_project:
            workflow_dir = root / ".github" / "workflows"
            workflows = (
                [*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")]
                if workflow_dir.is_dir()
                else []
            )
            if any(
                "uv sync --all-extras" in path.read_text(encoding="utf-8", errors="replace")
                for path in workflows
            ):
                uv_extras = ["--all-extras"]
            elif "dev" in pyproject.get("project", {}).get("optional-dependencies", {}):
                uv_extras = ["--extra", "dev"]
        command_prefix = (
            ["uv", "run", *uv_extras]
            if uv_project
            else ["poetry", "run"]
            if (root / "poetry.lock").is_file()
            else []
        )
        test_available = (root / "tests").is_dir() or "pytest" in tooling
        lint_available = "ruff" in tooling
        detected_checks: list[CheckDefinition] = []
        if test_available:
            detected_checks.append(
                CheckDefinition(
                    id="tests",
                    argv=[*command_prefix, "pytest", "-q"]
                    if command_prefix
                    else ["python", "-m", "pytest", "-q"],
                    timeout_seconds=900,
                )
            )
        if lint_available:
            detected_checks.append(
                CheckDefinition(
                    id="lint", argv=[*command_prefix, "ruff", "check", "."], timeout_seconds=120
                )
            )
            detected_checks.append(
                CheckDefinition(
                    id="format",
                    argv=[*command_prefix, "ruff", "format", "--check", "."],
                    timeout_seconds=120,
                )
            )
        if "mypy" in tooling:
            detected_checks.append(
                CheckDefinition(id="types", argv=[*command_prefix, "mypy"], timeout_seconds=300)
            )
        if not detected_checks:
            questions.append("Aucun check Python confirmé : choisir les commandes de validation.")
        checks.extend(detected_checks)
        paths = [path for path in ["src", "tests"] if (root / path).exists()] or ["."]
        surfaces.append(
            Surface(
                id="python",
                label="Python",
                paths=paths,
                role_profile="implementer",
                check_ids=[check.id for check in detected_checks],
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
        integrations = Integrations(release_notes=_detect_release_notes(root, package))
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
            root_check_ids = [check.id for check in checks]
            for path in paths:
                manifest = packages[path]
                surface_id = identifiers[path]
                specific = _surface_checks(package_manager, surface_id, path, manifest)
                checks.extend(specific)
                dependencies = {
                    names[name]
                    for field in ("dependencies", "devDependencies", "optionalDependencies")
                    for name in manifest.get(field, {})
                    if name in names and names[name] != surface_id
                }
                surfaces.append(
                    Surface(
                        id=surface_id,
                        label=path,
                        paths=[path],
                        depends_on=sorted(dependencies),
                        role_profile=_surface_role(manifest),
                        check_ids=[check.id for check in specific] or root_check_ids,
                        uses_design=(root / path / "design-reference").is_dir()
                        or (root / path / "src/components/ui").is_dir(),
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
                        check_ids=root_check_ids,
                    )
                )
            for name, role in (
                ("src", "frontend" if _surface_role(package) == "frontend" else "implementer"),
                ("src-tauri", "backend"),
                ("contract", "contract"),
            ):
                if not (root / name).is_dir() or any(
                    name == owned or name.startswith(owned + "/")
                    for surface in surfaces
                    for owned in surface.paths
                ):
                    continue
                identifier = "rust" if name == "src-tauri" else name
                extra_checks: list[str] = root_check_ids
                if name == "src-tauri" and (root / name / "Cargo.toml").is_file():
                    checks.extend(
                        [
                            CheckDefinition(
                                id="rust-tests",
                                argv=["cargo", "test"],
                                cwd=name,
                                timeout_seconds=900,
                                scope=CheckScope.SURFACE,
                            ),
                            CheckDefinition(
                                id="rust-lint",
                                argv=["cargo", "clippy", "--all-targets"],
                                cwd=name,
                                timeout_seconds=900,
                                scope=CheckScope.SURFACE,
                            ),
                        ]
                    )
                    extra_checks = ["rust-tests", "rust-lint"]
                surfaces.append(
                    Surface(
                        id=identifier,
                        label=name,
                        paths=[name],
                        role_profile=role,
                        check_ids=extra_checks,
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
                    check_ids=[check.id for check in checks],
                    role_profile=_surface_role(package),
                    uses_design=_detect_design(root),
                )
            )
            for name, role in (("src-tauri", "backend"), ("contract", "contract")):
                if not (root / name).is_dir():
                    continue
                if path == ".":
                    questions.append(f"Définir une ownership distincte pour {name} et la racine.")
                    continue
                identifier = "rust" if name == "src-tauri" else name
                extra_checks = [check.id for check in checks]
                if name == "src-tauri" and (root / name / "Cargo.toml").is_file():
                    checks.extend(
                        [
                            CheckDefinition(
                                id="rust-tests",
                                argv=["cargo", "test"],
                                cwd=name,
                                timeout_seconds=900,
                                scope=CheckScope.SURFACE,
                            ),
                            CheckDefinition(
                                id="rust-lint",
                                argv=["cargo", "clippy", "--all-targets"],
                                cwd=name,
                                timeout_seconds=900,
                                scope=CheckScope.SURFACE,
                            ),
                        ]
                    )
                    extra_checks = ["rust-tests", "rust-lint"]
                surfaces.append(
                    Surface(
                        id=identifier,
                        label=name,
                        paths=[name],
                        role_profile=role,
                        check_ids=extra_checks,
                    )
                )
        ci = root / ".github/workflows/ci.yml"
        if ci.is_file() and "services:" in ci.read_text(encoding="utf-8"):
            questions.append(
                "Confirmer les services et migrations à préparer pour les checks locaux."
            )
    elif (root / "Cargo.toml").is_file():
        cargo = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))
        members = cargo.get("workspace", {}).get("members", [])
        check_argv = (
            ("tests", ["cargo", "test", "--workspace"]),
            ("lint", ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]),
        )
        checks = [
            CheckDefinition(id=check_id, argv=argv, timeout_seconds=900)
            for check_id, argv in check_argv
        ]
        if members:
            questions.append("Confirmer les frontières des crates Cargo et les chemins partagés.")
        paths = [path for path in ("src", "crates", "tests") if (root / path).exists()] or ["."]
        surfaces.append(
            Surface(
                id="rust",
                label="Rust",
                paths=paths,
                role_profile="backend",
                check_ids=["tests", "lint"],
            )
        )
    elif (root / "go.mod").is_file():
        checks = [
            CheckDefinition(id="tests", argv=["go", "test", "./..."], timeout_seconds=900),
            CheckDefinition(id="lint", argv=["go", "vet", "./..."], timeout_seconds=900),
        ]
        surfaces.append(
            Surface(
                id="go",
                label="Go",
                paths=["."],
                role_profile="backend",
                check_ids=["tests", "lint"],
            )
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
        description=_project_description(root),
        language=language,
        metadata_mode=MetadataMode.LOCAL,
        vcs=VcsConfig(host=host, default_branch=default_branch),
        surfaces=surfaces,
        checks=checks,
        contract=_detect_contract(root, surfaces),
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
        brainstorm_panel=["product", "architecture", "ux", "qa", "security"]
        if any(surface.role_profile == "frontend" for surface in surfaces)
        else ["product", "architecture", "qa", "security"],
        integrations=integrations,
    )
    signals = _discovery_signals(root)
    if signals["conventions"]:
        questions.append(
            "Confirmer les règles à importer depuis les fichiers de conventions détectés."
        )
    if signals["design"] and not any("design system" in item for item in questions):
        questions.append("Confirmer la source de design et son périmètre avant activation.")
    if signals["retrieval"]:
        questions.append("Confirmer le serveur MCP de retrieval à utiliser et son accès.")
    if signals["isolation"]:
        questions.append("Confirmer le mode d'exécution local ou conteneur et ses dépendances.")
    return profile, questions


def profile_provenance(root: Path) -> dict[str, Any]:
    names = ["pyproject.toml", "package.json", "pnpm-workspace.yaml", ".github/workflows"]
    return {name: (root / name).exists() for name in names}


def discovery_report(profile: ProjectProfile, questions: list[str], root: Path) -> dict[str, Any]:
    """Explain what was detected and what still needs a human decision."""
    checks = {check.id: check for check in profile.checks}
    signals = _discovery_signals(root.resolve(strict=True))
    return {
        "description": profile.description,
        "surfaces": [
            {
                "id": surface.id,
                "paths": surface.paths,
                "role_profile": surface.role_profile,
                "depends_on": surface.depends_on,
                "checks": [
                    {"id": check_id, "argv": checks[check_id].argv}
                    for check_id in surface.check_ids
                ],
                "design_detected": surface.uses_design,
                "confidence": "detected",
            }
            for surface in profile.surfaces
        ],
        "contract": profile.contract.model_dump(mode="json"),
        "release_notes": profile.integrations.release_notes,
        "brainstorm_panel": profile.brainstorm_panel,
        "vcs": profile.vcs.model_dump(mode="json"),
        "questions": questions,
        "signals": signals,
        "convention_candidates": _convention_candidates(
            root.resolve(strict=True), signals["conventions"]
        ),
    }


def reconcile_profile(current: ProjectProfile, detected: ProjectProfile) -> ProjectProfile:
    """Add newly detected ownership without replacing user-configured project choices."""
    checks = {check.id: check for check in current.checks}
    for check in detected.checks:
        previous_check = checks.get(check.id)
        if previous_check is None:
            checks[check.id] = check
        elif (
            check.argv[:3] == ["uv", "run", "--all-extras"]
            and previous_check.argv == ["uv", "run", *check.argv[3:]]
        ) or (
            check.argv[:4] == ["uv", "run", "--extra", "dev"]
            and previous_check.argv == ["uv", "run", *check.argv[4:]]
        ):
            # Upgrade the old generated command while preserving edited check metadata.
            checks[check.id] = previous_check.model_copy(update={"argv": check.argv})
    surfaces = {surface.id: surface for surface in current.surfaces}
    owned = [path for surface in current.surfaces for path in surface.paths]
    for surface in detected.surfaces:
        if surface.id in surfaces:
            previous = surfaces[surface.id]
            if previous.check_ids and set(previous.check_ids) <= {
                "tests",
                "lint",
                "types",
                "format",
            }:
                surfaces[surface.id] = previous.model_copy(
                    update={"check_ids": surface.check_ids or previous.check_ids}
                )
            continue
        if any(
            path == "."
            or existing == "."
            or path == existing
            or path.startswith(existing + "/")
            or existing.startswith(path + "/")
            for path in surface.paths
            for existing in owned
        ):
            continue
        surfaces[surface.id] = surface
        owned.extend(surface.paths)
    contract = current.contract if current.contract.enabled else detected.contract
    panel = (
        detected.brainstorm_panel
        if current.brainstorm_panel == ["product", "architecture", "qa"]
        else current.brainstorm_panel
    )
    integrations = current.integrations
    if not integrations.release_notes.get("enabled"):
        integrations = integrations.model_copy(
            update={"release_notes": detected.integrations.release_notes}
        )
    return ProjectProfile.model_validate_json(
        current.model_copy(
            update={
                "revision": current.revision + 1,
                "description": current.description or detected.description,
                "surfaces": list(surfaces.values()),
                "checks": list(checks.values()),
                "contract": contract,
                "brainstorm_panel": panel,
                "integrations": integrations,
            }
        ).model_dump_json()
    )
