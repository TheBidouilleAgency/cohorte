import json
import sys
from pathlib import Path

from cohorte.application.discovery import discover_project, discovery_report, reconcile_profile
from cohorte.application.service import CohorteService
from cohorte.cli import main as cli
from cohorte.persistence.sqlite import Database


def test_discovers_python_project(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n[tool.ruff]\n")
    (tmp_path / "README.md").write_text(
        "# Demo\n\nA service for processing requests from customers.\n"
    )
    (tmp_path / "uv.lock").write_text("version = 1\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "tests").mkdir()

    profile, questions = discover_project(tmp_path)

    assert questions == []
    assert profile.description == "A service for processing requests from customers."
    assert [(surface.id, surface.paths) for surface in profile.surfaces] == [
        ("python", ["src", "tests"])
    ]
    assert [check.argv for check in profile.checks] == [
        ["uv", "run", "pytest", "-q"],
        ["uv", "run", "ruff", "check", "."],
    ]


def test_python_project_without_uv_does_not_invent_uv_commands(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n[tool.ruff]\n")
    (tmp_path / "tests").mkdir()
    profile, _ = discover_project(tmp_path)
    assert profile.checks[0].argv == ["python", "-m", "pytest", "-q"]


def test_init_surfaces_convention_design_retrieval_and_isolation_signals(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (tmp_path / "src").mkdir()
    (tmp_path / "AGENTS.md").write_text("# Project rules\n")
    (tmp_path / "design-reference").mkdir()
    (tmp_path / "Dockerfile").write_text("FROM node:22\n")
    (tmp_path / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"serena": {"command": "run"}, "other": {}}})
    )

    profile, questions = discover_project(tmp_path)
    analysis = discovery_report(profile, questions, tmp_path)
    assert analysis["signals"] == {
        "conventions": ["AGENTS.md"],
        "design": ["design-reference"],
        "retrieval": [".mcp.json:serena"],
        "isolation": ["Dockerfile"],
    }
    assert len(questions) == 4
    assert profile.integrations.retrieval.provider == "none"
    assert profile.execution.mode == "local"


def test_discovers_simple_typescript_project(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"test":"node --test"}}\n')
    (tmp_path / "src").mkdir()

    profile, questions = discover_project(tmp_path)

    assert questions == []
    assert profile.surfaces[0].paths == ["src"]
    assert profile.checks[0].argv == ["npm", "run", "test"]


def test_discovers_javascript_workspace_and_questions_shared_ownership(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"private":true}\n')
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
    for package in ("api", "web"):
        directory = tmp_path / "packages" / package
        directory.mkdir(parents=True)
        (directory / "package.json").write_text('{"name":"demo"}\n')

    profile, questions = discover_project(tmp_path)

    assert [surface.paths for surface in profile.surfaces[:2]] == [
        ["packages/api"],
        ["packages/web"],
    ]
    assert profile.surfaces[2].paths == ["package.json", "pnpm-lock.yaml"]
    assert profile.checks == []
    assert any("noms de packages dupliqués" in question for question in questions)


def test_discovers_nested_pnpm_packages_dependencies_and_root_checks(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "scripts": {
                    "test": "turbo test",
                    "lint": "turbo lint",
                    "check-types": "turbo check-types",
                    "format:check": "prettier --check .",
                },
            }
        )
    )
    (tmp_path / "pnpm-workspace.yaml").write_text(
        "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - 'packages/modules/*'\n"
    )
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
    manifests = {
        "apps/api": {"name": "@demo/api", "dependencies": {"@demo/domain": "workspace:*"}},
        "packages/shared-types": {"name": "@demo/shared-types"},
        "packages/modules/domain": {
            "name": "@demo/domain",
            "dependencies": {"@demo/shared-types": "workspace:*"},
        },
    }
    for relative, manifest in manifests.items():
        directory = tmp_path / relative
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(json.dumps(manifest))
    profile, questions = discover_project(tmp_path)

    surfaces = {surface.id: surface for surface in profile.surfaces}
    assert set(surfaces) == {"api", "shared-types", "domain", "workspace"}
    assert surfaces["api"].depends_on == ["domain"]
    assert surfaces["domain"].depends_on == ["shared-types"]
    assert [check.id for check in profile.checks] == ["tests", "lint", "types", "format"]
    assert surfaces["workspace"].paths == ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]
    assert any("contrat" in question for question in questions)


def test_unknown_stack_returns_a_question_instead_of_inventing_commands(tmp_path: Path) -> None:
    profile, questions = discover_project(tmp_path)

    assert profile.checks == []
    assert profile.surfaces[0].paths == ["."]
    assert questions == ["Aucun manifest reconnu : définir les commandes de test et de lint."]


