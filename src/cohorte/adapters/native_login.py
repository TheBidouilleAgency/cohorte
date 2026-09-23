from __future__ import annotations

import hashlib
import importlib
import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from cohorte.adapters.claude import sanitized_claude_env
from cohorte.adapters.codex import sanitized_provider_env
from cohorte.adapters.providers import PassiveRuntimeStatus, inspect_runtime
from cohorte.domain.errors import CohorteError, ErrorCode


@contextmanager
def _login_lock(provider: Literal["claude", "codex"], env: dict[str, str]) -> Iterator[None]:
    context = env.get("CLAUDE_CONFIG_DIR" if provider == "claude" else "CODEX_HOME")
    context = context or str(Path.home() / (".claude" if provider == "claude" else ".codex"))
    identity = f"{provider}:{Path(context).expanduser().resolve()}".encode()
    name = hashlib.sha256(identity).hexdigest()[:32]
    path = Path(tempfile.gettempdir()) / f"cohorte-auth-{name}.lock"
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags | os.O_EXCL, 0o600)
        created = True
    except FileExistsError:
        descriptor = os.open(path, flags, 0o600)
        created = False
    try:
        if os.name == "nt":
            windows_lock = importlib.import_module("msvcrt")

            if created:
                os.write(descriptor, b"0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                windows_lock.locking(descriptor, windows_lock.LK_NBLCK, 1)
            except OSError as error:
                raise _busy(provider) from error
            try:
                yield
            finally:
                os.lseek(descriptor, 0, os.SEEK_SET)
                windows_lock.locking(descriptor, windows_lock.LK_UNLCK, 1)
        else:
            unix_lock = importlib.import_module("fcntl")

            try:
                unix_lock.flock(descriptor, unix_lock.LOCK_EX | unix_lock.LOCK_NB)
            except BlockingIOError as error:
                raise _busy(provider) from error
            try:
                yield
            finally:
                unix_lock.flock(descriptor, unix_lock.LOCK_UN)
    finally:
        os.close(descriptor)


def _busy(provider: str) -> CohorteError:
    return CohorteError(
        ErrorCode.AUTH_BUSY,
        f"{provider} login is already active for this native context",
        "a second login cannot start",
        retryable=True,
        remediation="wait for the existing login to finish",
    )


def native_login(provider: Literal["claude", "codex"]) -> PassiveRuntimeStatus:
    """Hand the terminal to the official client without capturing login secrets."""
    executable = shutil.which(provider)
    if executable is None:
        raise CohorteError(
            ErrorCode.CAPABILITY_MISSING,
            f"{provider} CLI is unavailable",
            "the official login cannot start",
            remediation=f"install the official {provider} CLI and retry",
        )
    before = inspect_runtime(provider)
    if before.runtime_version is None:
        raise CohorteError(
            ErrorCode.CAPABILITY_MISSING,
            f"{provider} CLI version could not be verified",
            "the official login cannot start",
            remediation="repair the native runtime and retry",
        )
    command = (
        [executable, "auth", "login", "--claudeai"]
        if provider == "claude"
        else [executable, "login"]
    )
    env = sanitized_claude_env() if provider == "claude" else sanitized_provider_env()
    with _login_lock(provider, env):
        try:
            # The provider owns stdin/stdout/stderr: OAuth URLs and codes never enter
            # Cohorte's JSON output, exception details, or durable logs.
            result = subprocess.run(command, env=env, check=False, timeout=600)
        except subprocess.TimeoutExpired as error:
            raise CohorteError(
                ErrorCode.AUTH_REQUIRED,
                f"{provider} login timed out",
                "the account was not marked connected",
                remediation="retry the native login",
            ) from error
        if result.returncode != 0:
            raise CohorteError(
                ErrorCode.AUTH_REQUIRED,
                f"{provider} login did not complete",
                "the account was not marked connected",
                remediation="retry the native login",
            )
        after = inspect_runtime(provider)
    if after.connection_state != "connected":
        raise CohorteError(
            ErrorCode.AUTH_REQUIRED,
            f"{provider} CLI reported success but the account is not connected",
            "the account was not marked connected",
            remediation="inspect the official client status and retry",
        )
    return after
