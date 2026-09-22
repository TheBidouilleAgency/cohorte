from __future__ import annotations

import asyncio
import json
import os
import stat
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import pytest

from cohorte.domain.models import RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database
from cohorte.service.host import (
    rpc_call,
    serve,
    service_status,
    socket_path,
    start_service,
    stop_service,
)


def seed_run(data_dir: Path) -> None:
    database = Database(data_dir / "cohorte.sqlite3")
    profile = database.put_artifact("project-profile", b"{}")
    database.register_project("project", "/tmp/project", profile["id"])
    database.create_feature("feature", "project", "Feature")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="run-one",
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
    database.close()


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX Unix socket test")
async def test_unix_host_checks_peer_permissions_and_survives_client_disconnect() -> None:
    with tempfile.TemporaryDirectory(prefix="cohorte-host-", dir="/tmp") as raw:
        data_dir = Path(raw)
        seed_run(data_dir)
        task = asyncio.create_task(serve(data_dir))
        for _ in range(100):
            if task.done():
                error = task.exception()
                if isinstance(error, PermissionError) and not os.environ.get(
                    "COHORTE_SOCKET_REQUIRED"
                ):
                    pytest.skip("sandbox does not permit Unix socket creation")
                if error is not None:
                    raise error
            if socket_path(data_dir).exists():
                break
            await asyncio.sleep(0.01)
        assert socket_path(data_dir).exists()
        assert stat.S_IMODE(data_dir.stat().st_mode) == 0o700
        assert stat.S_IMODE(socket_path(data_dir).stat().st_mode) == 0o600

        first = await asyncio.to_thread(
            rpc_call, socket_path(data_dir), "runs.get", {"run_id": "run-one"}
        )
        assert first["status"] == "running"
        second = await asyncio.to_thread(
            rpc_call, socket_path(data_dir), "runs.get", {"run_id": "run-one"}
        )
        assert second["state_version"] == 1

        reader, writer = await asyncio.open_unix_connection(socket_path(data_dir))

        async def send(identifier: str, method: str, params: dict[str, object]) -> dict:
            writer.write(
                (
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": identifier,
                            "method": method,
                            "params": params,
                        }
                    )
                    + "\n"
                ).encode()
            )
            await writer.drain()
            return json.loads(await asyncio.wait_for(reader.readline(), timeout=2))

        initialized = await send(
            "initialize",
            "initialize",
            {
                "protocol_major": 1,
                "protocol_minor": 0,
                "client": {"name": "francois-test", "version": "1"},
                "capabilities": ["events.live"],
            },
        )
        assert "events.live" in initialized["result"]["capabilities"]
        subscribed = await send(
            "subscribe", "events.subscribe", {"project_id": "project", "after_seq": 0}
        )
        subscription_id = subscribed["result"]["subscription_id"]
        producer = Database(data_dir / "cohorte.sqlite3")
        producer.append_event("agent.message", {"text": "live"}, project_id="project")
        producer.close()
        notification = json.loads(await asyncio.wait_for(reader.readline(), timeout=2))
        assert notification["method"] == "events.notification"
        assert notification["params"]["data"] == {"text": "live"}
        unsubscribed = await send(
            "unsubscribe", "events.unsubscribe", {"subscription_id": subscription_id}
        )
        assert unsubscribed["result"] == {"unsubscribed": True}
        writer.close()
        await writer.wait_closed()

        stopped = await asyncio.to_thread(
            rpc_call,
            socket_path(data_dir),
            "service.shutdown",
            {"request_id": "stop-test"},
        )
        assert stopped == {"accepted": True}
        await asyncio.wait_for(task, timeout=2)
        assert not socket_path(data_dir).exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX Unix socket test")
def test_background_service_start_status_stop() -> None:
    with tempfile.TemporaryDirectory(prefix="cohorte-service-", dir="/tmp") as raw:
        data_dir = Path(raw)
        try:
            try:
                started = start_service(data_dir)
            except RuntimeError:
                log = data_dir / "service.log"
                if (
                    log.exists()
                    and "Operation not permitted" in log.read_text()
                    and not os.environ.get("COHORTE_SOCKET_REQUIRED")
                ):
                    pytest.skip("sandbox does not permit Unix socket creation")
                raise
            assert started["running"] is True
            assert service_status(data_dir)["health"]["database"]["ok"] is True
        finally:
            stopped = stop_service(data_dir)
        assert stopped["running"] is False
        assert not socket_path(data_dir).exists()
