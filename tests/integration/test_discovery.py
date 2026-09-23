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
    assert profile.checks[0].argv == ["npm", "test"]


def test_discovers_javascript_workspace_and_questions_shared_ownership(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"private":true}\n')
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
    for package in ("api", "web"):
        directory = tmp_path / "packages" / package
        directory.mkdir(parents=True)
        (directory / "package.json").write_text('{"name":"demo"}\n')

    profile, questions = discover_project(tmp_path)

    assert [surface.paths for surface in profile.surfaces] == [
        ["packages/api"],
        ["packages/web"],
    ]
    assert profile.checks[0].argv == ["pnpm", "test"]
    assert questions == ["Confirmer l'ownership des fichiers partagés et du lockfile."]


def test_unknown_stack_returns_a_question_instead_of_inventing_commands(tmp_path: Path) -> None:
    profile, questions = discover_project(tmp_path)

    assert profile.checks == []
    assert profile.surfaces[0].paths == ["."]
    assert questions == ["Aucun manifest reconnu : définir les commandes de test et de lint."]
