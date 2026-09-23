from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from cohorte.adapters.events import AgentEvents
from cohorte.application.durable import SqliteAgentEventSink, SqliteRunJournal
from cohorte.application.metrics import metrics_report
from cohorte.application.service import CohorteService
from cohorte.domain.models import RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database
from cohorte.protocol.rpc import RpcServer


def _call(server: RpcServer, identifier: str, method: str, params: dict) -> dict:
    request = {"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}
    return json.loads(server.handle_line(json.dumps(request).encode()))


def test_both_provider_events_replay_and_group_without_content(tmp_path) -> None:  # type: ignore[no-untyped-def]
    database = Database(tmp_path / "state.sqlite3")
    try:
        database.register_project("project", str(tmp_path), "profile")
        now = datetime.now(UTC)
        database.create_run(
            RunState(
                id="run",
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
        journal = SqliteRunJournal(database, "run")

        def emit(provider: str) -> None:
            events = AgentEvents(journal.agent_event, provider, "build", False)  # type: ignore[arg-type]
            events.started()
            events.usage(input_tokens=10, output_tokens=2)
            events.finished("native-session")

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(emit, provider) for provider in ("codex", "claude")]
            for future in futures:
                future.result()

        server = RpcServer(CohorteService(database))
        _call(
            server,
            "init",
            "initialize",
            {
                "protocol_major": 1,
                "protocol_minor": 0,
                "client": {"name": "test", "version": "1"},
                "capabilities": ["events.replay"],
            },
        )
        replay = _call(server, "events", "events.subscribe", {"run_id": "run", "after_seq": 0})[
            "result"
        ]["items"]
        usage = [event for event in replay if event["type"] == "agent.usage"]
        assert {event["data"]["provider"] for event in usage} == {"claude", "codex"}
        assert {event["data"]["input_tokens"] for event in usage} == {10}
        assert all(event["run_id"] == "run" for event in usage)
        assert all("prompt" not in event["data"] for event in replay)
        assert all("response" not in event["data"] for event in replay)

        SqliteAgentEventSink(database.path, "project")(
            "agent.turn.started",
            {"provider": "claude", "phase": "brainstorm_perspective", "access": "read_only"},
        )
        project_replay = _call(
            server,
            "project-events",
            "events.subscribe",
            {"project_id": "project", "after_seq": replay[-1]["seq"]},
        )["result"]["items"]
        assert len(project_replay) == 1
        assert project_replay[0]["run_id"] is None
        assert project_replay[0]["data"]["phase"] == "brainstorm_perspective"

        report = metrics_report(
            database,
            project_id="project",
            since=now - timedelta(minutes=1),
            until=now + timedelta(minutes=1),
            group_by="provider",
        )
        assert {group.key for group in report.groups} == {"claude", "codex"}
    finally:
        database.close()
