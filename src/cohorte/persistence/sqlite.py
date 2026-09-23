from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import RunState
from cohorte.domain.redaction import redact

SCHEMA_VERSION = 2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, profile_artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(project_id, revision)
);
CREATE TABLE IF NOT EXISTS features(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts(
  id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL, content BLOB NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(id, revision), UNIQUE(sha256, kind)
);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), feature_id TEXT NOT NULL,
  state_json TEXT NOT NULL, state_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload_json TEXT NOT NULL,
  status TEXT NOT NULL, lease_generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attempts(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL,
  status TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(task_id, ordinal)
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), provider TEXT NOT NULL,
  native_ref TEXT, status TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL,
  project_id TEXT, run_id TEXT, task_id TEXT, attempt_id TEXT, type TEXT NOT NULL,
  occurred_at TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests(
  id TEXT PRIMARY KEY, run_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  subject_hash TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
  expires_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals(
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), client_identity TEXT NOT NULL,
  actor TEXT NOT NULL, answer_json TEXT NOT NULL, subject_hash TEXT NOT NULL, scope_json TEXT NOT NULL,
  policy_ref TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS findings(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checks(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), status TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS effects(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, external_id TEXT, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leases(
  resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, generation INTEGER NOT NULL,
  owner_id TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(resource_type, resource_id)
);
CREATE TABLE IF NOT EXISTS projections(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL, state_version INTEGER NOT NULL,
  status TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(kind, subject_id)
);
CREATE TABLE IF NOT EXISTS operations(
  request_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports(
  id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL, backup_path TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS requests_run_status ON requests(run_id, status);
"""


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        try:
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.execute("PRAGMA busy_timeout=5000")
            self._migrate()
            self.connection.execute("PRAGMA journal_mode=WAL")
        except Exception:
            self.connection.close()
            raise

    def close(self) -> None:
        self.connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield self.connection
        except Exception:
            self.connection.rollback()
            raise
        else:
            self.connection.commit()

    def _migrate(self) -> None:
        current = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if current > SCHEMA_VERSION:
            raise CohorteError(
                ErrorCode.RUNTIME_INCOMPATIBLE,
                "database schema is newer than this Cohorte version",
                "state cannot be opened safely",
                remediation="upgrade Cohorte",
            )
        if current == 0:
            with self.transaction() as tx:
                tx.executescript(_SCHEMA)
                tx.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                    (SCHEMA_VERSION, utc_now()),
                )
                tx.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        elif current == 1:
            backup = self.path.with_name(
                f"{self.path.name}.pre-v2-{datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ')}.bak"
            )
            destination = sqlite3.connect(backup)
            try:
                self.connection.backup(destination)
            finally:
                destination.close()
            self.connection.execute("BEGIN EXCLUSIVE")
            try:
                self.connection.execute(
                    "CREATE TABLE imports("
                    "id TEXT PRIMARY KEY,source_kind TEXT NOT NULL,source_hash TEXT NOT NULL,"
                    "payload_json TEXT NOT NULL,backup_path TEXT NOT NULL,created_at TEXT NOT NULL)"
                )
                self.connection.execute(
                    "INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)",
                    (SCHEMA_VERSION, utc_now()),
                )
                self.connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            except Exception:
                self.connection.rollback()
                raise
            else:
                self.connection.commit()

    def health(self) -> dict[str, Any]:
        result = self.connection.execute("PRAGMA integrity_check").fetchone()[0]
        return {"ok": result == "ok", "integrity": result, "schema_version": SCHEMA_VERSION}

    def backup(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        target = sqlite3.connect(destination)
        try:
            self.connection.backup(target)
            integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError(f"backup integrity check failed: {integrity}")
        finally:
            target.close()

    def apply_import(
        self,
        import_id: str,
        source_hash: str,
        backup_path: str,
        files: list[tuple[str, str, bytes]],
    ) -> list[dict[str, Any]]:
        refs: list[dict[str, Any]] = []
        with self.transaction() as tx:
            if tx.execute("SELECT 1 FROM imports WHERE id=?", (import_id,)).fetchone():
                raise ValueError(f"migration import already applied: {import_id}")
            for relative_path, kind, content in files:
                if len(content) > 2 * 1024 * 1024:
                    raise ValueError(f"migration file exceeds 2 MiB: {relative_path}")
                digest = hashlib.sha256(content).hexdigest()
                existing = tx.execute(
                    "SELECT id,revision,sha256 FROM artifacts WHERE sha256=? AND kind=?",
                    (digest, kind),
                ).fetchone()
                if existing is not None:
                    refs.append(dict(existing))
                    continue
                artifact_id = str(uuid4())
                tx.execute(
                    "INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)",
                    (
                        artifact_id,
                        1,
                        kind,
                        digest,
                        "application/octet-stream",
                        content,
                        len(content),
                        utc_now(),
                    ),
                )
                refs.append({"id": artifact_id, "revision": 1, "sha256": digest})
            tx.execute(
                "INSERT INTO imports VALUES (?,?,?,?,?,?)",
                (
                    import_id,
                    "cohorte-v2",
                    source_hash,
                    json.dumps(
                        {
                            "files": [{"path": path, "kind": kind} for path, kind, _ in files],
                            "artifact_refs": refs,
                            "active_runs_imported": False,
                        },
                        sort_keys=True,
                    ),
                    backup_path,
                    utc_now(),
                ),
            )
        return refs

    def put_artifact(
        self,
        kind: str,
        content: bytes,
        media_type: str = "application/json",
        artifact_id: str | None = None,
    ) -> dict[str, Any]:
        if len(content) > 2 * 1024 * 1024:
            raise ValueError("artifact exceeds 2 MiB")
        digest = hashlib.sha256(content).hexdigest()
        existing = self.connection.execute(
            "SELECT id, revision, sha256 FROM artifacts WHERE sha256=? AND kind=?", (digest, kind)
        ).fetchone()
        if existing:
            return dict(existing)
        artifact_id = artifact_id or str(uuid4())
        row = self.connection.execute(
            "SELECT COALESCE(MAX(revision), 0) FROM artifacts WHERE id=?", (artifact_id,)
        ).fetchone()
        revision = int(row[0]) + 1
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (artifact_id, revision, kind, digest, media_type, content, len(content), utc_now()),
            )
        return {"id": artifact_id, "revision": revision, "sha256": digest}

    def get_artifact(
        self, artifact_id: str, revision: int, offset: int = 0, limit: int = 65536
    ) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM artifacts WHERE id=? AND revision=?", (artifact_id, revision)
        ).fetchone()
        if row is None:
            raise KeyError(artifact_id)
        content = bytes(row["content"])
        if hashlib.sha256(content).hexdigest() != row["sha256"]:
            raise CohorteError(
                ErrorCode.ARTIFACT_CORRUPT,
                "artifact hash does not match content",
                "artifact cannot be trusted",
                remediation="restore the data directory from backup",
            )
        return {
            "id": row["id"],
            "revision": row["revision"],
            "sha256": row["sha256"],
            "media_type": row["media_type"],
            "size": row["size"],
            "content": content[offset : offset + limit].decode("utf-8"),
            "offset": offset,
            "next_offset": min(offset + limit, len(content)),
        }

    def register_project(self, project_id: str, root_path: str, profile_artifact_id: str) -> None:
        now = utc_now()
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO projects VALUES (?, ?, ?, ?, ?)",
                (project_id, root_path, profile_artifact_id, now, now),
            )

    def ensure_project(self, project_id: str, root_path: str, profile_artifact_id: str) -> None:
        row = self.connection.execute(
            "SELECT root_path FROM projects WHERE id=?", (project_id,)
        ).fetchone()
        if row is not None:
            if row["root_path"] != root_path:
                raise ValueError(f"project {project_id} is already registered at another path")
            with self.transaction() as tx:
                tx.execute(
                    "UPDATE projects SET profile_artifact_id=?, updated_at=? WHERE id=?",
                    (profile_artifact_id, utc_now(), project_id),
                )
            return
        self.register_project(project_id, root_path, profile_artifact_id)

    def create_feature(
        self, feature_id: str, project_id: str, title: str, kind: str = "feature"
    ) -> None:
        now = utc_now()
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO features VALUES (?, ?, ?, ?, 'draft', ?, ?)",
                (feature_id, project_id, title, kind, now, now),
            )

    def ensure_feature(
        self, feature_id: str, project_id: str, title: str, kind: str = "feature"
    ) -> None:
        row = self.connection.execute(
            "SELECT project_id FROM features WHERE id=?", (feature_id,)
        ).fetchone()
        if row is not None:
            if row["project_id"] != project_id:
                raise ValueError(f"feature {feature_id} belongs to another project")
            return
        self.create_feature(feature_id, project_id, title, kind)

    def set_feature_status(self, feature_id: str, status: str) -> None:
        with self.transaction() as tx:
            updated = tx.execute(
                "UPDATE features SET status=?,updated_at=? WHERE id=?",
                (status, utc_now(), feature_id),
            ).rowcount
        if updated != 1:
            raise KeyError(feature_id)

    def list_projects(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT id,root_path,profile_artifact_id,created_at,updated_at "
            "FROM projects ORDER BY created_at,id"
        ).fetchall()
        return [dict(row) for row in rows]

    def get_project(self, project_id: str) -> dict[str, Any]:
        row = self.connection.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            raise KeyError(project_id)
        project = dict(row)
        artifact = self.connection.execute(
            "SELECT revision,content,sha256 FROM artifacts WHERE id=? ORDER BY revision DESC LIMIT 1",
            (row["profile_artifact_id"],),
        ).fetchone()
        if artifact is not None:
            project["profile"] = json.loads(bytes(artifact["content"]))
            project["profile_ref"] = {
                "id": row["profile_artifact_id"],
                "revision": artifact["revision"],
                "sha256": artifact["sha256"],
            }
        return project

    def update_project_profile(
        self, project_id: str, content: bytes, expected_revision: int
    ) -> dict[str, Any]:
        if len(content) > 2 * 1024 * 1024:
            raise ValueError("artifact exceeds 2 MiB")
        digest = hashlib.sha256(content).hexdigest()
        with self.transaction() as tx:
            project = tx.execute(
                "SELECT profile_artifact_id FROM projects WHERE id=?", (project_id,)
            ).fetchone()
            if project is None:
                raise KeyError(project_id)
            artifact_id = project["profile_artifact_id"]
            latest = tx.execute(
                "SELECT revision, sha256 FROM artifacts WHERE id=? ORDER BY revision DESC LIMIT 1",
                (artifact_id,),
            ).fetchone()
            if latest is None or latest["revision"] != expected_revision:
                raise ValueError("profile revision changed; reload the profile before editing")
            if latest["sha256"] == digest:
                return {"id": artifact_id, "revision": expected_revision, "sha256": digest}
            revision = expected_revision + 1
            tx.execute(
                "INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    artifact_id,
                    revision,
                    "project-profile",
                    digest,
                    "application/json",
                    content,
                    len(content),
                    utc_now(),
                ),
            )
            tx.execute("UPDATE projects SET updated_at=? WHERE id=?", (utc_now(), project_id))
        return {"id": artifact_id, "revision": revision, "sha256": digest}

    def list_features(self, project_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM features WHERE project_id=? ORDER BY created_at,id", (project_id,)
        ).fetchall()
        return [dict(row) for row in rows]

    def get_feature(self, feature_id: str) -> dict[str, Any]:
        row = self.connection.execute("SELECT * FROM features WHERE id=?", (feature_id,)).fetchone()
        if row is None:
            raise KeyError(feature_id)
        return dict(row)

    def list_requests(
        self, run_id: str | None = None, status: str | None = None
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        parameters: list[str] = []
        if run_id is not None:
            clauses.append("run_id=?")
            parameters.append(run_id)
        if status is not None:
            clauses.append("status=?")
            parameters.append(status)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.connection.execute(
            f"SELECT * FROM requests{where} ORDER BY created_at,id", parameters
        ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["payload"] = json.loads(item.pop("payload_json"))
            result.append(item)
        return result

    def create_run(self, state: RunState) -> None:
        payload = state.model_dump_json()
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    state.id,
                    state.project_id,
                    state.feature_id,
                    payload,
                    state.state_version,
                    state.created_at.isoformat(),
                    state.updated_at.isoformat(),
                ),
            )
            self._append_event_tx(
                tx, state.project_id, state.id, "run.created", state.model_dump(mode="json")
            )

    def get_run(self, run_id: str) -> RunState:
        row = self.connection.execute(
            "SELECT state_json FROM runs WHERE id=?", (run_id,)
        ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return RunState.model_validate_json(row[0])

    def list_runs(self, project_id: str | None = None) -> list[RunState]:
        if project_id:
            rows = self.connection.execute(
                "SELECT state_json FROM runs WHERE project_id=? ORDER BY created_at DESC",
                (project_id,),
            ).fetchall()
        else:
            rows = self.connection.execute(
                "SELECT state_json FROM runs ORDER BY created_at DESC"
            ).fetchall()
        return [RunState.model_validate_json(row[0]) for row in rows]

    def metrics_source(
        self, project_id: str | None, since: datetime, until: datetime
    ) -> dict[str, Any]:
        clauses = ["created_at>=?", "created_at<=?"]
        parameters: list[Any] = [since.isoformat(), until.isoformat()]
        if project_id is not None:
            clauses.append("project_id=?")
            parameters.append(project_id)
        where = " AND ".join(clauses)
        runs = self.connection.execute(
            f"SELECT id,state_json FROM runs WHERE {where} ORDER BY created_at",
            parameters,
        ).fetchall()
        run_ids = [row["id"] for row in runs]
        if not run_ids:
            return {
                "runs": [],
                "approvals": 0,
                "approvals_by_run": {},
                "usage_events": [],
                "phase_events": [],
            }
        placeholders = ",".join("?" for _ in run_ids)
        approval_rows = self.connection.execute(
            f"SELECT r.run_id,COUNT(*) AS count FROM approvals a "
            f"JOIN requests r ON r.id=a.request_id "
            f"WHERE r.run_id IN ({placeholders}) AND a.created_at>=? AND a.created_at<=? "
            f"GROUP BY r.run_id",
            [*run_ids, since.isoformat(), until.isoformat()],
        ).fetchall()
        approvals_by_run = {str(row["run_id"]): int(row["count"]) for row in approval_rows}
        usage = self.connection.execute(
            f"SELECT run_id,occurred_at,data_json FROM events WHERE type='agent.usage' "
            f"AND run_id IN ({placeholders}) AND occurred_at>=? AND occurred_at<=? ORDER BY seq",
            [*run_ids, since.isoformat(), until.isoformat()],
        ).fetchall()
        phases = self.connection.execute(
            f"SELECT run_id,type,occurred_at,data_json FROM events "
            f"WHERE type LIKE 'phase.%.completed' "
            f"AND run_id IN ({placeholders}) AND occurred_at>=? AND occurred_at<=? ORDER BY seq",
            [*run_ids, since.isoformat(), until.isoformat()],
        ).fetchall()
        return {
            "runs": [json.loads(row["state_json"]) for row in runs],
            "approvals": sum(approvals_by_run.values()),
            "approvals_by_run": approvals_by_run,
            "usage_events": [
                {
                    **json.loads(row["data_json"]),
                    "run_id": row["run_id"],
                    "occurred_at": row["occurred_at"],
                }
                for row in usage
            ],
            "phase_events": [
                {
                    **json.loads(row["data_json"]),
                    "run_id": row["run_id"],
                    "event_type": row["type"],
                    "occurred_at": row["occurred_at"],
                }
                for row in phases
            ],
        }

    def record_projection(
        self,
        kind: str,
        subject_id: str,
        state_version: int,
        status: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        projection_id = f"{kind}:{subject_id}"
        encoded = json.dumps(payload, sort_keys=True)
        with self.transaction() as tx:
            current = tx.execute(
                "SELECT state_version,payload_json FROM projections WHERE id=?",
                (projection_id,),
            ).fetchone()
            if current is not None:
                current_version = int(current["state_version"])
                if state_version < current_version:
                    raise CohorteError(
                        ErrorCode.VERSION_CONFLICT,
                        "projection state is older than the stored projection",
                        "stale projection was rejected",
                        remediation="refresh the feature state before projecting",
                    )
                if state_version == current_version and current["payload_json"] == encoded:
                    return {
                        "id": projection_id,
                        "state_version": state_version,
                        "status": status,
                        "unchanged": True,
                    }
            tx.execute(
                "INSERT INTO projections(id,kind,subject_id,state_version,status,payload_json) "
                "VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "state_version=excluded.state_version,status=excluded.status,"
                "payload_json=excluded.payload_json",
                (projection_id, kind, subject_id, state_version, status, encoded),
            )
        return {
            "id": projection_id,
            "state_version": state_version,
            "status": status,
            "unchanged": False,
        }

    def update_run(
        self, state: RunState, expected_version: int, event_type: str, data: dict[str, Any]
    ) -> None:
        with self.transaction() as tx:
            result = tx.execute(
                "UPDATE runs SET state_json=?, state_version=?, updated_at=? WHERE id=? AND state_version=?",
                (
                    state.model_dump_json(),
                    state.state_version,
                    state.updated_at.isoformat(),
                    state.id,
                    expected_version,
                ),
            )
            if result.rowcount != 1:
                raise CohorteError(
                    ErrorCode.VERSION_CONFLICT,
                    "run changed since it was read",
                    "requested transition was not applied",
                    retryable=True,
                    remediation="refresh the run and retry the action",
                )
            self._append_event_tx(tx, state.project_id, state.id, event_type, data)

    @staticmethod
    def _task_key(run_id: str, task_id: str) -> str:
        return f"{run_id}:{task_id}"

    def prepare_task(self, run_id: str, task_id: str, payload: dict[str, Any]) -> None:
        key = self._task_key(run_id, task_id)
        with self.transaction() as tx:
            tx.execute(
                "INSERT OR IGNORE INTO tasks(id,run_id,payload_json,status,lease_generation) "
                "VALUES (?,?,?,'queued',0)",
                (key, run_id, json.dumps(payload, sort_keys=True)),
            )

    def task_records(self, run_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM tasks WHERE run_id=? ORDER BY id", (run_id,)
        ).fetchall()
        return [{**dict(row), "payload": json.loads(row["payload_json"])} for row in rows]

    def expire_stale_task_leases(self, now: datetime | None = None) -> int:
        cutoff = (now or datetime.now(UTC)).isoformat()
        with self.transaction() as tx:
            rows = tx.execute(
                "SELECT resource_id,generation FROM leases "
                "WHERE resource_type='task' AND expires_at<=?",
                (cutoff,),
            ).fetchall()
            for row in rows:
                key = str(row["resource_id"])
                generation = int(row["generation"])
                tx.execute(
                    "UPDATE attempts SET status='abandoned' WHERE task_id=? AND status='running'",
                    (key,),
                )
                tx.execute(
                    "UPDATE tasks SET status='queued' "
                    "WHERE id=? AND status='running' AND lease_generation=?",
                    (key, generation),
                )
                tx.execute(
                    "DELETE FROM leases WHERE resource_type='task' "
                    "AND resource_id=? AND generation=?",
                    (key, generation),
                )
        return len(rows)

    def next_attempt_ordinal(self, run_id: str, task_id: str) -> int:
        key = self._task_key(run_id, task_id)
        row = self.connection.execute(
            "SELECT COALESCE(MAX(ordinal),0)+1 FROM attempts WHERE task_id=?", (key,)
        ).fetchone()
        return int(row[0])

    def start_task_attempt(
        self,
        run_id: str,
        task_id: str,
        ordinal: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        key = self._task_key(run_id, task_id)
        attempt_id = f"{key}:{ordinal}"
        expires_at = datetime.now(UTC).timestamp() + 1800
        expires = datetime.fromtimestamp(expires_at, UTC).isoformat()
        with self.transaction() as tx:
            current = tx.execute(
                "SELECT generation,owner_id,expires_at FROM leases "
                "WHERE resource_type='task' AND resource_id=?",
                (key,),
            ).fetchone()
            if current is not None and datetime.fromisoformat(current["expires_at"]) > datetime.now(
                UTC
            ):
                raise CohorteError(
                    ErrorCode.WORKER_NOT_STOPPED,
                    f"task {task_id} still has an active worker lease",
                    "a concurrent attempt was not started",
                    retryable=True,
                    remediation="wait for confirmed worker termination or lease expiry",
                    details={"owner_id": current["owner_id"], "expires_at": current["expires_at"]},
                )
            if current is not None:
                tx.execute(
                    "UPDATE attempts SET status='abandoned' WHERE task_id=? AND status='running'",
                    (key,),
                )
                tx.execute(
                    "DELETE FROM leases WHERE resource_type='task' AND resource_id=?",
                    (key,),
                )
            task_row = tx.execute(
                "SELECT lease_generation FROM tasks WHERE id=?", (key,)
            ).fetchone()
            if task_row is None:
                raise KeyError(key)
            generation = int(task_row["lease_generation"]) + 1
            tx.execute(
                "INSERT INTO leases(resource_type,resource_id,generation,owner_id,expires_at) "
                "VALUES ('task',?,?,?,?) ON CONFLICT(resource_type,resource_id) DO UPDATE SET "
                "generation=excluded.generation,owner_id=excluded.owner_id,expires_at=excluded.expires_at",
                (key, generation, attempt_id, expires),
            )
            tx.execute(
                "UPDATE attempts SET status='abandoned' WHERE task_id=? AND status='running'",
                (key,),
            )
            tx.execute(
                "INSERT INTO attempts(id,task_id,ordinal,status,payload_json) VALUES (?,?,?,'running',?)",
                (attempt_id, key, ordinal, json.dumps(payload, sort_keys=True)),
            )
            result = tx.execute(
                "UPDATE tasks SET status='running',lease_generation=?,payload_json=? WHERE id=?",
                (generation, json.dumps(payload, sort_keys=True), key),
            )
            if result.rowcount != 1:
                raise KeyError(key)
        self.append_event(
            "task.attempt.started",
            {"task_id": task_id, "attempt_id": attempt_id, "generation": generation, **payload},
            run_id=run_id,
        )
        return {"attempt_id": attempt_id, "generation": generation, "ordinal": ordinal}

    def complete_task_attempt(
        self,
        run_id: str,
        task_id: str,
        attempt_id: str,
        generation: int,
        payload: dict[str, Any],
    ) -> None:
        key = self._task_key(run_id, task_id)
        with self.transaction() as tx:
            lease = tx.execute(
                "SELECT generation,owner_id FROM leases "
                "WHERE resource_type='task' AND resource_id=?",
                (key,),
            ).fetchone()
            if (
                lease is None
                or int(lease["generation"]) != generation
                or lease["owner_id"] != attempt_id
            ):
                raise CohorteError(
                    ErrorCode.VERSION_CONFLICT,
                    f"stale lease completion for task {task_id}",
                    "the stale worker result was rejected",
                    remediation="refresh task state and retry only if no newer attempt completed",
                )
            result = tx.execute(
                "UPDATE attempts SET status='completed',payload_json=? "
                "WHERE id=? AND status='running'",
                (json.dumps(payload, sort_keys=True), attempt_id),
            )
            if result.rowcount != 1:
                raise CohorteError(
                    ErrorCode.VERSION_CONFLICT,
                    f"attempt {attempt_id} is not current",
                    "duplicate task completion was rejected",
                    remediation="use the stored completed attempt",
                )
            tx.execute(
                "UPDATE tasks SET status='completed',payload_json=? WHERE id=?",
                (json.dumps(payload, sort_keys=True), key),
            )
            tx.execute(
                "DELETE FROM leases WHERE resource_type='task' AND resource_id=? AND generation=?",
                (key, generation),
            )
        self.append_event(
            "task.attempt.completed",
            {"task_id": task_id, "attempt_id": attempt_id, "generation": generation, **payload},
            run_id=run_id,
        )

    def mark_task_integrated(self, run_id: str, task_id: str, integration_commit: str) -> None:
        key = self._task_key(run_id, task_id)
        with self.transaction() as tx:
            row = tx.execute("SELECT payload_json,status FROM tasks WHERE id=?", (key,)).fetchone()
            if row is None:
                raise KeyError(key)
            payload = json.loads(row["payload_json"])
            if row["status"] == "integrated":
                if payload.get("integration_commit") != integration_commit:
                    raise CohorteError(
                        ErrorCode.VERSION_CONFLICT,
                        f"task {task_id} has a different integration commit",
                        "duplicate integration was rejected",
                        remediation="reconcile the candidate branch",
                    )
                return
            if row["status"] != "completed":
                raise CohorteError(
                    ErrorCode.VERSION_CONFLICT,
                    f"task {task_id} is not completed",
                    "integration was rejected",
                    remediation="complete or recover the task attempt first",
                )
            payload["integration_commit"] = integration_commit
            tx.execute(
                "UPDATE tasks SET status='integrated',payload_json=? WHERE id=?",
                (json.dumps(payload, sort_keys=True), key),
            )
        self.append_event(
            "task.integrated",
            {"task_id": task_id, "integration_commit": integration_commit},
            run_id=run_id,
        )

    def _append_event_tx(
        self,
        tx: sqlite3.Connection,
        project_id: str | None,
        run_id: str | None,
        event_type: str,
        data: dict[str, Any],
    ) -> int:
        encoded = json.dumps(redact(data), separators=(",", ":"))
        if len(encoded.encode()) > 512 * 1024:
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                "event payload exceeds 512 KiB",
                "the oversized event was not persisted",
                remediation="store large content as an artifact and reference it from the event",
            )
        cursor = tx.execute(
            "INSERT INTO events(event_id,schema_version,project_id,run_id,type,occurred_at,data_json) "
            "VALUES (?,1,?,?,?,?,?)",
            (
                str(uuid4()),
                project_id,
                run_id,
                event_type,
                utc_now(),
                encoded,
            ),
        )
        if cursor.lastrowid is None:
            raise RuntimeError("SQLite did not return an event sequence")
        return cursor.lastrowid

    def append_event(
        self,
        event_type: str,
        data: dict[str, Any],
        *,
        project_id: str | None = None,
        run_id: str | None = None,
    ) -> int:
        with self.transaction() as tx:
            return self._append_event_tx(tx, project_id, run_id, event_type, data)

    def latest_event(self, run_id: str, event_type: str) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM events WHERE run_id=? AND type=? ORDER BY seq DESC LIMIT 1",
            (run_id, event_type),
        ).fetchone()
        if row is None:
            raise KeyError(f"{run_id}:{event_type}")
        result = dict(row)
        result["data"] = json.loads(result.pop("data_json"))
        return result

    def events_after(
        self,
        after_seq: int = 0,
        run_id: str | None = None,
        limit: int = 1000,
        project_id: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses = ["seq>?"]
        parameters: list[Any] = [after_seq]
        if run_id:
            clauses.append("run_id=?")
            parameters.append(run_id)
        if project_id:
            clauses.append("project_id=?")
            parameters.append(project_id)
        parameters.append(limit)
        rows = self.connection.execute(
            f"SELECT * FROM events WHERE {' AND '.join(clauses)} ORDER BY seq LIMIT ?",
            parameters,
        ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            event = dict(row)
            event["data"] = json.loads(event.pop("data_json"))
            result.append(event)
        return result

    def export_run(self, run_id: str, max_bytes: int = 10 * 1024 * 1024) -> dict[str, Any]:
        if max_bytes < 1024 or max_bytes > 50 * 1024 * 1024:
            raise ValueError("run export limit must be between 1 KiB and 50 MiB")
        run = self.connection.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if run is None:
            raise KeyError(run_id)

        def rows(
            query: str,
            parameters: tuple[Any, ...],
            json_columns: tuple[str, ...] = (),
        ) -> list[dict[str, Any]]:
            result: list[dict[str, Any]] = []
            for row in self.connection.execute(query, parameters).fetchall():
                item = dict(row)
                for column in json_columns:
                    raw = item.pop(column)
                    item[column.removesuffix("_json")] = json.loads(raw)
                result.append(item)
            return result

        request_rows = rows(
            "SELECT * FROM requests WHERE run_id=? ORDER BY created_at,id",
            (run_id,),
            ("payload_json",),
        )
        request_ids = [str(item["id"]) for item in request_rows]
        approvals: list[dict[str, Any]] = []
        if request_ids:
            placeholders = ",".join("?" for _ in request_ids)
            approvals = rows(
                f"SELECT * FROM approvals WHERE request_id IN ({placeholders}) ORDER BY created_at,id",
                tuple(request_ids),
                ("answer_json", "scope_json"),
            )
        run_document = dict(run)
        run_document["state"] = json.loads(run_document.pop("state_json"))
        document = redact(
            {
                "schema_version": 1,
                "database_schema_version": SCHEMA_VERSION,
                "exported_at": utc_now(),
                "run": run_document,
                "events": rows(
                    "SELECT * FROM events WHERE run_id=? ORDER BY seq",
                    (run_id,),
                    ("data_json",),
                ),
                "requests": request_rows,
                "approvals": approvals,
                "tasks": rows(
                    "SELECT * FROM tasks WHERE run_id=? ORDER BY id",
                    (run_id,),
                    ("payload_json",),
                ),
                "attempts": rows(
                    "SELECT attempts.* FROM attempts JOIN tasks ON tasks.id=attempts.task_id "
                    "WHERE tasks.run_id=? ORDER BY attempts.id",
                    (run_id,),
                    ("payload_json",),
                ),
                "sessions": rows(
                    "SELECT sessions.* FROM sessions "
                    "JOIN attempts ON attempts.id=sessions.attempt_id "
                    "JOIN tasks ON tasks.id=attempts.task_id "
                    "WHERE tasks.run_id=? ORDER BY sessions.id",
                    (run_id,),
                    ("payload_json",),
                ),
                "findings": rows(
                    "SELECT * FROM findings WHERE run_id=? ORDER BY id",
                    (run_id,),
                    ("payload_json",),
                ),
                "checks": rows(
                    "SELECT * FROM checks WHERE run_id=? ORDER BY id",
                    (run_id,),
                    ("payload_json",),
                ),
                "effects": rows(
                    "SELECT * FROM effects WHERE run_id=? ORDER BY id",
                    (run_id,),
                    ("payload_json",),
                ),
            }
        )
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
        if len(encoded) > max_bytes:
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                f"run export exceeds the {max_bytes}-byte limit",
                "no export was returned",
                remediation="raise --max-bytes within the allowed bound or export fewer records",
                details={"actual_bytes": len(encoded), "max_bytes": max_bytes},
            )
        return cast(dict[str, Any], document)

    def create_request(
        self,
        run_id: str | None,
        kind: str,
        payload: dict[str, Any],
        subject_hash: str,
        expires_at: str | None = None,
    ) -> str:
        request_id = str(uuid4())
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO requests VALUES (?,?,?,?,?,'pending',1,?,?)",
                (
                    request_id,
                    run_id,
                    kind,
                    json.dumps(redact(payload)),
                    subject_hash,
                    expires_at,
                    utc_now(),
                ),
            )
        return request_id

    def get_request(self, request_id: str) -> dict[str, Any]:
        row = self.connection.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
        if row is None:
            raise KeyError(request_id)
        return {**dict(row), "payload": json.loads(row["payload_json"])}

    def ship_request_for_run(self, run_id: str) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM requests WHERE run_id=? AND kind='ship' ORDER BY created_at DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"ship request for {run_id}")
        return {**dict(row), "payload": json.loads(row["payload_json"])}

    def approval_for_request(self, request_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM approvals WHERE request_id=? ORDER BY created_at LIMIT 1",
            (request_id,),
        ).fetchone()
        if row is None:
            return None
        return {**dict(row), "answer": json.loads(row["answer_json"])}

    def get_approval(self, decision_id: str) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM approvals WHERE id=?", (decision_id,)
        ).fetchone()
        if row is None:
            raise KeyError(decision_id)
        return {**dict(row), "answer": json.loads(row["answer_json"])}

    def respond_request(
        self,
        request_id: str,
        response_id: str,
        response: Any,
        subject_hash: str,
        client_identity: str = "local-cli",
    ) -> dict[str, Any]:
        safe_response = redact(response)
        payload_hash = hashlib.sha256(
            json.dumps(
                {"request_id": request_id, "response": safe_response}, sort_keys=True
            ).encode()
        ).hexdigest()
        previous = self.connection.execute(
            "SELECT content_hash,result_json FROM operations WHERE request_id=?", (response_id,)
        ).fetchone()
        if previous:
            if previous["content_hash"] != payload_hash:
                raise CohorteError(
                    ErrorCode.VERSION_CONFLICT,
                    "response id reused with different content",
                    "new response was rejected",
                    remediation="use a new response_id",
                )
            return cast(dict[str, Any], json.loads(previous["result_json"]))
        decision_id = str(uuid4())
        result = {"decision_id": decision_id, "request_id": request_id, "status": "answered"}
        with self.transaction() as tx:
            row = tx.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if row is None:
                raise KeyError(request_id)
            if row["status"] != "pending" or row["subject_hash"] != subject_hash:
                raise CohorteError(
                    ErrorCode.REQUEST_ALREADY_RESOLVED,
                    "request is resolved or stale",
                    "response was not applied",
                    remediation="refresh pending requests",
                )
            tx.execute(
                "UPDATE requests SET status='answered', revision=revision+1 WHERE id=?",
                (request_id,),
            )
            tx.execute(
                "INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    decision_id,
                    request_id,
                    client_identity,
                    "user",
                    json.dumps(safe_response),
                    subject_hash,
                    json.dumps({}),
                    None,
                    utc_now(),
                ),
            )
            tx.execute(
                "INSERT INTO operations VALUES (?,?,?,?)",
                (response_id, payload_hash, json.dumps(result), utc_now()),
            )
        return result

    def deduplicated(
        self,
        request_id: str,
        params: dict[str, Any],
        operation: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        content_hash = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()
        deadline = time.monotonic() + 5
        while True:
            owner = False
            with self.transaction() as tx:
                row = tx.execute(
                    "SELECT content_hash,result_json FROM operations WHERE request_id=?",
                    (request_id,),
                ).fetchone()
                if row is None:
                    tx.execute(
                        "INSERT INTO operations VALUES (?,?,?,?)",
                        (request_id, content_hash, "null", utc_now()),
                    )
                    owner = True
                elif row["content_hash"] != content_hash:
                    raise CohorteError(
                        ErrorCode.VERSION_CONFLICT,
                        "request id reused with different content",
                        "operation was rejected",
                        remediation="use a new request_id",
                    )
                elif row["result_json"] != "null":
                    return cast(dict[str, Any], json.loads(row["result_json"]))
            if owner:
                try:
                    result = operation()
                except Exception:
                    with self.transaction() as tx:
                        tx.execute(
                            "DELETE FROM operations WHERE request_id=? AND result_json='null'",
                            (request_id,),
                        )
                    raise
                with self.transaction() as tx:
                    tx.execute(
                        "UPDATE operations SET result_json=? WHERE request_id=?",
                        (json.dumps(result), request_id),
                    )
                return result
            if time.monotonic() >= deadline:
                raise CohorteError(
                    ErrorCode.VERSION_CONFLICT,
                    "deduplicated operation is still in progress",
                    "the duplicate request was not executed",
                    retryable=True,
                    remediation="retry with the same request_id",
                )
            time.sleep(0.01)

    def begin_effect(
        self, run_id: str, kind: str, dedupe_key: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM effects WHERE dedupe_key=?", (dedupe_key,)
        ).fetchone()
        if row is not None:
            stored = json.loads(row["payload_json"])
            if stored != payload or row["run_id"] != run_id or row["kind"] != kind:
                raise CohorteError(
                    ErrorCode.VERSION_CONFLICT,
                    "effect key reused with different parameters",
                    "external effect was not executed",
                    remediation="reconcile the existing effect before retrying",
                )
            return {**dict(row), "payload": stored}
        effect_id = str(uuid4())
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO effects VALUES (?,?,?,?,'pending',NULL,?)",
                (effect_id, run_id, kind, dedupe_key, json.dumps(payload, sort_keys=True)),
            )
        return {
            "id": effect_id,
            "run_id": run_id,
            "kind": kind,
            "dedupe_key": dedupe_key,
            "status": "pending",
            "external_id": None,
            "payload": payload,
        }

    def complete_effect(self, effect_id: str, external_id: str) -> None:
        with self.transaction() as tx:
            result = tx.execute(
                "UPDATE effects SET status='completed', external_id=? "
                "WHERE id=? AND status='pending'",
                (external_id, effect_id),
            )
            if result.rowcount != 1:
                row = tx.execute(
                    "SELECT status,external_id FROM effects WHERE id=?", (effect_id,)
                ).fetchone()
                if row is None or row["status"] != "completed" or row["external_id"] != external_id:
                    raise CohorteError(
                        ErrorCode.VERSION_CONFLICT,
                        "effect completion conflicted with stored state",
                        "delivery was stopped",
                        remediation="reconcile the external effect",
                    )
