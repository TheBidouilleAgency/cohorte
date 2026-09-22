from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast
from uuid import uuid4

from openai_codex import ApprovalMode, Codex, CodexConfig, Sandbox

from cohorte.application.vertical import AgentReport, AgentReview
from cohorte.domain.auth import (
    AccountStatus,
    BillingEvidence,
    Capability,
    CapabilitySet,
    ConnectionState,
    EffectiveAuthMode,
    Quota,
)
from cohorte.domain.errors import CohorteError, ErrorCode


def _capability(support: str, version: str | None = None, *limitations: str) -> Capability:
    return Capability(
        support=cast(Literal["supported", "unsupported", "unknown"], support),
        version=version,
        limitations=list(limitations),
    )


def codex_capabilities(version: str | None) -> CapabilitySet:
    supported = _capability("supported", version)
    return CapabilitySet(
        structured_output=supported,
        streaming=supported,
        tool_permissions=supported,
        user_questions=supported,
        interrupt=supported,
        session_resume=supported,
        read_only_role=supported,
        native_auth_status=supported,
        model_catalog=_capability("unknown", version, "not proven by the passive status command"),
        usage_reporting=supported,
    )


def sanitized_provider_env(source: Mapping[str, str] | None = None) -> dict[str, str]:
    """Preserve the process environment while removing API/gateway routing overrides."""
    env = dict(source or os.environ)
    for name in (
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
    ):
        env.pop(name, None)
    return env


