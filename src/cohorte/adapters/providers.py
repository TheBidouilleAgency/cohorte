from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from cohorte.adapters.claude import ClaudeAdapter, inspect_claude_account
from cohorte.adapters.codex import CodexAdapter, inspect_codex_account
from cohorte.domain.models import ProjectProfile, Provider, RunStatus


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
    status = inspect_claude_account()
    return PassiveRuntimeStatus(
        provider,
        status.connection_state.value,
        status.effective_auth_mode.value,
        status.billing_evidence.value,
        status.runtime_version,
        shutil.which("claude"),
    )


def workflow_runtime(
    repository: Path,
    profile: ProjectProfile,
    *,
    stop_requested: Callable[[], RunStatus | None] | None = None,
) -> CodexAdapter | ClaudeAdapter:
    if profile.agent_defaults.provider == Provider.CLAUDE:
        return ClaudeAdapter(
            repository, model=profile.agent_defaults.model, stop_requested=stop_requested
        )
    return CodexAdapter(repository)
