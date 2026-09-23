import json
from pathlib import Path

from cohorte.application.discovery import discover_project


def test_discovers_python_project(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "tests").mkdir()

    profile, questions = discover_project(tmp_path)

    assert questions == []
    assert [(surface.id, surface.paths) for surface in profile.surfaces] == [
        ("python", ["src", "tests"])
    ]
    assert [check.argv for check in profile.checks] == [
        ["uv", "run", "pytest", "-q"],
        ["uv", "run", "ruff", "check", "."],
    ]


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
