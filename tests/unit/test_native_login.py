from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from cohorte.adapters import native_login as module
from cohorte.adapters.providers import PassiveRuntimeStatus
from cohorte.domain.errors import CohorteError, ErrorCode


def status(connection: str = "connected", version: str | None = "1.0") -> PassiveRuntimeStatus:
    return PassiveRuntimeStatus(
        provider="codex",
        connection_state=connection,
        effective_auth_mode="subscription" if connection == "connected" else "unknown",
        billing_evidence="runtime_reported" if connection == "connected" else "unverified",
        runtime_version=version,
        executable="/bin/codex",
    )


def test_native_login_hands_off_to_official_cli_and_checks_final_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[list[str], dict[str, str], int]] = []
    statuses = iter([status("login_required"), status()])
    monkeypatch.setattr(module.shutil, "which", lambda _: "/bin/codex")
    monkeypatch.setattr(module, "inspect_runtime", lambda _: next(statuses))
    monkeypatch.setattr(module, "sanitized_provider_env", lambda: {"CODEX_HOME": "/isolated"})

    def run(command: list[str], *, env: dict[str, str], check: bool, timeout: int) -> object:
        assert check is False
        calls.append((command, env, timeout))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.native_login("codex").connection_state == "connected"
    assert calls == [(["/bin/codex", "login"], {"CODEX_HOME": "/isolated"}, 600)]


def test_native_login_does_not_trust_success_exit_without_connected_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(module.shutil, "which", lambda _: "/bin/claude")
    monkeypatch.setattr(module, "inspect_runtime", lambda _: status("login_required"))
    monkeypatch.setattr(module, "sanitized_claude_env", lambda: {})
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0),
    )
    with pytest.raises(CohorteError) as caught:
        module.native_login("claude")
    assert caught.value.code == ErrorCode.AUTH_REQUIRED


def test_native_login_rejects_second_login_for_same_context(tmp_path: Path) -> None:
    context = {"CODEX_HOME": str(tmp_path)}
    with (
        module._login_lock("codex", context),
        pytest.raises(CohorteError) as caught,
        module._login_lock("codex", context),
    ):
        pass
    assert caught.value.code == ErrorCode.AUTH_BUSY


def test_native_login_lock_is_process_scoped(tmp_path: Path) -> None:
    code = (
        "import sys; "
        "from cohorte.adapters.native_login import _login_lock; "
        "from pathlib import Path; "
        "context = {'CODEX_HOME': sys.argv[1]}; "
        "lock = _login_lock('codex', context); "
        "lock.__enter__(); print('ready', flush=True); "
        "sys.stdin.readline(); lock.__exit__(None, None, None)"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(tmp_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline().strip() == "ready"
        with (
            pytest.raises(CohorteError) as caught,
            module._login_lock("codex", {"CODEX_HOME": str(tmp_path)}),
        ):
            pass
        assert caught.value.code == ErrorCode.AUTH_BUSY
    finally:
        if process.stdin is not None:
            process.stdin.write("done\n")
            process.stdin.flush()
        assert process.wait(timeout=5) == 0
