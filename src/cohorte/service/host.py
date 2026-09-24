from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from cohorte.application.service import CohorteService
from cohorte.persistence.sqlite import Database
from cohorte.protocol.rpc import MAX_FRAME_BYTES, RpcServer


def socket_path(data_dir: Path) -> Path:
    return data_dir / "service.sock"


def pid_path(data_dir: Path) -> Path:
    return data_dir / "service.pid.json"


def endpoint_name(data_dir: Path) -> str:
    if os.name == "nt":
        from cohorte.service.windows_pipe import pipe_name

        return pipe_name(data_dir)
    return str(socket_path(data_dir))


def _peer_uid(connection: Any) -> int:
    if hasattr(connection, "getpeereid"):
        uid, _ = connection.getpeereid()
        return int(uid)
    if hasattr(socket, "SO_PEERCRED"):
        credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        _, uid, _ = struct.unpack("3i", credentials)
        return int(uid)
    if hasattr(socket, "LOCAL_PEERCRED"):
        credentials = connection.getsockopt(0, socket.LOCAL_PEERCRED, 80)
        _, uid = struct.unpack_from("II", credentials)
        return int(uid)
    raise RuntimeError("this POSIX platform does not expose local peer credentials")


async def serve(
    data_dir: Path,
    *,
    writer_timeout_seconds: float = 5,
    socket_send_buffer_bytes: int | None = None,
) -> None:
    if os.name == "nt":
        raise RuntimeError("Windows named-pipe transport requires a Windows host")
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(data_dir, 0o700)
    endpoint = socket_path(data_dir)
    if endpoint.exists():
        try:
            rpc_call(endpoint, "health.get", {})
        except (ConnectionError, OSError, TimeoutError):
            endpoint.unlink()
        else:
            raise RuntimeError(f"Cohorte service is already running at {endpoint}")

    database = Database(data_dir / "cohorte.sqlite3")
    service = CohorteService(database)
    stopping = asyncio.Event()
    active_writers: set[asyncio.StreamWriter] = set()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        active_writers.add(writer)
        connection = writer.get_extra_info("socket")
        if connection is not None and socket_send_buffer_bytes is not None:
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, socket_send_buffer_bytes)
        follower: asyncio.Task[None] | None = None
        write_lock = asyncio.Lock()

        async def send(payload: bytes) -> None:
            if len(payload) > MAX_FRAME_BYTES:
                raise ValueError("outbound frame exceeds 1 MiB")
            async with write_lock:
                writer.write(payload)
                await asyncio.wait_for(writer.drain(), timeout=writer_timeout_seconds)

        async def follow_events(after_seq: int, params: dict[str, Any]) -> None:
            cursor = after_seq
            try:
                while not writer.is_closing():
                    items = database.events_after(
                        cursor,
                        params.get("run_id"),
                        100,
                        params.get("project_id"),
                    )
                    if not items:
                        await asyncio.sleep(0.05)
                        continue
                    for event in items:
                        notification = {
                            "jsonrpc": "2.0",
                            "method": "events.notification",
                            "params": event,
                        }
                        await send(
                            (json.dumps(notification, separators=(",", ":")) + "\n").encode()
                        )
                        cursor = int(event["seq"])
            except (ConnectionError, RuntimeError, TimeoutError, ValueError):
                writer.close()

        try:
            current_uid = int(cast(Any, os).getuid())
            if connection is None or _peer_uid(connection) != current_uid:
                writer.close()
                await writer.wait_closed()
                return
            server = RpcServer(service, shutdown=stopping.set, connection_id=str(uuid4()))
            while not reader.at_eof():
                line = await reader.readline()
                if not line:
                    break
                response = server.handle_line(line)
                await send(response)
                request = json.loads(line)
                document = json.loads(response)
                if request.get("method") == "events.subscribe" and "result" in document:
                    if follower is not None:
                        follower.cancel()
                    follower = asyncio.create_task(
                        follow_events(int(document["result"]["watermark"]), request["params"])
                    )
                elif request.get("method") == "events.unsubscribe" and "result" in document:
                    if follower is not None:
                        follower.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await follower
                        follower = None
        except (asyncio.LimitOverrunError, ConnectionError, RuntimeError, TimeoutError, ValueError):
            pass
        finally:
            active_writers.discard(writer)
            if follower is not None:
                follower.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await follower
            writer.close()
            await writer.wait_closed()

    server = await cast(Any, asyncio).start_unix_server(
        handle, path=endpoint, limit=MAX_FRAME_BYTES + 1
    )
    os.chmod(endpoint, 0o600)
    identity = {
        "pid": os.getpid(),
        "started_at": datetime.now(UTC).isoformat(),
        "socket": str(endpoint),
        "transport": "unix-socket",
    }
    pid_path(data_dir).write_text(json.dumps(identity, sort_keys=True) + "\n")
    os.chmod(pid_path(data_dir), 0o600)
    try:
        await stopping.wait()
    finally:
        server.close()
        for writer in tuple(active_writers):
            writer.close()
        await server.wait_closed()
        database.close()
        endpoint.unlink(missing_ok=True)
        pid_path(data_dir).unlink(missing_ok=True)


