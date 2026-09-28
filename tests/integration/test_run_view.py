from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from cohorte.cli.main import run
from cohorte.cli.run_view import RunProgress, print_result
from cohorte.domain.models import RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database


def _saved_run(tmp_path: Path, monkeypatch, capsys) -> tuple[Path, str]:
    project = tmp_path / "project"
    project.mkdir()
    data_dir = tmp_path / "data"
    assert run(["--json", "--data-dir", str(data_dir), "init", str(project)]) == 0
    project_id = json.loads(capsys.readouterr().out)["data"]["profile"]["project_id"]
    database = Database(data_dir / "cohorte.sqlite3")
    try:
        now = datetime.now(UTC)
        database.create_run(
            RunState(
                id="example-run",
                project_id=project_id,
                feature_id="example",
                stage=Stage.BUILD,
                status=RunStatus.RUNNING,
                state_version=1,
                base_commit="a" * 40,
                created_at=now,
                updated_at=now,
            )
        )
        database.append_event(
            "agent.turn.started",
            {"provider": "codex", "phase": "build", "prompt": "Bearer private-value"},
            project_id=project_id,
            run_id="example-run",
        )
        database.append_event(
            "phase.build.completed",
            {"candidate_tree_hash": "hash"},
            project_id=project_id,
            run_id="example-run",
        )
    finally:
        database.close()
    monkeypatch.chdir(project)
    return data_dir, project_id


def test_runs_and_timeline_are_readable_and_json_is_structured(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    data_dir, project_id = _saved_run(tmp_path, monkeypatch, capsys)
    before = (data_dir / "cohorte.sqlite3").stat().st_size

    assert run(["--data-dir", str(data_dir), "runs"]) == 0
    listing = capsys.readouterr().out
    assert "example-run · Construction · en cours" in listing
    assert "cohorte run show example-run" in listing

    assert run(["--data-dir", str(data_dir), "run", "show", "example-run"]) == 0
    detail = capsys.readouterr().out
    assert "Déroulement :" in detail
    assert "codex démarre · build" in detail
    assert "Construction terminée" in detail
    assert "private-value" not in detail

    assert run(["--json", "--data-dir", str(data_dir), "runs"]) == 0
    listing_json = json.loads(capsys.readouterr().out)
    assert listing_json["data"]["project_id"] == project_id
    assert [item["id"] for item in listing_json["data"]["runs"]] == ["example-run"]

    assert run(["--json", "--data-dir", str(data_dir), "run", "show", "example-run"]) == 0
    detail_json = json.loads(capsys.readouterr().out)
    assert detail_json["data"]["run"]["id"] == "example-run"
    assert len(detail_json["data"]["events"]) == 3
    assert "private-value" not in json.dumps(detail_json)
    assert (data_dir / "cohorte.sqlite3").stat().st_size == before


def test_progress_reports_journal_events_and_human_result(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    data_dir, _ = _saved_run(tmp_path, monkeypatch, capsys)
    progress = RunProgress(data_dir / "cohorte.sqlite3", "example-run", enabled=True)
    progress._last_visible = 0
    progress._read_once()
    output = capsys.readouterr().err
    assert "Run créé" in output
    assert "codex démarre · build" in output
    assert "Construction terminée" in output
    assert "private-value" not in output

    progress._last_visible = 0
    progress._read_once()
    assert "Toujours en cours · Construction" in capsys.readouterr().err

    print_result(
        {
            "run_id": "example-run",
            "changed_files": ["src/a.py"],
            "checks": [{"check_id": "tests", "status": "passed"}],
            "review": {"verdict": "ready"},
            "worktree": "/tmp/example",
            "ship_request_id": "request-1",
        }
    )
    result = capsys.readouterr().out
    assert "Check tests · réussi" in result
    assert "Revue : prête" in result
    assert "Livraison en attente · demande request-1" in result