def test_monorepo_uses_surface_checks_contract_and_product_panel(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"test":"turbo run test"}}')
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - 'apps/*'\n  - 'packages/*'\n")
    (tmp_path / ".changeset").mkdir()
    (tmp_path / ".changeset/config.json").write_text("{}")
    for path, manifest in {
        "apps/api": {
            "name": "api",
            "scripts": {"test": "node ace test", "lint": "eslint ."},
            "dependencies": {"@adonisjs/core": "1"},
        },
        "apps/web": {
            "name": "web",
            "scripts": {"test": "vitest run", "check-types": "tsc -b"},
            "dependencies": {"react": "1", "shared-types": "workspace:*"},
        },
        "packages/shared-types": {"name": "shared-types", "scripts": {"test": "vitest run"}},
    }.items():
        target = tmp_path / path
        target.mkdir(parents=True)
        (target / "package.json").write_text(json.dumps(manifest))
    (tmp_path / "apps/web/design-reference").mkdir()

    profile, _questions = discover_project(tmp_path)
    surfaces = {surface.id: surface for surface in profile.surfaces}
    checks = {check.id: check for check in profile.checks}
    assert surfaces["api"].role_profile == "backend"
    assert surfaces["api"].check_ids == ["api-tests", "api-lint"]
    assert checks["api-tests"].argv == ["pnpm", "--filter", "./apps/api", "test"]
    assert surfaces["web"].role_profile == "frontend"
    assert surfaces["web"].depends_on == ["shared-types"]
    assert surfaces["web"].uses_design is True
    assert profile.contract.paths == ["packages/shared-types"]
    assert profile.integrations.release_notes["enabled"] is True
    assert profile.brainstorm_panel == ["product", "architecture", "ux", "qa", "security"]


def test_hybrid_node_tauri_detects_root_frontend_rust_and_contract(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"test": "vitest run"}, "dependencies": {"react": "1"}})
    )
    for path in ("src", "src-tauri", "contract"):
        (tmp_path / path).mkdir()
    (tmp_path / "src-tauri/Cargo.toml").write_text("[package]\nname='app'\nversion='0.1.0'\n")

    profile, _questions = discover_project(tmp_path)
    surfaces = {surface.id: surface for surface in profile.surfaces}
    assert (
        next(surface for surface in profile.surfaces if surface.paths == ["src"]).role_profile
        == "frontend"
    )
    assert surfaces["rust"].paths == ["src-tauri"]
    assert surfaces["rust"].check_ids == ["rust-tests", "rust-lint"]
    assert surfaces["contract"].role_profile == "contract"
    assert profile.contract.paths == ["contract"]


def test_refresh_adds_detected_surface_without_erasing_custom_panel(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (tmp_path / "src").mkdir()
    current, _ = discover_project(tmp_path)
    current = current.model_copy(
        update={"brainstorm_panel": ["product", "architecture", "security"]}
    )
    (tmp_path / "src-tauri").mkdir()
    (tmp_path / "src-tauri/Cargo.toml").write_text("[package]\nname='app'\n")
    detected, _ = discover_project(tmp_path)

    refreshed = reconcile_profile(current, detected)
    assert refreshed.revision == current.revision + 1
    assert refreshed.brainstorm_panel == ["product", "architecture", "security"]
    assert any(surface.id == "rust" for surface in refreshed.surfaces)


def test_registered_profile_refresh_preserves_custom_choices(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (project / "src").mkdir()
    database = Database(tmp_path / "state.sqlite3")
    service = CohorteService(database)
    initial = service.init_project(project)
    document = initial["profile"]
    document["brainstorm_panel"] = ["product", "architecture", "security"]
    service.save_project_profile("project", document, initial["profile_ref"]["revision"])
    (project / "src-tauri").mkdir()
    (project / "src-tauri/Cargo.toml").write_text("[package]\nname='app'\n")

    refreshed = service.init_project(project, refresh=True)
    assert refreshed["profile"]["brainstorm_panel"] == ["product", "architecture", "security"]
    assert any(surface["id"] == "rust" for surface in refreshed["profile"]["surfaces"])
    assert refreshed["analysis"]["contract"]["enabled"] is False
    database.close()


def test_init_preview_is_read_only_and_interactive_init_requires_confirmation(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    data = tmp_path / "data"
    assert cli.run(["--json", "--data-dir", str(data), "init", str(project), "--preview"]) == 0
    preview = json.loads(capsys.readouterr().out)["data"]
    assert preview["preview"] is True
    database = Database(data / "cohorte.sqlite3")
    assert database.list_projects() == []
    database.close()

    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _prompt: "n")
    assert cli.run(["--data-dir", str(data), "init", str(project)]) == 0
    assert "Profil non enregistré" in capsys.readouterr().out
    monkeypatch.setattr("builtins.input", lambda _prompt: "o")
    assert cli.run(["--data-dir", str(data), "init", str(project)]) == 0
    database = Database(data / "cohorte.sqlite3")
    assert len(database.list_projects()) == 1
    database.close()


def test_interactive_init_persists_accepted_retrieval_choice(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (project / ".mcp.json").write_text('{"mcpServers":{"serena":{"command":"run"}}}')
    answers = iter(["serena", "o"])
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _prompt: next(answers))
    data = tmp_path / "data"
    assert cli.run(["--data-dir", str(data), "init", str(project)]) == 0
    assert "Retrieval détecté" in capsys.readouterr().out
    database = Database(data / "cohorte.sqlite3")
    stored = database.get_project("project")["profile"]
    assert stored["integrations"]["retrieval"]["provider"] == "serena"
    assert stored["integrations"]["retrieval"]["fallback_to_files"] is True
    database.close()


def test_init_profile_file_registers_explicit_structured_choices(tmp_path: Path, capsys) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    detected, _ = discover_project(project)
    document = detected.model_dump(mode="json")
    document["brainstorm_panel"] = ["product", "architecture", "qa", "security"]
    chosen = tmp_path / "profile.json"
    chosen.write_text(json.dumps(document))
    data = tmp_path / "data"
    assert cli.run(
        ["--json", "--data-dir", str(data), "init", str(project), "--profile-file", str(chosen)]
    ) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["data"]["profile"]["brainstorm_panel"] == document["brainstorm_panel"]
