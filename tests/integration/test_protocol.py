from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from cohorte.application.service import CohorteService
from cohorte.persistence.sqlite import Database
from cohorte.protocol.rpc import RpcServer


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
