from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

import claude_agent_sdk
import pytest

from cohorte.adapters.claude import ClaudeAdapter, inspect_claude_account
from cohorte.adapters.providers import workflow_runtime
from cohorte.domain.auth import (
    BillingEvidence,
    ConnectionState,
    EffectiveAuthMode,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import (
    AgentDefaults,
    ProjectProfile,
    Provider,
    StrictModel,
    Surface,
    VcsConfig,
)


class Answer(StrictModel):
    answer: str


def _status_payload(**overrides: object) -> str:
    data = {
        "loggedIn": True,
        "authMethod": "claude.ai",
        "subscriptionType": "max",
        "apiProvider": "firstParty",
        "email": "private@example.test",
    }
    data.update(overrides)
    return json.dumps(data)


@patch("cohorte.adapters.claude.subprocess.run")
def test_passive_status_recognizes_subscription_without_identity(run: Mock) -> None:
    run.side_effect = [
        SimpleNamespace(returncode=0, stdout="2.1.0", stderr=""),
        SimpleNamespace(returncode=0, stdout=_status_payload(), stderr=""),
    ]
    status = inspect_claude_account("/bin/claude", {"PATH": "/bin"})
    assert status.connection_state == ConnectionState.CONNECTED
    assert status.effective_auth_mode == EffectiveAuthMode.SUBSCRIPTION
    assert status.billing_evidence == BillingEvidence.RUNTIME_REPORTED
    assert "private@example.test" not in status.model_dump_json()


@patch("cohorte.adapters.claude.subprocess.run")
def test_api_override_fails_closed_before_provider_call(run: Mock) -> None:
    run.side_effect = [
        SimpleNamespace(returncode=0, stdout="2.1.0", stderr=""),
        SimpleNamespace(returncode=0, stdout=_status_payload(), stderr=""),
    ]
    status = inspect_claude_account("/bin/claude", {"PATH": "/bin", "ANTHROPIC_API_KEY": "secret"})
    assert status.effective_auth_mode == EffectiveAuthMode.UNKNOWN
    assert status.billing_evidence == BillingEvidence.UNVERIFIED
    assert all("ANTHROPIC_API_KEY" not in call.kwargs["env"] for call in run.call_args_list)


@patch("cohorte.adapters.claude.subprocess.run")
def test_third_party_route_is_rejected(run: Mock, tmp_path) -> None:  # type: ignore[no-untyped-def]
    run.side_effect = [
        SimpleNamespace(returncode=0, stdout="2.1.0", stderr=""),
        SimpleNamespace(returncode=0, stdout=_status_payload(apiProvider="bedrock"), stderr=""),
    ]
    with (
        patch("cohorte.adapters.claude.shutil.which", return_value="/bin/claude"),
        pytest.raises(CohorteError) as raised,
    ):
        ClaudeAdapter(tmp_path, {"PATH": "/bin"})._require_subscription()
    assert raised.value.code == ErrorCode.AUTH_MODE_MISMATCH


def test_structured_review_uses_read_only_tools_and_validates_result(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:  # type: ignore[no-untyped-def]
    options_seen = []

    class FakeResult:
        is_error = False
        result = None
        session_id = "claude-session"

        def __init__(self) -> None:
            self.structured_output = {"answer": "ok"}

    class FakeClient:
        def __init__(self, options) -> None:  # type: ignore[no-untyped-def]
            options_seen.append(options)

        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *args):  # type: ignore[no-untyped-def]
            return None

        async def query(self, prompt) -> None:  # type: ignore[no-untyped-def]
            assert prompt == "review"

        async def receive_response(self):  # type: ignore[no-untyped-def]
            yield FakeResult()

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", FakeClient)
    monkeypatch.setattr(claude_agent_sdk, "ResultMessage", FakeResult)
    adapter = ClaudeAdapter(tmp_path, {"PATH": "/bin"})
    monkeypatch.setattr(adapter, "_require_subscription", lambda: None)
    answer, session = adapter._structured_turn_with_session(tmp_path, "review", Answer, True)
    assert answer.answer == "ok"
    assert session == "claude-session"
    options = options_seen[0]
    assert options.tools == ["Read", "Grep", "Glob"]
    assert options.permission_mode == "dontAsk"
    assert {"Bash", "Edit", "Write", "Task"} <= set(options.disallowed_tools)
    assert options.setting_sources == []
    assert options.strict_mcp_config is True
    guard = options.hooks["PreToolUse"][0].hooks[0]

    async def decision(tool: str, path: str) -> str:
        result = await guard(
            {"tool_name": tool, "tool_input": {"file_path": path}}, None, {"signal": None}
        )
        return result["hookSpecificOutput"]["permissionDecision"]

    assert asyncio.run(decision("Edit", "src/file.py")) == "deny"
    assert asyncio.run(decision("Read", "../outside")) == "deny"
    assert asyncio.run(decision("Read", "src/file.py")) == "allow"

    adapter._structured_turn_with_session(tmp_path, "review", Answer, False)
    write_guard = options_seen[1].hooks["PreToolUse"][0].hooks[0]

    async def write_decision(path: str) -> str:
        result = await write_guard(
            {"tool_name": "Edit", "tool_input": {"file_path": path}}, None, {"signal": None}
        )
        return result["hookSpecificOutput"]["permissionDecision"]

    assert asyncio.run(write_decision("src/file.py")) == "allow"
    assert asyncio.run(write_decision("../outside")) == "deny"
    (tmp_path / "escape").symlink_to(tmp_path.parent)
    assert asyncio.run(write_decision("escape/outside")) == "deny"


def test_profile_selects_claude_runtime(tmp_path) -> None:  # type: ignore[no-untyped-def]
    profile = ProjectProfile(
        project_id="sample",
        name="Sample",
        language="fr",
        vcs=VcsConfig(),
        surfaces=[Surface(id="core", label="Core", paths=["src"], role_profile="implementer")],
        agent_defaults=AgentDefaults(provider=Provider.CLAUDE),
    )
    assert isinstance(workflow_runtime(tmp_path, profile), ClaudeAdapter)
