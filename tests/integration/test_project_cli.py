from __future__ import annotations

import builtins
import sys
from pathlib import Path

from cohorte.application.service import CohorteService
from cohorte.cli import main as cli
from cohorte.persistence.sqlite import Database


def test_guided_intake_and_project_status(tmp_path: Path, monkeypatch, capsys) -> None:
    project = tmp_path / "project"
    project.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()
    monkeypatch.chdir(project)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    answers = iter(["texte", "Ajouter un export sécurisé"])
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert cli.run(["--data-dir", str(data), "intake"]) == 0
    result = capsys.readouterr().out
    assert "Suite suggérée : cohorte brainstorm" in result

    assert cli.run(["--data-dir", str(data), "status"]) == 0
    dashboard = capsys.readouterr().out
    assert "Projet project · 1 fonctionnalités" in dashboard
    assert "intake-" in dashboard


def test_intake_json_requires_explicit_source(tmp_path: Path, monkeypatch, capsys) -> None:
    project = tmp_path / "project"
    project.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()
    monkeypatch.chdir(project)

    try:
        cli.run(["--json", "--data-dir", str(data), "intake"])
    except SystemExit as error:
        assert error.code == 3
    else:
        raise AssertionError("missing source should fail without prompting")
    assert "--text, --file or --url" in capsys.readouterr().out
