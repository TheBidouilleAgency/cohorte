from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import RunStatus, Stage, Task
from cohorte.persistence.sqlite import Database


class RunStopped(Exception):
    pass


_AUTH_ERRORS = {
    ErrorCode.AUTH_REQUIRED,
    ErrorCode.AUTH_MODE_MISMATCH,
    ErrorCode.AUTH_MODE_UNVERIFIED,
}


def record_run_error(database: Database, run_id: str, error: Exception) -> None:
    current = database.get_run(run_id)
    code = error.code if isinstance(error, CohorteError) else None
    if code in _AUTH_ERRORS:
        status, event_type = RunStatus.WAITING_AUTH, "run.waiting_auth"
    elif code == ErrorCode.QUOTA_EXHAUSTED:
        status, event_type = RunStatus.WAITING_QUOTA, "run.waiting_quota"
    elif code == ErrorCode.PROVIDER_UNAVAILABLE:
        status, event_type = RunStatus.PAUSED, "run.suspended"
    elif code == ErrorCode.EFFECT_UNCERTAIN:
        status, event_type = RunStatus.BLOCKED_UNCERTAIN, "run.effect_uncertain"
    elif code == ErrorCode.WORKER_NOT_STOPPED:
        status, event_type = RunStatus.BLOCKED, "run.blocked"
    else:
        status, event_type = RunStatus.FAILED, "run.failed"
    updated = current.model_copy(
        update={
            "status": status,
            "state_version": current.state_version + 1,
            "updated_at": datetime.now(UTC),
        }
    )
    data = error.as_data() if isinstance(error, CohorteError) else {"message": str(error)}
    database.update_run(
        updated,
        current.state_version,
        event_type,
        data,
    )


@dataclass(frozen=True, slots=True)
class TaskAttemptHandle:
    task_id: str
    attempt_id: str
    ordinal: int
    generation: int


class SqliteTaskJournal:
    """Fence task attempts and retain enough Git state for crash recovery."""

    def __init__(self, database: Database, run_id: str) -> None:
        self.database = database
        self.run_id = run_id

    def prepare(self, tasks: list[Task]) -> None:
        self.database.expire_stale_task_leases()
        for task in tasks:
            self.database.prepare_task(
                self.run_id,
                task.id,
                {"task": task.model_dump(mode="json")},
            )

    def require_dispatch_allowed(self) -> None:
        status = self.database.get_run(self.run_id).status
        if status in {RunStatus.PAUSED, RunStatus.CANCELLED}:
            raise RunStopped(status.value)

    def records(self) -> dict[str, dict[str, Any]]:
        return {
            str(row["payload"].get("task", {}).get("id", str(row["id"]).split(":", 1)[-1])): row
            for row in self.database.task_records(self.run_id)
        }

    def next_ordinal(self, task_id: str) -> int:
        return self.database.next_attempt_ordinal(self.run_id, task_id)

    def start(
        self,
        task: Task,
        ordinal: int,
        base_commit: str,
        branch: str,
        worktree: str,
    ) -> TaskAttemptHandle:
        payload = {
            "task": task.model_dump(mode="json"),
            "ordinal": ordinal,
            "base_commit": base_commit,
            "branch": branch,
            "worktree": worktree,
        }
        stored = self.database.start_task_attempt(self.run_id, task.id, ordinal, payload)
        return TaskAttemptHandle(
            task_id=task.id,
            attempt_id=str(stored["attempt_id"]),
            ordinal=int(stored["ordinal"]),
            generation=int(stored["generation"]),
        )

    def complete(
        self,
        handle: TaskAttemptHandle,
        task: Task,
        base_commit: str,
        branch: str,
        worktree: str,
        commit: str,
        changed_files: list[str],
    ) -> None:
        self.database.complete_task_attempt(
            self.run_id,
            task.id,
            handle.attempt_id,
            handle.generation,
            {
                "task": task.model_dump(mode="json"),
                "attempt_id": handle.attempt_id,
                "ordinal": handle.ordinal,
                "generation": handle.generation,
                "base_commit": base_commit,
                "branch": branch,
                "worktree": worktree,
                "commit": commit,
                "changed_files": changed_files,
            },
        )

    def integrated(self, task_id: str, integration_commit: str) -> None:
        self.database.mark_task_integrated(self.run_id, task_id, integration_commit)


class SqliteRunJournal:
    """Persist completed phase boundaries with optimistic run-state updates."""

    def __init__(self, database: Database, run_id: str) -> None:
        self.database = database
        self.run_id = run_id

    def stop_requested(self) -> RunStatus | None:
        # Worker surfaces may run in threads. A short-lived read-only
        # connection also sees pause/cancel transitions from other processes.
        connection = sqlite3.connect(f"{self.database.path.resolve().as_uri()}?mode=ro", uri=True)
        try:
            row = connection.execute(
                "SELECT state_json FROM runs WHERE id = ?", (self.run_id,)
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise KeyError(self.run_id)
        status = RunStatus(json.loads(row[0])["status"])
        return status if status in {RunStatus.PAUSED, RunStatus.CANCELLED} else None

    def __call__(self, phase: str, data: dict[str, Any]) -> None:
        current = self.database.get_run(self.run_id)
        requested_stop = (
            current.status if current.status in {RunStatus.PAUSED, RunStatus.CANCELLED} else None
        )
        stage = current.stage
        status = requested_stop or RunStatus.RUNNING
        fix_cycles = current.fix_cycles
        if phase == "build":
            stage = Stage.CHECKS
        elif phase == "checks":
            stage = Stage.REVIEW
        elif phase == "review":
            if data.get("ready") is True:
                stage = Stage.SHIP
                if requested_stop is None:
                    status = RunStatus.WAITING_USER
            else:
                stage = Stage.FIX
        elif phase == "fix":
            stage = Stage.CHECKS
            fix_cycles = max(fix_cycles + 1, int(data.get("fix_cycles", 0)))
        else:
            raise ValueError(f"unknown durable phase: {phase}")
        updated = current.model_copy(
            update={
                "stage": stage,
                "status": status,
                "state_version": current.state_version + 1,
                "candidate_tree_hash": data["candidate_tree_hash"],
                "fix_cycles": fix_cycles,
                "updated_at": datetime.now(UTC),
            }
        )
        self.database.update_run(
            updated,
            current.state_version,
            f"phase.{phase}.completed",
            data,
        )
        if requested_stop is not None:
            raise RunStopped(requested_stop.value)
