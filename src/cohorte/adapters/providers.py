from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from typing import Literal

from cohorte.adapters.codex import inspect_codex_account


@dataclass(frozen=True, slots=True)
class PassiveRuntimeStatus:
    provider: Literal["claude", "codex"]
    connection_state: str
    effective_auth_mode: str
    billing_evidence: str
    runtime_version: str | None
    executable: str | None
    certified: bool = False


def inspect_runtime(provider: Literal["claude", "codex"]) -> PassiveRuntimeStatus:
    if provider == "codex":
        status = inspect_codex_account()
        executable = shutil.which("codex")
        return PassiveRuntimeStatus(
            provider="codex",
            connection_state=status.connection_state.value,
            effective_auth_mode=status.effective_auth_mode.value,
            billing_evidence=status.billing_evidence.value,
            runtime_version=status.runtime_version,
            executable=executable,
            certified=False,
        )
    executable = shutil.which(provider)
    if executable is None:
        return PassiveRuntimeStatus(provider, "unavailable", "unknown", "unverified", None, None)
    result = subprocess.run(
        [executable, "--version"], capture_output=True, text=True, check=False, timeout=5
    )
    version = (result.stdout or result.stderr).strip()[:200] if result.returncode == 0 else None
    # Presence and version do not prove auth or subscription routing.
    return PassiveRuntimeStatus(
        provider, "not_configured", "unknown", "unverified", version, executable
    )
