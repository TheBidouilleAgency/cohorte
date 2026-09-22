from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest

from cohorte.application.durable import RunStopped, SqliteRunJournal
from cohorte.application.service import CohorteService
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database


@pytest.fixture
def database(tmp_path):
    db = Database(tmp_path / "state.sqlite3")
    yield db
    db.close()


def test_artifacts_are_content_addressed_and_verified(database: Database) -> None:
    first = database.put_artifact("spec", b'{"ok":true}')
    second = database.put_artifact("spec", b'{"ok":true}')
    assert first == second
    assert database.get_artifact(first["id"], first["revision"])["content"] == '{"ok":true}'


def test_optimistic_run_update_rejects_stale_writer(database: Database) -> None:
    database.register_project("project", "/tmp/project", "profile")
    now = datetime.now(UTC)
    state = RunState(
        id="run",
        project_id="project",
        feature_id="feature",
        stage=Stage.PLAN,
        status=RunStatus.QUEUED,
        state_version=1,
        base_commit="a" * 40,
        created_at=now,
        updated_at=now,
    )
    database.create_run(state)
    updated = state.model_copy(update={"state_version": 2, "status": RunStatus.RUNNING})
    database.update_run(updated, 1, "run.state_changed", {})
    with pytest.raises(CohorteError) as caught:
        database.update_run(
            updated.model_copy(update={"state_version": 3}), 1, "run.state_changed", {}
        )
    assert caught.value.code == ErrorCode.VERSION_CONFLICT


def test_request_response_is_fifo_and_idempotent(database: Database) -> None:
    subject = "a" * 64
    request_id = database.create_request(None, "approval", {"action": "ship"}, subject)
    result = database.respond_request(request_id, "response-1", {"approved": True}, subject)
    assert database.respond_request(request_id, "response-1", {"approved": True}, subject) == result
    with pytest.raises(CohorteError) as caught:
        database.respond_request(request_id, "response-2", {"approved": False}, subject)
    assert caught.value.code == ErrorCode.REQUEST_ALREADY_RESOLVED


def test_operation_deduplication_rejects_changed_content(database: Database) -> None:
    assert database.deduplicated("op", {"x": 1}, lambda: {"value": 1}) == {"value": 1}
    assert database.deduplicated("op", {"x": 1}, lambda: {"value": 2}) == {"value": 1}
    with pytest.raises(CohorteError):
        database.deduplicated("op", {"x": 2}, lambda: {"value": 2})


def test_project_and_feature_registration_are_idempotent(database: Database) -> None:
    database.ensure_project("project", "/tmp/project", "profile-1")
    database.ensure_project("project", "/tmp/project", "profile-2")
    database.ensure_feature("feature", "project", "Feature")
    database.ensure_feature("feature", "project", "Feature")

    with pytest.raises(ValueError, match="another path"):
        database.ensure_project("project", "/tmp/other", "profile-3")


def test_phase_checkpoint_preserves_pause_and_advances_resume_stage(database: Database) -> None:
    database.register_project("project", "/tmp/project", "profile")
    now = datetime.now(UTC)
    state = RunState(
        id="paused-run",
        project_id="project",
        feature_id="feature",
        stage=Stage.BUILD,
        status=RunStatus.PAUSED,
        state_version=1,
        base_commit="a" * 40,
        created_at=now,
        updated_at=now,
    )
    database.create_run(state)

    with pytest.raises(RunStopped, match="paused"):
        SqliteRunJournal(database, "paused-run")(
            "build", {"candidate_tree_hash": "b" * 64, "base_commit": "a" * 40}
        )

    checkpoint = database.get_run("paused-run")
    assert checkpoint.status == RunStatus.PAUSED
    assert checkpoint.stage == Stage.CHECKS


def test_run_journal_observes_control_from_another_database_connection(
    database: Database, tmp_path
) -> None:  # type: ignore[no-untyped-def]
    database.register_project("project", str(tmp_path), "profile")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="active-run",
            project_id="project",
            feature_id="feature",
            stage=Stage.BUILD,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit="a" * 40,
            created_at=now,
            updated_at=now,
        )
    )
    journal = SqliteRunJournal(database, "active-run")
    assert journal.stop_requested() is None

    controller = Database(tmp_path / "state.sqlite3")
    try:
        CohorteService(controller).pause("active-run")
        assert journal.stop_requested() == RunStatus.PAUSED
        with ThreadPoolExecutor(max_workers=1) as executor:
            assert executor.submit(journal.stop_requested).result() == RunStatus.PAUSED
    finally:
        controller.close()


