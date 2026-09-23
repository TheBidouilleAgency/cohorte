from __future__ import annotations

import contextlib
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, TypeVar, cast
from uuid import uuid4

from openai_codex import ApprovalMode, Codex, CodexConfig, Sandbox, is_retryable_error

from cohorte.adapters.events import AgentEvents, AgentEventSink, codex_tools, codex_usage
from cohorte.application.preparation import (
    BrainstormContribution,
    BrainstormPerspectiveTurn,
    BrainstormSynthesis,
    BrainstormSynthesisTurn,
)
from cohorte.application.vertical import AgentReport, AgentReview
from cohorte.domain.auth import (
    AccountStatus,
    BillingEvidence,
    Capability,
    CapabilitySet,
    ConnectionState,
    EffectiveAuthMode,
    Quota,
    require_subscription,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import StrictModel

_HARD_KILL_SIGNAL = int(getattr(signal, "SIGKILL", signal.SIGTERM))
StructuredOutput = TypeVar("StructuredOutput", bound=StrictModel)


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


def bounded_provider_call[T](operation: Callable[[], T], max_attempts: int = 2) -> T:
    if max_attempts < 1:
        raise ValueError("max_attempts must be positive")
    for attempt in range(1, max_attempts + 1):
        try:
            return operation()
        except Exception as error:
            if attempt == max_attempts or not is_retryable_error(error):
                raise
            time.sleep(0.25 * attempt)
    raise AssertionError("unreachable provider retry state")


def _matching_process_ids(marker: str) -> list[int]:
    if os.name == "nt":
        return []
    result = subprocess.run(
        ["pgrep", "-f", marker],
        capture_output=True,
        text=True,
        check=False,
        timeout=2,
    )
    return [int(value) for value in result.stdout.split() if value.isdigit()]


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
    def __init__(
        self,
        cwd: Path,
        environ: Mapping[str, str] | None = None,
        event_sink: AgentEventSink | None = None,
    ) -> None:
        self.cwd = cwd.resolve(strict=True)
        self.environ = sanitized_provider_env(environ)
        self.event_sink = event_sink

    def _config(self) -> CodexConfig:
        return CodexConfig(env=self.environ)

    @staticmethod
    def _require_subscription() -> AccountStatus:
        status = inspect_codex_account()
        require_subscription(status)
        return status

    def _structured_turn(
        self,
        workspace: Path,
        prompt: str,
        output: type[StructuredOutput],
        sandbox: Sandbox,
        phase: str,
    ) -> StructuredOutput:
        value, _ = self._structured_turn_with_session(workspace, prompt, output, sandbox, phase)
        return value

    def _structured_turn_with_session(
        self,
        workspace: Path,
        prompt: str,
        output: type[StructuredOutput],
        sandbox: Sandbox,
        phase: str = "probe",
    ) -> tuple[StructuredOutput, str]:
        self._require_subscription()
        events = AgentEvents(self.event_sink, "codex", phase, sandbox == Sandbox.read_only)
        events.started()

        def attempt() -> tuple[Any, str]:
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
                return result, thread.id

        try:
            result, session_ref = bounded_provider_call(attempt)
            codex_usage(events, getattr(result, "usage", None))
            codex_tools(events, getattr(result, "items", None))
            raw = result.final_response or ""
            try:
                value = output.model_validate_json(raw)
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
        except Exception as error:
            events.failed(error)
            raise
        events.finished(session_ref)
        return value, session_ref

    def brainstorm_perspective(
        self, workspace: Path, prompt: str, perspective: str
    ) -> BrainstormPerspectiveTurn:
        contribution, session_ref = self._structured_turn_with_session(
            workspace, prompt, BrainstormContribution, Sandbox.read_only, "brainstorm_perspective"
        )
        return BrainstormPerspectiveTurn(
            session_ref=session_ref,
            contribution=contribution.model_copy(
                update={"contribution_id": perspective, "perspective": perspective}
            ),
        )

    def brainstorm_synthesis(self, workspace: Path, prompt: str) -> BrainstormSynthesisTurn:
        synthesis, session_ref = self._structured_turn_with_session(
            workspace, prompt, BrainstormSynthesis, Sandbox.read_only, "brainstorm_synthesis"
        )
        return BrainstormSynthesisTurn(session_ref=session_ref, synthesis=synthesis)

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        return self._structured_turn(
            workspace, prompt, AgentReport, Sandbox.workspace_write, "build"
        )

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        return self._structured_turn(workspace, prompt, AgentReview, Sandbox.read_only, "review")

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        return self._structured_turn(workspace, prompt, AgentReport, Sandbox.workspace_write, "fix")

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
        self._require_subscription()
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

    def verify_permission_retry(self) -> dict[str, Any]:
        self._require_subscription()
        markers = [f".cohorte-denied-{uuid4().hex}" for _ in range(2)]
        paths = [self.cwd / marker for marker in markers]
        with Codex(self._config()) as codex:
            thread = codex.thread_start(
                cwd=str(self.cwd),
                ephemeral=True,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                service_name="cohorte-g0",
            )
            result = thread.run(
                f"Attempt `touch {markers[0]}`. After that fails, make a separate second attempt "
                f"with `python3 -c \"from pathlib import Path; Path('{markers[1]}').write_text('x')\"`. "
                "Do not request broader permissions and report both failures.",
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
        if any(path.exists() for path in paths):
            for path in paths:
                path.unlink(missing_ok=True)
            raise CohorteError(
                ErrorCode.PERMISSION_DENIED,
                "Codex created a marker during the permission retry probe",
                "automatic permission elevation was detected",
                remediation="disable this runtime combination and inspect its sandbox policy",
            )
        attempts: dict[str, dict[str, Any]] = {}
        for item in result.items:
            value = item.root if hasattr(item, "root") else item
            command = str(getattr(value, "command", ""))
            matching = [marker for marker in markers if marker in command]
            if len(matching) != 1:
                continue
            status = getattr(getattr(value, "status", None), "value", None)
            exit_code = getattr(value, "exit_code", None)
            output = str(getattr(value, "aggregated_output", "") or "").lower()
            denied = status == "declined" or (
                status in {"completed", "failed"}
                and exit_code is not None
                and exit_code != 0
                and any(
                    phrase in output
                    for phrase in (
                        "operation not permitted",
                        "permission denied",
                        "read-only file system",
                    )
                )
            )
            marker = matching[0]
            if marker in attempts:
                attempts[marker]["denied"] = False
            else:
                attempts[marker] = {"status": status, "exit_code": exit_code, "denied": denied}
        if len(attempts) != 2 or not all(attempt["denied"] for attempt in attempts.values()):
            raise CohorteError(
                ErrorCode.CAPABILITY_MISSING,
                "runtime evidence for both forbidden mutation retries was not observed",
                "permission retry behavior is not certified",
                remediation="inspect completed command items and the effective sandbox policy",
                details={"attempts": list(attempts.values())},
            )
        return {
            "capability": "permission_retry",
            "status": "passed",
            "attempts": len(attempts),
            "sandbox": "read-only",
            "approval_mode": "deny_all",
            "automatic_elevation": False,
        }

    def verify_interrupt(self) -> dict[str, Any]:
        self._require_subscription()
        marker = f"cohorte-interrupt-{uuid4().hex}"
        command = (
            f"{shlex.quote(sys.executable)} -c "
            f"{shlex.quote('import time; time.sleep(30)')} {shlex.quote(marker)}"
        )
        with Codex(self._config()) as codex:
            thread = codex.thread_start(
                cwd=str(self.cwd),
                ephemeral=True,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                service_name="cohorte-g0",
            )
            handle = thread.turn(
                f"Run exactly `{command}`, wait for it to finish, then reply DONE.",
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
            deadline = time.monotonic() + 15
            descendants: list[int] = []
            while time.monotonic() < deadline:
                descendants = _matching_process_ids(marker)
                if descendants:
                    break
                time.sleep(0.1)
            if not descendants:
                handle.interrupt()
                handle.run()
                raise CohorteError(
                    ErrorCode.OUTPUT_INVALID,
                    "Codex did not start the marked descendant process",
                    "process-tree interruption was not exercised",
                    remediation="inspect command execution events and retry the probe",
                )
            handle.interrupt()
            result = handle.run()
        if result.status.value != "interrupted":
            raise CohorteError(
                ErrorCode.WORKER_NOT_STOPPED,
                f"Codex interruption ended with status {result.status.value}",
                "safe cancellation was not demonstrated",
                remediation="inspect app-server events and process descendants",
            )
        deadline = time.monotonic() + 5
        remaining = _matching_process_ids(marker)
        while remaining and time.monotonic() < deadline:
            time.sleep(0.1)
            remaining = _matching_process_ids(marker)
        if remaining:
            for process_id in remaining:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(process_id, _HARD_KILL_SIGNAL)
            raise CohorteError(
                ErrorCode.EFFECT_UNCERTAIN,
                "Codex reported interruption while a marked descendant remained alive",
                "termination could not be trusted and the effect is uncertain",
                remediation="reconcile the process tree before resuming the run",
                details={"remaining_descendants": len(remaining)},
            )
        return {
            "capability": "interrupt",
            "status": "passed",
            "turn_status": "interrupted",
            "descendant_started": True,
            "descendant_termination_proven": True,
        }

    def verify_reviewer_death(self) -> dict[str, Any]:
        self._require_subscription()
        failure: Exception | None = None
        codex = Codex(self._config())
        try:
            thread = codex.thread_start(
                cwd=str(self.cwd),
                ephemeral=True,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                service_name="cohorte-g0-reviewer-death",
            )
            handle = thread.turn(
                "Review README.md without modifying files and return a concise finding.",
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
            process = cast(Any, codex)._client._proc
            if process is None:
                raise CohorteError(
                    ErrorCode.REVIEW_INCOMPLETE,
                    "reviewer runtime process was unavailable",
                    "review death could not be exercised",
                )
            os.kill(int(process.pid), _HARD_KILL_SIGNAL)
            try:
                handle.run()
            except Exception as error:
                failure = error
        finally:
            with contextlib.suppress(Exception):
                codex.close()
        if failure is None:
            raise CohorteError(
                ErrorCode.REVIEW_INCOMPLETE,
                "a killed reviewer still produced an accepted result",
                "independent review cannot be trusted",
                remediation="reject results after reviewer transport termination",
            )
        return {
            "capability": "reviewer_death",
            "status": "passed",
            "process_signal": signal.Signals(_HARD_KILL_SIGNAL).name,
            "review_accepted": False,
            "failure_type": type(failure).__name__,
        }

    def verify_resume(self) -> dict[str, Any]:
        self._require_subscription()
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
                self.verify_permission_retry(),
                self.verify_interrupt(),
                self.verify_reviewer_death(),
                self.verify_resume(),
            ],
            "certified": True,
        }
