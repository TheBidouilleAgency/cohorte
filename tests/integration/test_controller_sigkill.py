from __future__ import annotations

import json
import multiprocessing
import os
import signal
import subprocess
import sys
import time
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path

import pytest

from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database


def _controller_with_live_worker(database_path: str, ready_path: str) -> None:
    marker = f"cohorte-live-worker-{os.getpid()}"
    worker = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)", marker],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    database = Database(Path(database_path))
    try:
        attempt = database.start_task_attempt(
            "crash-run",
            "task",
            1,
            {"ordinal": 1, "worker_pid": worker.pid, "worker_marker": marker},
        )
        Path(ready_path).write_text(json.dumps({**attempt, "worker_pid": worker.pid}))
        time.sleep(60)
    finally:
        database.close()
        with suppress(ProcessLookupError):
            os.kill(worker.pid, signal.SIGKILL)


def _process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.skipif(os.name == "nt", reason="POSIX SIGKILL test")
def test_sigkill_controller_never_allows_a_second_writer_while_worker_lives(tmp_path) -> None:
    path = tmp_path / "state.sqlite3"
    database = Database(path)
    database.register_project("project", str(tmp_path), "profile")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="crash-run",
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
    database.prepare_task("crash-run", "task", {"task": {"id": "task"}})
    database.close()

    ready = tmp_path / "ready.json"
    context = multiprocessing.get_context("spawn")
    controller = context.Process(target=_controller_with_live_worker, args=(str(path), str(ready)))
    controller.start()
    worker_pid: int | None = None
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            assert controller.is_alive(), f"controller exited with {controller.exitcode}"
            time.sleep(0.02)
        assert ready.exists(), "controller did not start the live worker"
        worker_pid = int(json.loads(ready.read_text())["worker_pid"])
        assert _process_is_alive(worker_pid)

        concurrent = Database(path)
        with pytest.raises(CohorteError) as active:
            concurrent.start_task_attempt("crash-run", "task", 2, {"ordinal": 2})
        assert active.value.code == ErrorCode.WORKER_NOT_STOPPED
        concurrent.close()

        os.kill(controller.pid, signal.SIGKILL)
        controller.join(timeout=5)
        assert controller.exitcode == -signal.SIGKILL
        assert _process_is_alive(worker_pid)

        recovered = Database(path)
        with pytest.raises(CohorteError) as orphaned:
            recovered.start_task_attempt("crash-run", "task", 2, {"ordinal": 2})
        assert orphaned.value.code == ErrorCode.WORKER_NOT_STOPPED

        os.kill(worker_pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while _process_is_alive(worker_pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        recovered.connection.execute(
            "UPDATE leases SET expires_at=?", ((now.replace(year=now.year - 1)).isoformat(),)
        )
        assert recovered.expire_stale_task_leases(now) == 1
        second = recovered.start_task_attempt("crash-run", "task", 2, {"ordinal": 2})
        assert second["generation"] == 2
        assert recovered.task_records("crash-run")[0]["status"] == "running"
        recovered.close()
    finally:
        if controller.is_alive():
            controller.kill()
            controller.join(timeout=5)
        if worker_pid is not None:
            with suppress(ProcessLookupError):
                os.kill(worker_pid, signal.SIGKILL)