def test_task_lease_generation_rejects_stale_worker(database: Database) -> None:
    database.register_project("project", "/tmp/project", "profile")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="lease-run",
            project_id="project",
            feature_id="feature",
            stage=Stage.BUILD,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit="a" * 40,
            created_at=now,
            updated_at=now,
        )
    )
    database.prepare_task("lease-run", "task", {"task": {"id": "task"}})
    first = database.start_task_attempt("lease-run", "task", 1, {"ordinal": 1})
    with pytest.raises(CohorteError) as active:
        database.start_task_attempt("lease-run", "task", 2, {"ordinal": 2})
    assert active.value.code == ErrorCode.WORKER_NOT_STOPPED
    database.connection.execute(
        "UPDATE leases SET expires_at=?",
        ((now.replace(year=now.year - 1)).isoformat(),),
    )
    database.expire_stale_task_leases(now)
    second = database.start_task_attempt("lease-run", "task", 2, {"ordinal": 2})

    with pytest.raises(CohorteError) as caught:
        database.complete_task_attempt(
            "lease-run",
            "task",
            str(first["attempt_id"]),
            int(first["generation"]),
            {"commit": "first"},
        )

    assert caught.value.code == ErrorCode.VERSION_CONFLICT
    database.complete_task_attempt(
        "lease-run",
        "task",
        str(second["attempt_id"]),
        int(second["generation"]),
        {"commit": "second"},
    )
    assert database.task_records("lease-run")[0]["status"] == "completed"
    assert database.connection.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


def test_expired_task_lease_requeues_task(database: Database) -> None:
    database.register_project("project", "/tmp/project", "profile")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="expired-run",
            project_id="project",
            feature_id="feature",
            stage=Stage.BUILD,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit="a" * 40,
            created_at=now,
            updated_at=now,
        )
    )
    database.prepare_task("expired-run", "task", {"task": {"id": "task"}})
    database.start_task_attempt("expired-run", "task", 1, {"ordinal": 1})
    database.connection.execute(
        "UPDATE leases SET expires_at=?", ((now.replace(year=now.year - 1)).isoformat(),)
    )

    assert database.expire_stale_task_leases(now) == 1
    assert database.task_records("expired-run")[0]["status"] == "queued"
    assert database.connection.execute("SELECT status FROM attempts").fetchone()[0] == "abandoned"
    assert database.connection.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


def test_run_export_is_complete_bounded_and_redacted_at_rest(database: Database) -> None:
    secret = "sk-fake-database-secret"
    database.register_project("project", "/tmp/project", "profile")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="export-run",
            project_id="project",
            feature_id="feature",
            stage=Stage.BUILD,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit="a" * 40,
            created_at=now,
            updated_at=now,
        )
    )
    database.append_event(
        "agent.output",
        {"OPENAI_API_KEY": secret, "message": f"token={secret}"},
        run_id="export-run",
    )
    database.create_request("export-run", "approval", {"client_secret": secret}, "b" * 64)

    stored_events = "".join(
        str(row[0]) for row in database.connection.execute("SELECT data_json FROM events")
    )
    stored_requests = "".join(
        str(row[0]) for row in database.connection.execute("SELECT payload_json FROM requests")
    )
    exported = database.export_run("export-run")
    encoded = json.dumps(exported)

    assert secret not in stored_events
    assert secret not in stored_requests
    assert secret not in encoded
    assert "[REDACTED]" in encoded
    assert exported["run"]["state"]["id"] == "export-run"
    assert "state_json" not in exported["run"]
    assert exported["events"]
    assert exported["requests"]

    database.append_event("large.output", {"output": "x" * 2048}, run_id="export-run")
    with pytest.raises(CohorteError) as caught:
        database.export_run("export-run", max_bytes=1024)
    assert caught.value.code == ErrorCode.OUTPUT_INVALID
    assert database.get_run("export-run").status == RunStatus.RUNNING
