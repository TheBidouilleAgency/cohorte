from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NoReturn, TypeVar

from cohorte.adapters.events import AgentEvents, AgentEventSink, claude_usage
from cohorte.application.durable import RunStopped
from cohorte.application.intake import IntakeProposal
from cohorte.application.patch import PatchProposal
from cohorte.application.preparation import (
    BrainstormContribution,
    BrainstormPerspectiveTurn,
    BrainstormSynthesis,
    BrainstormSynthesisTurn,
    SpecProposal,
)
from cohorte.application.vertical import AgentReport, AgentReview
from cohorte.domain.auth import (
    AccountStatus,
    BillingEvidence,
    Capability,
    CapabilitySet,
    ConnectionState,
    EffectiveAuthMode,
    require_subscription,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import RunStatus, StrictModel

StructuredOutput = TypeVar("StructuredOutput", bound=StrictModel)
_ROUTING_KEYS = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
        "CLAUDE_CODE_OAUTH_SCOPES",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID",
        "GOOGLE_APPLICATION_CREDENTIALS",
    }
)


def sanitized_claude_env(source: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if source is None else source)
    for key in _ROUTING_KEYS:
        env.pop(key, None)
    return env


def claude_capabilities(version: str | None) -> CapabilitySet:
    supported = Capability(support="supported", version=version)
    unknown = Capability(support="unknown", version=version)
    return CapabilitySet(
        structured_output=supported,
        streaming=supported,
        tool_permissions=supported,
        user_questions=unknown,
        interrupt=unknown,
        session_resume=unknown,
        read_only_role=unknown,
        native_auth_status=supported,
        model_catalog=unknown,
        usage_reporting=unknown,
    )


def raise_claude_result_error(result: str | None) -> NoReturn:
    if result and "organization has disabled claude subscription access" in result.lower():
        raise CohorteError(
            ErrorCode.PROVIDER_UNAVAILABLE,
            "Claude subscription access is disabled for this organization",
            "the phase cannot start through the subscription",
            remediation="ask the organization admin to enable access or select an eligible Claude account",
        )
    raise CohorteError(
        ErrorCode.OUTPUT_INVALID,
        "Claude turn failed",
        "the workflow phase was rejected",
        remediation="inspect provider diagnostics and retry the phase",
    )


def inspect_claude_account(
    executable: str | None = None, environ: Mapping[str, str] | None = None
) -> AccountStatus:
    source = os.environ if environ is None else environ
    executable = executable or shutil.which("claude")
    now = datetime.now(UTC)
    version: str | None = None
    if executable is None:
        connection, mode, evidence = (
            ConnectionState.UNAVAILABLE,
            EffectiveAuthMode.UNKNOWN,
            BillingEvidence.UNVERIFIED,
        )
    else:
        env = sanitized_claude_env(source)
        try:
            version_result = subprocess.run(
                [executable, "--version"],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
                env=env,
            )
            if version_result.returncode == 0:
                version = (version_result.stdout or version_result.stderr).strip()[:200]
            result = subprocess.run(
                [executable, "auth", "status", "--json"],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
                env=env,
            )
            data = json.loads(result.stdout) if result.returncode == 0 else {}
            if not isinstance(data, dict):
                data = {}
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            data = {}
        if data.get("loggedIn") is True:
            connection = ConnectionState.CONNECTED
            if (
                data.get("authMethod") == "claude.ai"
                and data.get("apiProvider") == "firstParty"
                and data.get("subscriptionType")
            ):
                mode, evidence = EffectiveAuthMode.SUBSCRIPTION, BillingEvidence.RUNTIME_REPORTED
            elif data.get("apiProvider") not in (None, "firstParty"):
                mode, evidence = EffectiveAuthMode.THIRD_PARTY, BillingEvidence.RUNTIME_REPORTED
            elif data.get("authMethod") == "api_key":
                mode, evidence = EffectiveAuthMode.API, BillingEvidence.RUNTIME_REPORTED
            else:
                mode, evidence = EffectiveAuthMode.UNKNOWN, BillingEvidence.UNVERIFIED
        else:
            connection, mode, evidence = (
                ConnectionState.LOGIN_REQUIRED,
                EffectiveAuthMode.UNKNOWN,
                BillingEvidence.UNVERIFIED,
            )
    # An override in the parent process makes the effective route ambiguous even
    # when the isolated CLI status command reports a subscription account.
    if any(source.get(key) for key in _ROUTING_KEYS) and connection == ConnectionState.CONNECTED:
        mode, evidence = EffectiveAuthMode.UNKNOWN, BillingEvidence.UNVERIFIED
    return AccountStatus(
        account_id="claude-native",
        connection_state=connection,
        effective_auth_mode=mode,
        billing_evidence=evidence,
        capabilities=claude_capabilities(version),
        runtime_version=version,
        checked_at=now,
    )


