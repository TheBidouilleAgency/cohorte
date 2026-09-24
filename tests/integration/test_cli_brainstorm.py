from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from cohorte.application.preparation import BrainstormRunner
from cohorte.application.service import CohorteService
from cohorte.cli.main import run
from cohorte.persistence.sqlite import Database


def test_brainstorm_accepts_profile_saved_by_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    (repository / "pyproject.toml").write_text('[project]\nname = "sample"\nversion = "0.1.0"\n')
    source = repository / "src"
    source.mkdir()
    (source / "welcome.py").write_text("def welcome_user():\n    return 'Sample idea'\n")
    data_dir = tmp_path / "data"
    database = Database(data_dir / "cohorte.sqlite3")
    project_id = CohorteService(database).init_project(repository)["profile"]["project_id"]
    database.close()

    def reached_runner(*args: object, **_kwargs: object) -> None:
        assert "src/welcome.py:1" in str(args[4])
        assert "def welcome_user" in str(args[4])
        raise RuntimeError("brainstorm-runner-reached")

    monkeypatch.setattr(BrainstormRunner, "run", reached_runner)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "cohorte",
            "--json",
            "--data-dir",
            str(data_dir),
            "brainstorm",
            str(project_id),
            "--feature-id",
            "sample-feature",
            "--idea",
            "Sample idea",
            "--answer",
            "Keep the scope small",
            "--repo",
            str(repository),
            "--live",
        ],
    )

    with pytest.raises(SystemExit):
        run()
    output = json.loads(capsys.readouterr().out)
    assert output["error"]["message"] == "brainstorm-runner-reached"
