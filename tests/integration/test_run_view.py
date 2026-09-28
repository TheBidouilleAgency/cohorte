from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cohorte.cli.main import run
from cohorte.cli.run_view import RunProgress, print_result, print_run
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


def test_completed_run_shows_last_recorded_ci_and_refresh_command(capsys) -> None:
    now = datetime.now(UTC)
    state = RunState(
        id="example-run",
        project_id="example",
        feature_id="example",
        stage=Stage.DONE,
        status=RunStatus.COMPLETED,
        state_version=1,
        base_commit="a" * 40,
        created_at=now,
        updated_at=now,
    )
    events = [
        {
            "type": "delivery.confirmed",
            "data": {"status": "ci_unknown"},
            "occurred_at": now.isoformat(),
        },
        {
            "type": "delivery.status",
            "data": {"status": "ci_pending"},
            "occurred_at": now.isoformat(),
        },
    ]

    print_run(state, events)

    output = capsys.readouterr().out
    assert "CI (dernier état enregistré) : en cours" in output
    assert "cohorte delivery-status example-run --live --watch" in output


def test_runs_status_filters_before_limit_and_preserves_project_and_order(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    data_dir, project_id = _saved_run(tmp_path, monkeypatch, capsys)
    other_project = tmp_path / "other-project"
    other_project.mkdir()
    assert run(["--json", "--data-dir", str(data_dir), "init", str(other_project)]) == 0
    other_id = json.loads(capsys.readouterr().out)["data"]["profile"]["project_id"]
    database = Database(data_dir / "cohorte.sqlite3")
    try:
        now = datetime.now(UTC)
        for run_id, owner, status, created_at in (
            ("waiting-old", project_id, RunStatus.WAITING_USER, now - timedelta(days=3)),
            ("waiting-new", project_id, RunStatus.WAITING_USER, now - timedelta(days=1)),
            ("newest-running", project_id, RunStatus.RUNNING, now + timedelta(days=1)),
            ("blocked-run", project_id, RunStatus.BLOCKED_UNCERTAIN, now - timedelta(days=2)),
            ("other-waiting", other_id, RunStatus.WAITING_USER, now + timedelta(days=2)),
        ):
            database.create_run(
                RunState(
                    id=run_id,
                    project_id=owner,
                    feature_id="example",
                    stage=Stage.BUILD,
                    status=status,
                    state_version=1,
                    base_commit="a" * 40,
                    created_at=created_at,
                    updated_at=created_at,
                )
            )
    finally:
        database.close()

    assert (
        run(["--data-dir", str(data_dir), "runs", "--status", "waiting_user", "--limit", "1"]) == 0
    )
    listing = capsys.readouterr().out
    assert "waiting-new · Construction · en attente de votre décision" in listing
    assert "waiting-old" not in listing
    assert "other-waiting" not in listing

    assert run(["--json", "--data-dir", str(data_dir), "runs", "--status", "waiting_user"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["data"]["project_id"] == project_id
    assert [item["id"] for item in payload["data"]["runs"]] == [
        "waiting-new",
        "waiting-old",
    ]
    assert run(["--data-dir", str(data_dir), "runs", "--status", "waiting_user"]) == 0
    listing = capsys.readouterr().out
    assert listing.index("waiting-new") < listing.index("waiting-old")
    assert "other-waiting" not in listing

    assert run(["--json", "--data-dir", str(data_dir), "runs", "--limit", "1"]) == 0
    unfiltered = json.loads(capsys.readouterr().out)
    assert [item["id"] for item in unfiltered["data"]["runs"]] == ["newest-running"]

    assert run(["--data-dir", str(data_dir), "runs", "--status", "blocked_uncertain"]) == 0
    assert "blocked-run · Construction · bloqué, effet incertain" in capsys.readouterr().out
    assert (
        run(["--json", "--data-dir", str(data_dir), "runs", "--status", "blocked_uncertain"]) == 0
    )
    assert [item["id"] for item in json.loads(capsys.readouterr().out)["data"]["runs"]] == [
        "blocked-run"
    ]

    assert run(["--data-dir", str(data_dir), "runs", "--status", "paused"]) == 0
    assert "0 affiché(s)" in capsys.readouterr().out
    assert run(["--json", "--data-dir", str(data_dir), "runs", "--status", "paused"]) == 0
    assert json.loads(capsys.readouterr().out)["data"]["runs"] == []


def test_runs_without_status_keeps_default_limit_of_twenty(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    data_dir, project_id = _saved_run(tmp_path, monkeypatch, capsys)
    database = Database(data_dir / "cohorte.sqlite3")
    try:
        now = datetime.now(UTC)
        for index in range(21):
            created_at = now + timedelta(minutes=index + 1)
            database.create_run(
                RunState(
                    id=f"run-{index:02}",
                    project_id=project_id,
                    feature_id="example",
                    stage=Stage.BUILD,
                    status=RunStatus.RUNNING,
                    state_version=1,
                    base_commit="a" * 40,
                    created_at=created_at,
                    updated_at=created_at,
                )
            )
    finally:
        database.close()

    assert run(["--json", "--data-dir", str(data_dir), "runs"]) == 0
    selected = json.loads(capsys.readouterr().out)["data"]["runs"]
    assert len(selected) == 20
    assert selected[0]["id"] == "run-20"
    assert selected[-1]["id"] == "run-01"


def test_runs_status_rejects_unknown_value_in_text_and_json(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    data_dir, _ = _saved_run(tmp_path, monkeypatch, capsys)
    for prefix in ([], ["--json"]):
        try:
            run([*prefix, "--data-dir", str(data_dir), "runs", "--status", "WAITING_USER"])
        except SystemExit as error:
            assert error.code != 0
        else:
            raise AssertionError("invalid status was accepted")
        output = capsys.readouterr()
        if prefix:
            payload = json.loads(output.out)
            assert payload["ok"] is False
            assert payload["error"]["code"] == "VALIDATION_ERROR"
            assert "WAITING_USER" in payload["error"]["message"]
        else:
            assert "WAITING_USER" in output.err
            assert "État de run inconnu" in output.err


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