class ClaudeAdapter:
    def __init__(
        self,
        cwd: Path,
        environ: Mapping[str, str] | None = None,
        model: str | None = None,
        stop_requested: Callable[[], RunStatus | None] | None = None,
        event_sink: AgentEventSink | None = None,
    ) -> None:
        self.cwd = cwd.resolve(strict=True)
        self.environ = dict(os.environ if environ is None else environ)
        self.model = model
        self.stop_requested = stop_requested
        self.event_sink = event_sink

    def _require_subscription(self) -> AccountStatus:
        status = inspect_claude_account(environ=self.environ)
        require_subscription(status)
        return status

    def _structured_turn_with_session(
        self,
        workspace: Path,
        prompt: str,
        output: type[StructuredOutput],
        read_only: bool,
        phase: str = "probe",
    ) -> tuple[StructuredOutput, str]:
        if self.stop_requested is not None:
            stopped = self.stop_requested()
            if stopped is not None:
                raise RunStopped(stopped.value)
        self._require_subscription()
        events = AgentEvents(self.event_sink, "claude", phase, read_only)
        try:
            from claude_agent_sdk import (
                ClaudeAgentOptions,
                ClaudeSDKClient,
                HookContext,
                HookInput,
                HookMatcher,
                ResultMessage,
            )
            from claude_agent_sdk.types import SyncHookJSONOutput
        except ImportError as error:
            raise CohorteError(
                ErrorCode.PROVIDER_UNAVAILABLE,
                "Claude Agent SDK is not installed",
                "the phase cannot start",
                remediation="install the claude optional dependency",
            ) from error
        workspace = workspace.resolve(strict=True)
        tools = ["Read", "Grep", "Glob"]
        if not read_only:
            tools += ["Edit", "Write"]

        async def guard_tool(
            hook_input: HookInput, _tool_use_id: str | None, _context: HookContext
        ) -> SyncHookJSONOutput:
            name = hook_input.get("tool_name")
            params = hook_input.get("tool_input", {})
            key = "file_path" if name in {"Read", "Edit", "Write"} else "path"
            path = params.get(key) if isinstance(params, dict) else None
            permitted = name in tools and (
                (name in {"Grep", "Glob"} and path is None)
                or (isinstance(path, str) and bool(path))
            )
            if permitted and path is not None:
                target = (workspace / path).resolve()
                permitted = target == workspace or workspace in target.parents
            if name in {"Read", "Grep", "Glob", "Edit", "Write"}:
                events.tool(
                    str(name).lower(),
                    decision="allow" if permitted else "deny",
                    outcome="unknown" if permitted else "denied",
                    source="pre_tool_hook",
                )
            if permitted:
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                    }
                }
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "repository path and tool policy",
                }
            }

        options = ClaudeAgentOptions(
            cwd=str(workspace),
            model=self.model,
            fallback_model=None,
            tools=tools,
            allowed_tools=tools,
            disallowed_tools=["Bash", "NotebookEdit", "Task"]
            + ([] if not read_only else ["Edit", "Write"]),
            permission_mode="dontAsk",
            setting_sources=[],
            mcp_servers={},
            strict_mcp_config=True,
            hooks={
                "PreToolUse": [HookMatcher(matcher="Read|Grep|Glob|Edit|Write", hooks=[guard_tool])]
            },
            max_turns=20 if read_only else 40,
            env=sanitized_claude_env(self.environ),
            output_format={"type": "json_schema", "schema": output.model_json_schema()},
        )
        events.started()

        async def run() -> tuple[Any, str]:
            async with ClaudeSDKClient(options=options) as client:
                stop_status: RunStatus | None = None

                async def watch_stop() -> None:
                    nonlocal stop_status
                    assert self.stop_requested is not None
                    while True:
                        status = self.stop_requested()
                        if status is not None:
                            stop_status = status
                            await client.interrupt()
                            return
                        await asyncio.sleep(0.2)

                watcher = (
                    asyncio.create_task(watch_stop()) if self.stop_requested is not None else None
                )
                try:
                    await client.query(prompt)
                    async for message in client.receive_response():
                        if watcher is not None and watcher.done():
                            watcher.result()
                        if stop_status is not None:
                            raise RunStopped(stop_status.value)
                        if isinstance(message, ResultMessage):
                            claude_usage(
                                events,
                                getattr(message, "usage", None),
                                getattr(message, "total_cost_usd", None),
                            )
                            denials = getattr(message, "permission_denials", None)
                            if isinstance(denials, list) and denials:
                                events.permission_denials(len(denials))
                            if message.is_error:
                                raise_claude_result_error(message.result)
                            return (
                                message.structured_output
                                if message.structured_output is not None
                                else message.result,
                                message.session_id,
                            )
                    if watcher is not None and watcher.done():
                        watcher.result()
                    if stop_status is not None:
                        raise RunStopped(stop_status.value)
                finally:
                    if watcher is not None:
                        watcher.cancel()
                        with suppress(asyncio.CancelledError):
                            await watcher
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                "Claude turn ended without a result",
                "the workflow phase was rejected",
            )

        try:
            raw, session_ref = asyncio.run(run())
            try:
                # SDK structured_output is a dict; JSON mode accepts wire enums.
                value = output.model_validate_json(raw if isinstance(raw, str) else json.dumps(raw))
            except (ValueError, TypeError) as error:
                raise CohorteError(
                    ErrorCode.OUTPUT_INVALID,
                    f"Claude returned invalid structured output for {output.__name__}",
                    "the workflow phase was rejected",
                    remediation="inspect provider diagnostics and retry the phase",
                    details={"validation_error": str(error)[:2000]},
                ) from error
        except RunStopped:
            events.stopped()
            raise
        except Exception as error:
            events.failed(error)
            raise
        events.finished(session_ref)
        return value, session_ref

    def _structured_turn(
        self,
        workspace: Path,
        prompt: str,
        output: type[StructuredOutput],
        read_only: bool,
        phase: str,
    ) -> StructuredOutput:
        return self._structured_turn_with_session(workspace, prompt, output, read_only, phase)[0]

    def brainstorm_perspective(
        self, workspace: Path, prompt: str, perspective: str
    ) -> BrainstormPerspectiveTurn:
        contribution, session_ref = self._structured_turn_with_session(
            workspace, prompt, BrainstormContribution, True, "brainstorm_perspective"
        )
        return BrainstormPerspectiveTurn(
            session_ref=session_ref,
            contribution=contribution.model_copy(
                update={"contribution_id": perspective, "perspective": perspective}
            ),
        )

    def brainstorm_synthesis(self, workspace: Path, prompt: str) -> BrainstormSynthesisTurn:
        synthesis, session_ref = self._structured_turn_with_session(
            workspace, prompt, BrainstormSynthesis, True, "brainstorm_synthesis"
        )
        return BrainstormSynthesisTurn(session_ref=session_ref, synthesis=synthesis)

    def spec_proposal(self, workspace: Path, prompt: str) -> SpecProposal:
        return self._structured_turn(workspace, prompt, SpecProposal, True, "spec_proposal")

    def intake_proposal(self, workspace: Path, prompt: str) -> IntakeProposal:
        return self._structured_turn(workspace, prompt, IntakeProposal, True, "intake_proposal")

    def patch_proposal(self, workspace: Path, prompt: str) -> PatchProposal:
        return self._structured_turn(workspace, prompt, PatchProposal, True, "patch_proposal")

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        return self._structured_turn(workspace, prompt, AgentReport, False, "build")

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        return self._structured_turn(workspace, prompt, AgentReview, True, "review")

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        return self._structured_turn(workspace, prompt, AgentReport, False, "fix")

    def verify_live(self) -> dict[str, Any]:
        status = self._require_subscription()
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, ResultMessage

        async def run() -> str | None:
            options = ClaudeAgentOptions(
                cwd=str(self.cwd),
                tools=[],
                allowed_tools=[],
                disallowed_tools=["Bash", "Edit", "Write", "NotebookEdit", "Task"],
                permission_mode="dontAsk",
                setting_sources=[],
                mcp_servers={},
                strict_mcp_config=True,
                env=sanitized_claude_env(self.environ),
                max_turns=1,
            )
            async with ClaudeSDKClient(options=options) as client:
                await client.query("Reply with exactly G0_CLAUDE_OK. Do not use any tool.")
                async for message in client.receive_response():
                    if isinstance(message, ResultMessage):
                        if message.is_error:
                            raise_claude_result_error(message.result)
                        return message.result
            return None

        if (asyncio.run(run()) or "").strip() != "G0_CLAUDE_OK":
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                "Claude live probe returned an unexpected response",
                "the account/runtime combination is not verified",
            )
        return {
            "provider": "claude",
            "account_id": status.account_id,
            "effective_auth_mode": status.effective_auth_mode.value,
            "billing_evidence": status.billing_evidence.value,
            "runtime_version": status.runtime_version,
            "probe": "passed",
            "checked_at": datetime.now(UTC).isoformat(),
        }
