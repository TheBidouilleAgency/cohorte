from __future__ import annotations

import hashlib
import json
import threading
from contextlib import suppress
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from cohorte.application.service import CohorteService
from cohorte.persistence.sqlite import Database
from cohorte.protocol.rpc import MAX_FRAME_BYTES, RpcServer


def pipe_name(data_dir: Path) -> str:
    digest = hashlib.sha256(str(data_dir.resolve()).casefold().encode()).hexdigest()[:24]
    return rf"\\.\pipe\cohorte-{digest}"


def _mutex_name(data_dir: Path) -> str:
    digest = hashlib.sha256(str(data_dir.resolve()).casefold().encode()).hexdigest()[:24]
    return rf"Local\Cohorte-{digest}"


def current_user_sid() -> str:
    import win32api
    import win32con
    import win32security

    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()
    return cast(str, win32security.ConvertSidToStringSid(sid))


def _security_attributes() -> Any:
    import pywintypes
    import win32api
    import win32con
    import win32security

    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        user_sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()
    acl = win32security.ACL()
    acl.AddAccessAllowedAce(
        win32security.ACL_REVISION,
        win32con.GENERIC_READ | win32con.GENERIC_WRITE | win32con.READ_CONTROL,
        user_sid,
    )
    attributes = pywintypes.SECURITY_ATTRIBUTES()
    attributes.SetSecurityDescriptorDacl(True, acl, False)
    return attributes


def _create_pipe(name: str) -> Any:
    import win32pipe

    mode = win32pipe.PIPE_TYPE_BYTE | win32pipe.PIPE_READMODE_BYTE | win32pipe.PIPE_WAIT
    mode |= getattr(win32pipe, "PIPE_REJECT_REMOTE_CLIENTS", 0)
    return win32pipe.CreateNamedPipe(
        name,
        win32pipe.PIPE_ACCESS_DUPLEX,
        mode,
        8,
        MAX_FRAME_BYTES + 1,
        MAX_FRAME_BYTES + 1,
        5000,
        _security_attributes(),
    )


def _read_line(handle: Any, buffer: bytearray) -> bytes | None:
    import pywintypes
    import win32file

    while b"\n" not in buffer:
        try:
            _, chunk = win32file.ReadFile(handle, 65536)
        except pywintypes.error as error:
            if error.winerror in {109, 232}:  # broken pipe / no data
                return None
            raise
        buffer.extend(chunk)
        if len(buffer) > MAX_FRAME_BYTES:
            raise ValueError("frame exceeds 1 MiB")
    line, remainder = bytes(buffer).split(b"\n", 1)
    buffer.clear()
    buffer.extend(remainder)
    return line + b"\n"


def _write(handle: Any, payload: bytes, lock: threading.Lock) -> None:
    import win32file

    if len(payload) > MAX_FRAME_BYTES:
        raise ValueError("outbound frame exceeds 1 MiB")
    with lock:
        win32file.WriteFile(handle, payload)


def _wake(name: str) -> None:
    try:
        handle = _open_pipe(name)
    except OSError:
        return
    _close(handle)


def _close(handle: Any) -> None:
    handle.Close()


def _open_pipe(name: str) -> Any:
    import win32con
    import win32file
    import win32pipe

    win32pipe.WaitNamedPipe(name, 2000)
    return win32file.CreateFile(
        name,
        win32con.GENERIC_READ | win32con.GENERIC_WRITE,
        0,
        None,
        win32con.OPEN_EXISTING,
        0,
        None,
    )


def _handle_client(handle: Any, data_dir: Path, stop: threading.Event, name: str) -> None:
    import pywintypes
    import win32pipe

    database = Database(data_dir / "cohorte.sqlite3")

    def shutdown() -> None:
        stop.set()
        threading.Thread(target=_wake, args=(name,), daemon=True).start()

    server = RpcServer(
        CohorteService(database), shutdown=shutdown, connection_id=str(uuid4()), live_events=False
    )
    buffer = bytearray()
    write_lock = threading.Lock()
    try:
        while (line := _read_line(handle, buffer)) is not None:
            _write(handle, server.handle_line(line), write_lock)
    except (OSError, RuntimeError, ValueError, pywintypes.error):
        pass
    finally:
        database.close()
        with suppress(pywintypes.error):
            win32pipe.DisconnectNamedPipe(handle)
        _close(handle)


def serve_windows(data_dir: Path) -> None:
    import pywintypes
    import win32api
    import win32event
    import win32pipe

    data_dir.mkdir(parents=True, exist_ok=True)
    name = pipe_name(data_dir)
    stop = threading.Event()
    workers: list[threading.Thread] = []
    mutex = win32event.CreateMutex(None, False, _mutex_name(data_dir))
    if win32api.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        _close(mutex)
        raise RuntimeError(f"Cohorte service is already running at {name}")
    try:
        while not stop.is_set():
            handle = _create_pipe(name)
            try:
                win32pipe.ConnectNamedPipe(handle, None)
            except pywintypes.error as error:
                if error.winerror != 535:  # ERROR_PIPE_CONNECTED
                    _close(handle)
                    raise
            if stop.is_set():
                _close(handle)
                break
            worker = threading.Thread(
                target=_handle_client, args=(handle, data_dir, stop, name), daemon=True
            )
            worker.start()
            workers.append(worker)
    finally:
        for worker in workers:
            worker.join(timeout=2)
        _close(mutex)


def pipe_rpc_call(name: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    import pywintypes

    try:
        handle = _open_pipe(name)
    except pywintypes.error as error:
        raise ConnectionError(f"named pipe is unavailable: {name}") from error
    buffer = bytearray()
    lock = threading.Lock()
    try:
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
        response: dict[str, Any] = {}
        for frame in frames:
            _write(handle, (json.dumps(frame, separators=(",", ":")) + "\n").encode(), lock)
            line = _read_line(handle, buffer)
            if line is None:
                raise ConnectionError("named pipe closed before the response")
            response = json.loads(line)
            if "error" in response:
                raise RuntimeError(response["error"]["data"]["message"])
        return cast(dict[str, Any], response["result"])
    finally:
        _close(handle)