def strict_output_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Adapt a Pydantic schema to the provider's strict structured-output subset."""
    for value in schema.values():
        if isinstance(value, dict):
            strict_output_schema(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    strict_output_schema(item)
    properties = schema.get("properties")
    if isinstance(properties, dict):
        schema["required"] = list(properties)
        schema["additionalProperties"] = False
    return schema


def inspect_codex_account(executable: str | None = None) -> AccountStatus:
    executable = executable or shutil.which("codex")
    now = datetime.now(UTC)
    if executable is None:
        return AccountStatus(
            account_id="codex-native",
            connection_state=ConnectionState.UNAVAILABLE,
            effective_auth_mode=EffectiveAuthMode.UNKNOWN,
            billing_evidence=BillingEvidence.UNVERIFIED,
            capabilities=codex_capabilities(None),
            checked_at=now,
        )
    version_result = subprocess.run(
        [executable, "--version"],
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
        env=sanitized_provider_env(),
    )
    version = (
        (version_result.stdout or version_result.stderr).strip()[:200]
        if version_result.returncode == 0
        else None
    )
    result = subprocess.run(
        [executable, "login", "status"],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
        env=sanitized_provider_env(),
    )
    output = f"{result.stdout}\n{result.stderr}".lower()
    if result.returncode != 0:
        connection = ConnectionState.LOGIN_REQUIRED
        mode = EffectiveAuthMode.UNKNOWN
        evidence = BillingEvidence.UNVERIFIED
    elif "chatgpt" in output:
        connection = ConnectionState.CONNECTED
        mode = EffectiveAuthMode.SUBSCRIPTION
        evidence = BillingEvidence.RUNTIME_REPORTED
    elif "api key" in output or "api-key" in output:
        connection = ConnectionState.CONNECTED
        mode = EffectiveAuthMode.API
        evidence = BillingEvidence.RUNTIME_REPORTED
    else:
        connection = ConnectionState.CONNECTED
        mode = EffectiveAuthMode.UNKNOWN
        evidence = BillingEvidence.UNVERIFIED
    return AccountStatus(
        account_id="codex-native",
        connection_state=connection,
        effective_auth_mode=mode,
        billing_evidence=evidence,
        capabilities=codex_capabilities(version),
        runtime_version=version,
        checked_at=now,
        quota=Quota(),
    )


class CodexAdapter:
    def __init__(self, cwd: Path, environ: Mapping[str, str] | None = None) -> None:
        self.cwd = cwd.resolve(strict=True)
        self.environ = sanitized_provider_env(environ)

    def _config(self) -> CodexConfig:
        return CodexConfig(env=self.environ)

    @staticmethod
    def _require_subscription() -> AccountStatus:
        status = inspect_codex_account()
        if status.effective_auth_mode == EffectiveAuthMode.API:
            raise CohorteError(
                ErrorCode.AUTH_MODE_MISMATCH,
                "Codex is authenticated with an API key",
                "provider execution was refused in subscription_only mode",
                remediation="sign in to Codex with ChatGPT, then retry",
            )
        if status.effective_auth_mode != EffectiveAuthMode.SUBSCRIPTION:
            raise CohorteError(
                ErrorCode.AUTH_MODE_UNVERIFIED,
                "Codex ChatGPT authentication was not verified",
                "provider execution was not started",
                remediation="run codex login status, then sign in with codex login if needed",
            )
        return status

    def _structured_turn(
        self,
        workspace: Path,
        prompt: str,
        output: type[AgentReport] | type[AgentReview],
        sandbox: Sandbox,
    ) -> AgentReport | AgentReview:
        self._require_subscription()
        with Codex(self._config()) as codex:
            thread = codex.thread_start(
                cwd=str(workspace.resolve(strict=True)),
                ephemeral=True,
                sandbox=sandbox,
                approval_mode=ApprovalMode.deny_all,
                service_name="cohorte-g1",
            )
            result = thread.run(
                prompt,
                output_schema=strict_output_schema(output.model_json_schema()),
                sandbox=sandbox,
                approval_mode=ApprovalMode.deny_all,
            )
        raw = result.final_response or ""
        try:
            return output.model_validate_json(raw)
        except (json.JSONDecodeError, ValueError) as error:
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                f"Codex returned invalid structured output for {output.__name__}",
                "the workflow phase was rejected",
                remediation="inspect provider diagnostics and retry the phase",
                details={
                    "turn_status": result.status.value,
                    "validation_error": str(error)[:2000],
                    "response_excerpt": raw[:2000],
                },
            ) from error

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        return cast(
            AgentReport,
            self._structured_turn(workspace, prompt, AgentReport, Sandbox.workspace_write),
        )

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        return cast(
            AgentReview, self._structured_turn(workspace, prompt, AgentReview, Sandbox.read_only)
        )

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        return cast(
            AgentReport,
            self._structured_turn(workspace, prompt, AgentReport, Sandbox.workspace_write),
        )

    def verify_live(self) -> dict[str, Any]:
        status = self._require_subscription()
        with Codex(self._config()) as codex:
            thread = codex.thread_start(
                cwd=str(self.cwd),
                ephemeral=True,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                service_name="cohorte-g0",
            )
            result = thread.run(
                "Reply with exactly G0_CODEX_OK. Do not use any tool.",
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
        if (result.final_response or "").strip() != "G0_CODEX_OK":
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                "Codex live probe returned an unexpected response",
                "the account/runtime combination is not verified",
                remediation="inspect provider diagnostics and retry the bounded probe",
            )
        return {
            "provider": "codex",
            "account_id": status.account_id,
            "effective_auth_mode": status.effective_auth_mode.value,
            "billing_evidence": status.billing_evidence.value,
            "runtime_version": status.runtime_version,
            "probe": "passed",
            "sandbox": "read-only",
            "approval_mode": "deny_all",
            "thread_ephemeral": True,
            "checked_at": datetime.now(UTC).isoformat(),
        }

    def verify_read_only(self) -> dict[str, Any]:
        marker = self.cwd / f".cohorte-g0-{uuid4().hex}"
        with Codex(self._config()) as codex:
            thread = codex.thread_start(
                cwd=str(self.cwd),
                ephemeral=True,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                service_name="cohorte-g0",
            )
            result = thread.run(
                f"Attempt to create the file {marker.name} in the current directory, then report "
                "whether the operation was denied.",
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
        if marker.exists():
            raise CohorteError(
                ErrorCode.PERMISSION_DENIED,
                "Codex modified the workspace during the read-only probe",
                "the runtime cannot be trusted for a reviewer role",
                remediation="disable this runtime combination and inspect its sandbox configuration",
            )
        return {
            "capability": "read_only_role",
            "status": "passed",
            "turn_status": result.status.value,
            "marker_absent": True,
        }

    def verify_interrupt(self) -> dict[str, Any]:
        with Codex(self._config()) as codex:
            thread = codex.thread_start(
                cwd=str(self.cwd),
                ephemeral=True,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                service_name="cohorte-g0",
            )
            handle = thread.turn(
                "Run the command `sleep 30`, wait for it to finish, then reply DONE.",
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
            time.sleep(0.5)
            handle.interrupt()
            result = handle.run()
        if result.status.value != "interrupted":
            raise CohorteError(
                ErrorCode.WORKER_NOT_STOPPED,
                f"Codex interruption ended with status {result.status.value}",
                "safe cancellation was not demonstrated",
                remediation="inspect app-server events and process descendants",
            )
        return {"capability": "interrupt", "status": "passed", "turn_status": "interrupted"}

    def verify_resume(self) -> dict[str, Any]:
        nonce = f"COHORTE_{uuid4().hex[:12]}"
        with Codex(self._config()) as codex:
            thread = codex.thread_start(
                cwd=str(self.cwd),
                ephemeral=False,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                service_name="cohorte-g0",
            )
            first = thread.run(
                f"Remember this nonce for the next turn and reply with exactly STORED: {nonce}",
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
            thread_id = thread.id
        if (first.final_response or "").strip() != f"STORED: {nonce}":
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                "Codex did not acknowledge the resume nonce",
                "session resume was not tested",
                remediation="retry the bounded resume probe",
            )
        with Codex(self._config()) as codex:
            resumed = codex.thread_resume(
                thread_id,
                cwd=str(self.cwd),
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
            second = resumed.run(
                "Reply with exactly the nonce from the previous turn.",
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
        if (second.final_response or "").strip() != nonce:
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                "Codex resumed the thread without reproducing the nonce",
                "session continuity was not demonstrated",
                remediation="inspect the persisted thread and runtime version",
            )
        return {
            "capability": "session_resume",
            "status": "passed",
            "thread_id": thread_id,
            "nonce_verified": True,
        }

    def verify_full(self) -> dict[str, Any]:
        smoke = self.verify_live()
        return {
            **smoke,
            "capabilities": [
                self.verify_read_only(),
                self.verify_interrupt(),
                self.verify_resume(),
            ],
            "certified": True,
        }
