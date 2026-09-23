"""Exercise the Francois-facing contract through a real service connection."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

import pytest

from cohorte.persistence.sqlite import Database
from cohorte.service.host import serve, socket_path


def _git_project(root: Path) -> None:
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / "README.md").write_text("fixture\n")
    subprocess.run(["git", "-C", str(root), "add", "README.md"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "init",
        ],
        check=True,
    )


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX service transport")
async def test_external_client_start_decide_disconnect_and_gap_free_replay(tmp_path: Path) -> None:
    project = tmp_path / "project"
    _git_project(project)
    data_dir = Path(tempfile.mkdtemp(prefix="cohorte-ac19-", dir="/tmp"))
    database = Database(data_dir / "cohorte.sqlite3")
    profile = database.put_artifact("project-profile", b"{}")
    database.register_project("project", str(project), profile["id"])
    database.create_feature("feature", "project", "Conformance")
    database.close()

    host = asyncio.create_task(serve(data_dir))
    try:
        for _ in range(100):
            if host.done():
                error = host.exception()
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

        async def connect() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
            reader, writer = await asyncio.open_unix_connection(socket_path(data_dir))
            initialized = await call(
                reader,
                writer,
                "initialize",
                "initialize",
                {
                    "protocol_major": 1,
                    "protocol_minor": 0,
                    "client": {"name": "francois-conformance", "version": "1"},
                    "capabilities": ["events.replay", "events.live"],
                },
            )
            assert "events.live" in initialized["result"]["capabilities"]
            return reader, writer

        async def call(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
            identifier: str,
            method: str,
            params: dict[str, object],
        ) -> dict:
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
            while True:
                frame = json.loads(await asyncio.wait_for(reader.readline(), timeout=3))
                if frame.get("id") == identifier:
                    return frame

        reader, writer = await connect()
        started = await call(
            reader,
            writer,
            "start",
            "runs.start",
            {
                "request_id": str(uuid4()),
                "project_id": "project",
                "feature_id": "feature",
                "path": str(project),
            },
        )
        run_id = started["result"]["run_id"]
        run = await call(reader, writer, "run", "runs.get", {"run_id": run_id})
        assert run["result"]["status"] == "queued"

        subject = "a" * 64
        producer = Database(data_dir / "cohorte.sqlite3")
        question = producer.create_request(run_id, "question", {"prompt": "Continue?"}, subject)
        approval = producer.create_request(run_id, "approval", {"action": "ship"}, subject)
        producer.append_event("request.created", {"request_id": question}, run_id=run_id)
        producer.append_event("request.created", {"request_id": approval}, run_id=run_id)
        producer.close()

        pending = await call(
            reader,
            writer,
            "pending",
            "requests.list",
            {
                "run_id": run_id,
                "status": "pending",
            },
        )
        assert {item["id"] for item in pending["result"]["items"]} == {question, approval}
        answered = await call(
            reader,
            writer,
            "answer",
            "requests.respond",
            {
                "response_id": str(uuid4()),
                "request_id": question,
                "response": {"answer": "yes"},
                "subject_hash": subject,
            },
        )
        approved = await call(
            reader,
            writer,
            "approve",
            "requests.respond",
            {
                "response_id": str(uuid4()),
                "request_id": approval,
                "response": {"approved": True},
                "subject_hash": subject,
            },
        )
        assert answered["result"]["status"] == "answered"
        assert approved["result"]["status"] == "answered"

        replay = await call(
            reader,
            writer,
            "replay",
            "events.subscribe",
            {
                "run_id": run_id,
                "after_seq": 0,
            },
        )
        previous = replay["result"]["watermark"]
        assert any(item["type"] == "request.created" for item in replay["result"]["items"])
        writer.close()
        await writer.wait_closed()

        producer = Database(data_dir / "cohorte.sqlite3")
        offline_sequences = [
            producer.append_event("agent.message", {"index": index}, run_id=run_id)
            for index in range(2)
        ]
        producer.close()
        reader, writer = await connect()
        resumed = await call(
            reader,
            writer,
            "resume",
            "events.subscribe",
            {
                "run_id": run_id,
                "after_seq": previous,
            },
        )
        assert [item["seq"] for item in resumed["result"]["items"]] == offline_sequences

        producer = Database(data_dir / "cohorte.sqlite3")
        live_sequence = producer.append_event("agent.message", {"index": 2}, run_id=run_id)
        producer.close()
        while True:
            frame = json.loads(await asyncio.wait_for(reader.readline(), timeout=3))
            if frame.get("method") == "events.notification":
                break
        assert frame["params"]["seq"] == live_sequence
        assert [*offline_sequences, live_sequence] == list(range(previous + 1, live_sequence + 1))

        await call(
            reader,
            writer,
            "unsubscribe",
            "events.unsubscribe",
            {
                "subscription_id": resumed["result"]["subscription_id"],
            },
        )
        await call(reader, writer, "stop", "service.shutdown", {"request_id": str(uuid4())})
        writer.close()
        await writer.wait_closed()
        await asyncio.wait_for(host, timeout=3)
    finally:
        if not host.done():
            host.cancel()
            await asyncio.gather(host, return_exceptions=True)
        shutil.rmtree(data_dir)
