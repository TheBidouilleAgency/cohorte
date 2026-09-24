from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import pytest

from cohorte.domain.models import RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database
from cohorte.protocol.rpc import MAX_FRAME_BYTES
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

        reader, writer = await asyncio.open_unix_connection(
            socket_path(data_dir), limit=MAX_FRAME_BYTES + 1
        )

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


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX Unix socket test")
async def test_shutdown_closes_idle_client_connections() -> None:
    with tempfile.TemporaryDirectory(prefix="cohorte-idle-client-", dir="/tmp") as raw:
        data_dir = Path(raw)
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

        reader, writer = await asyncio.open_unix_connection(socket_path(data_dir))
        try:
            writer.write(
                (
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": "initialize",
                            "method": "initialize",
                            "params": {
                                "protocol_major": 1,
                                "protocol_minor": 0,
                                "client": {"name": "idle-test", "version": "1"},
                                "capabilities": [],
                            },
                        }
                    )
                    + "\n"
                ).encode()
            )
            await writer.drain()
            assert "result" in json.loads(await asyncio.wait_for(reader.readline(), timeout=2))

            stopped = await asyncio.to_thread(stop_service, data_dir, 0.5)
            assert stopped == {"running": False, "stopped": True}
            assert await asyncio.wait_for(reader.read(), timeout=2) == b""
        finally:
            writer.close()
            await writer.wait_closed()
            await asyncio.wait_for(task, timeout=2)


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX Unix socket test")
async def test_slow_client_is_disconnected_and_replays_from_last_sequence() -> None:
    with tempfile.TemporaryDirectory(prefix="cohorte-slow-client-", dir="/tmp") as raw:
        data_dir = Path(raw)
        seed_run(data_dir)
        task = asyncio.create_task(
            serve(data_dir, writer_timeout_seconds=0.05, socket_send_buffer_bytes=4096)
        )
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

        baseline_database = Database(data_dir / "cohorte.sqlite3")
        baseline = int(baseline_database.events_after()[-1]["seq"])
        baseline_database.close()
        reader, writer = await asyncio.open_unix_connection(
            socket_path(data_dir), limit=MAX_FRAME_BYTES + 1
        )
        client_socket = writer.get_extra_info("socket")
        client_socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)

        async def send(
            stream_writer: asyncio.StreamWriter,
            stream_reader: asyncio.StreamReader,
            identifier: str,
            method: str,
            params: dict[str, object],
        ) -> dict:
            stream_writer.write(
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
            await stream_writer.drain()
            return json.loads(await asyncio.wait_for(stream_reader.readline(), timeout=2))

        await send(
            writer,
            reader,
            "initialize",
            "initialize",
            {
                "protocol_major": 1,
                "protocol_minor": 0,
                "client": {"name": "slow-test", "version": "1"},
                "capabilities": ["events.live"],
            },
        )
        await send(writer, reader, "subscribe", "events.subscribe", {"after_seq": baseline})

        def produce_events() -> int:
            producer = Database(data_dir / "cohorte.sqlite3")
            try:
                last = baseline
                for index in range(80):
                    last = producer.append_event(
                        "agent.message", {"index": index, "text": "x" * 32_768}
                    )
                return last
            finally:
                producer.close()

        target = await asyncio.to_thread(produce_events)
        await asyncio.sleep(0.2)
        first_sequences: list[int] = []

        async def drain_disconnected_client() -> None:
            while line := await reader.readline():
                frame = json.loads(line)
                if frame.get("method") == "events.notification":
                    first_sequences.append(int(frame["params"]["seq"]))

        await asyncio.wait_for(drain_disconnected_client(), timeout=5)
        writer.close()
        await writer.wait_closed()

        resume_reader, resume_writer = await asyncio.open_unix_connection(
            socket_path(data_dir), limit=MAX_FRAME_BYTES + 1
        )
        await send(
            resume_writer,
            resume_reader,
            "initialize-resume",
            "initialize",
            {
                "protocol_major": 1,
                "protocol_minor": 0,
                "client": {"name": "resume-test", "version": "1"},
                "capabilities": ["events.live"],
            },
        )
        last_received = first_sequences[-1] if first_sequences else baseline
        resumed = await send(
            resume_writer,
            resume_reader,
            "resume",
            "events.subscribe",
            {"after_seq": last_received},
        )
        resumed_sequences = [int(event["seq"]) for event in resumed["result"]["items"]]
        while (resumed_sequences[-1] if resumed_sequences else last_received) < target:
            frame = json.loads(await asyncio.wait_for(resume_reader.readline(), timeout=2))
            if frame.get("method") == "events.notification":
                resumed_sequences.append(int(frame["params"]["seq"]))

        assert first_sequences + resumed_sequences == list(range(baseline + 1, target + 1))
        resume_writer.close()
        await resume_writer.wait_closed()
        await asyncio.to_thread(
            rpc_call,
            socket_path(data_dir),
            "service.shutdown",
            {"request_id": "stop-slow-test"},
        )
        await asyncio.wait_for(task, timeout=2)


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
