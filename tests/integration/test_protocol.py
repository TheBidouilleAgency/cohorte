from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from cohorte.application.service import CohorteService
from cohorte.persistence.sqlite import Database
from cohorte.protocol.rpc import MAX_FRAME_BYTES, RpcServer


def call(server: RpcServer, identifier: str, method: str, params: dict | None = None) -> dict:
    frame = json.dumps(
        {"jsonrpc": "2.0", "id": identifier, "method": method, "params": params or {}}
    ).encode()
    return json.loads(server.handle_line(frame))


def test_initialize_is_required(tmp_path) -> None:
    database = Database(tmp_path / "db.sqlite3")
    server = RpcServer(CohorteService(database))
    response = call(server, "1", "health.get")
    assert response["error"]["data"]["code"] == "PROTOCOL_INCOMPATIBLE"
    database.close()


def test_handshake_and_health(tmp_path) -> None:
    database = Database(tmp_path / "db.sqlite3")
    server = RpcServer(CohorteService(database))
    initialized = call(
        server,
        "1",
        "initialize",
        {
            "protocol_major": 1,
            "protocol_minor": 0,
            "client": {"name": "test", "version": "1"},
            "capabilities": [],
        },
    )
    assert initialized["result"]["protocol_major"] == 1
    assert "projects.read" in initialized["result"]["capabilities"]
    assert "metrics.grouped" in initialized["result"]["capabilities"]
    assert call(server, "2", "health.get")["result"]["database"]["ok"] is True
    database.close()


def test_francois_read_model_replays_projects_features_requests_and_metrics(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    database = Database(tmp_path / "db.sqlite3")
    service = CohorteService(database)
    initialized = service.init_project(project)
    project_id = str(initialized["profile"]["project_id"])
    intake = service.intake(project_id, "A precise bug report")
    request_id = database.create_request(None, "question", {"prompt": "Continue?"}, "a" * 64)
    server = RpcServer(service)
    call(
        server,
        "init",
        "initialize",
        {
            "protocol_major": 1,
            "protocol_minor": 0,
            "client": {"name": "francois-test", "version": "1"},
            "capabilities": ["events.replay"],
        },
    )

    projects = call(server, "projects", "projects.list")["result"]
    assert projects["items"][0]["id"] == project_id
    project_view = call(server, "project", "projects.get", {"project_id": project_id})["result"]
    assert project_view["profile"]["project_id"] == project_id
    features = call(server, "features", "features.list", {"project_id": project_id})["result"]
    assert features["items"][0]["id"] == intake["feature_id"]
    requests = call(server, "requests", "requests.list", {"status": "pending"})["result"]
    assert requests["items"][0]["id"] == request_id
    assert requests["items"][0]["payload"] == {"prompt": "Continue?"}

    now = datetime.now(UTC)
    metrics = call(
        server,
        "metrics",
        "metrics.get",
        {
            "project_id": project_id,
            "since": (now - timedelta(days=1)).isoformat(),
            "until": (now + timedelta(days=1)).isoformat(),
            "group_by": "provider",
        },
    )["result"]
    assert metrics["group_by"] == "provider"
    assert metrics["groups"][0]["key"] == "unavailable"

    replay = call(server, "events", "events.subscribe", {"after_seq": 0})["result"]
    unsubscribed = call(
        server,
        "unsubscribe",
        "events.unsubscribe",
        {"subscription_id": replay["subscription_id"]},
    )["result"]
    assert unsubscribed == {"unsubscribed": True}
    database.close()


def test_invalid_major_is_structured(tmp_path) -> None:
    database = Database(tmp_path / "db.sqlite3")
    server = RpcServer(CohorteService(database))
    response = call(
        server,
        "1",
        "initialize",
        {
            "protocol_major": 2,
            "protocol_minor": 0,
            "client": {"name": "test", "version": "1"},
            "capabilities": [],
        },
    )
    assert response["error"]["data"]["code"] == "PROTOCOL_INCOMPATIBLE"
    database.close()


def test_malformed_and_oversized_frames_are_rejected_without_dispatch(tmp_path) -> None:
    database = Database(tmp_path / "db.sqlite3")
    server = RpcServer(CohorteService(database))

    malformed = json.loads(server.handle_line(b"{"))
    oversized = json.loads(server.handle_line(b"x" * (MAX_FRAME_BYTES + 1)))

    assert malformed["error"]["data"]["code"] == "PROTOCOL_INVALID"
    assert oversized["error"]["data"]["code"] == "PROTOCOL_INVALID"
    assert server.initialized is False
    database.close()


def test_two_protocol_clients_race_one_request_and_only_first_decision_wins(tmp_path) -> None:
    path = tmp_path / "db.sqlite3"
    setup = Database(path)
    subject = "a" * 64
    request_id = setup.create_request(None, "approval", {"action": "ship"}, subject)
    setup.close()
    barrier = threading.Barrier(2)

    def respond(response_id: str, approved: bool) -> dict:
        database = Database(path)
        try:
            server = RpcServer(CohorteService(database), connection_id=response_id)
            call(
                server,
                "init",
                "initialize",
                {
                    "protocol_major": 1,
                    "protocol_minor": 0,
                    "client": {"name": response_id, "version": "1"},
                    "capabilities": [],
                },
            )
            barrier.wait(timeout=2)
            return call(
                server,
                response_id,
                "requests.respond",
                {
                    "request_id": request_id,
                    "response_id": response_id,
                    "response": {"approved": approved},
                    "subject_hash": subject,
                },
            )
        finally:
            database.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda values: respond(*values),
                [("client-one", True), ("client-two", False)],
            )
        )

    winners = [response for response in responses if "result" in response]
    losers = [response for response in responses if "error" in response]
    assert len(winners) == 1
    assert len(losers) == 1
    assert losers[0]["error"]["data"]["code"] == "REQUEST_ALREADY_RESOLVED"
    check = Database(path)
    try:
        assert len(check.connection.execute("SELECT * FROM approvals").fetchall()) == 1
    finally:
        check.close()