def rpc_call(endpoint: Path, method: str, params: dict[str, Any]) -> dict[str, Any]:
    with socket.socket(cast(Any, socket).AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        client.connect(str(endpoint))
        frames = [
            {
                "jsonrpc": "2.0",
                "id": "initialize",
                "method": "initialize",
                "params": {
                    "protocol_major": 1,
                    "protocol_minor": 0,
                    "client": {"name": "cohorte-cli", "version": "1"},
                    "capabilities": [],
                },
            },
            {"jsonrpc": "2.0", "id": "call", "method": method, "params": params},
        ]
        stream = client.makefile("rwb")
        for frame in frames:
            stream.write((json.dumps(frame, separators=(",", ":")) + "\n").encode())
            stream.flush()
            response = json.loads(stream.readline())
            if "error" in response:
                raise RuntimeError(response["error"]["data"]["message"])
        return cast(dict[str, Any], response["result"])


def service_status(data_dir: Path) -> dict[str, Any]:
    if os.name == "nt":
        from cohorte.service.windows_pipe import pipe_rpc_call

        pipe_endpoint = endpoint_name(data_dir)
        try:
            health = pipe_rpc_call(pipe_endpoint, "health.get", {})
        except (ConnectionError, OSError, RuntimeError, TimeoutError, ValueError):
            return {"running": False, "pipe": pipe_endpoint}
        identity = json.loads(pid_path(data_dir).read_text()) if pid_path(data_dir).exists() else {}
        return {"running": True, **identity, "health": health}
    unix_endpoint = socket_path(data_dir)
    if not unix_endpoint.exists():
        return {"running": False, "socket": str(unix_endpoint)}
    try:
        health = rpc_call(unix_endpoint, "health.get", {})
    except (ConnectionError, OSError, RuntimeError, TimeoutError, ValueError):
        return {"running": False, "socket": str(unix_endpoint), "stale": True}
    identity = json.loads(pid_path(data_dir).read_text()) if pid_path(data_dir).exists() else {}
    return {"running": True, **identity, "health": health}


def start_service(data_dir: Path, timeout_seconds: float = 5) -> dict[str, Any]:
    current = service_status(data_dir)
    if current["running"]:
        return current
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    log = data_dir / "service.log"
    with log.open("ab") as output:
        creation_flags = 0
        if os.name == "nt":
            creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200) | getattr(
                subprocess, "DETACHED_PROCESS", 0x00000008
            )
        process = subprocess.Popen(
            [sys.executable, "-m", "cohorte.service.host", "--data-dir", str(data_dir)],
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=output,
            start_new_session=os.name != "nt",
            creationflags=creation_flags,
            close_fds=True,
        )
    os.chmod(log, 0o600)
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status = service_status(data_dir)
        if status["running"]:
            return status
        if process.poll() is not None:
            raise RuntimeError(f"Cohorte service exited during startup; inspect {log}")
        time.sleep(0.05)
    process.terminate()
    process.wait(timeout=2)
    raise RuntimeError(f"Cohorte service did not start; inspect {log}")


def stop_service(data_dir: Path, timeout_seconds: float = 5) -> dict[str, Any]:
    current = service_status(data_dir)
    if not current["running"]:
        return current
    if os.name == "nt":
        from cohorte.service.windows_pipe import pipe_rpc_call

        pipe_rpc_call(
            endpoint_name(data_dir),
            "service.shutdown",
            {"request_id": f"cli-stop-{uuid4()}"},
        )
    else:
        rpc_call(
            socket_path(data_dir),
            "service.shutdown",
            {"request_id": f"cli-stop-{uuid4()}"},
        )
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        stopped = not service_status(data_dir)["running"]
        cleaned_up = os.name == "nt" or (
            not socket_path(data_dir).exists() and not pid_path(data_dir).exists()
        )
        if stopped and cleaned_up:
            return {"running": False, "stopped": True}
        time.sleep(0.05)
    raise RuntimeError("Cohorte service did not stop within the deadline")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    if os.name == "nt":
        from cohorte.service.windows_pipe import serve_windows

        args.data_dir.mkdir(parents=True, exist_ok=True)
        identity = {
            "pid": os.getpid(),
            "started_at": datetime.now(UTC).isoformat(),
            "pipe": endpoint_name(args.data_dir),
            "transport": "windows-named-pipe",
        }
        pid_path(args.data_dir).write_text(json.dumps(identity, sort_keys=True) + "\n")
        try:
            serve_windows(args.data_dir)
        finally:
            pid_path(args.data_dir).unlink(missing_ok=True)
    else:
        asyncio.run(serve(args.data_dir))


if __name__ == "__main__":
    main()
