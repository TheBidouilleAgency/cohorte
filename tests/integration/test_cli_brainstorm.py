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


@pytest.mark.parametrize("json_mode", [False, True])
def test_invalid_feature_id_argument_fails_without_prompt_or_brief(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    json_mode: bool,
) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    data_dir = tmp_path / "data"
    database = Database(data_dir / "cohorte.sqlite3")
    project_id = CohorteService(database).init_project(repository)["profile"]["project_id"]
    database.close()
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)

    def unexpected(*_args: object, **_kwargs: object) -> None:
        pytest.fail("invalid feature id reached a prompt or the panel")

    monkeypatch.setattr("builtins.input", unexpected)
    monkeypatch.setattr(BrainstormRunner, "run", unexpected)
    argv = ["--data-dir", str(data_dir)]
    if json_mode:
        argv.insert(0, "--json")
    argv += [
        "brainstorm",
        str(project_id),
        "--feature-id",
        "INVALID_ID",
        "--idea",
        "An idea",
        "--repo",
        str(repository),
        "--live",
    ]
    with pytest.raises(SystemExit) as error:
        run(argv)
    assert error.value.code != 0
    output = capsys.readouterr()
    if json_mode:
        result = json.loads(output.out)
        assert result["ok"] is False
        assert result["error"]["code"] == "VALIDATION_ERROR"
        assert "1 à 80 caractères" in result["error"]["message"]
        assert result["error"]["impact"] == "la commande n'a pas été exécutée"
        assert result["error"]["remediation"] == "corrigez l'identifiant et réessayez"
    else:
        assert "VALIDATION_ERROR" in output.err
        assert "1 à 80 caractères" in output.err
        assert "Effet: la commande n'a pas été exécutée" in output.err
        assert "À faire: corrigez l'identifiant et réessayez" in output.err
        assert "Impact:" not in output.err
        assert "Action:" not in output.err
    stored = Database(data_dir / "cohorte.sqlite3")
    assert stored.list_features(project_id) == []
    stored.close()
