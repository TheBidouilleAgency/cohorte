from __future__ import annotations

import signal
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from openai_codex import ServerBusyError

from cohorte.adapters.codex import (
    CodexAdapter,
    bounded_provider_call,
    inspect_codex_account,
    sanitized_provider_env,
    strict_output_schema,
)
from cohorte.domain.auth import (
    AccountStatus,
    BillingEvidence,
    ConnectionState,
    EffectiveAuthMode,
    Quota,
    QuotaState,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import ReviewVerdict


def test_sanitized_environment_removes_api_routing() -> None:
    env = sanitized_provider_env(
        {
            "PATH": "/bin",
            "OPENAI_API_KEY": "secret",
            "OPENAI_BASE_URL": "https://gateway.example",
            "AZURE_OPENAI_API_KEY": "secret",
        }
    )
    assert env == {"PATH": "/bin"}


def test_strict_output_schema_requires_every_property_recursively() -> None:
    schema = {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "nested": {
                "type": "object",
                "properties": {"value": {"type": "string", "default": ""}},
            },
        },
        "required": ["summary"],
    }

    result = strict_output_schema(schema)

    assert result["required"] == ["summary", "nested"]
    assert result["additionalProperties"] is False
    assert result["properties"]["nested"]["required"] == ["value"]


@patch("cohorte.adapters.codex.subprocess.run")
def test_passive_status_recognizes_chatgpt_without_exposing_output(run: Mock) -> None:
    run.side_effect = [
        SimpleNamespace(returncode=0, stdout="codex-cli 0.155.1", stderr=""),
        SimpleNamespace(returncode=0, stdout="Logged in using ChatGPT", stderr=""),
    ]
    status = inspect_codex_account("/usr/bin/codex")
    assert status.connection_state == ConnectionState.CONNECTED
    assert status.effective_auth_mode == EffectiveAuthMode.SUBSCRIPTION
    assert status.billing_evidence == BillingEvidence.RUNTIME_REPORTED
    assert "ChatGPT" not in status.model_dump_json()


def subscription_status() -> AccountStatus:
    from cohorte.adapters.codex import codex_capabilities

    return AccountStatus(
        account_id="codex-native",
        connection_state=ConnectionState.CONNECTED,
        effective_auth_mode=EffectiveAuthMode.SUBSCRIPTION,
        billing_evidence=BillingEvidence.RUNTIME_REPORTED,
        capabilities=codex_capabilities("0.155.1"),
        runtime_version="0.155.1",
        checked_at=datetime.now(UTC),
    )


@patch("cohorte.adapters.codex.inspect_codex_account", side_effect=subscription_status)
@patch("cohorte.adapters.codex.Codex")
def test_review_parses_strict_json_enum(codex_class: Mock, _inspect: Mock, tmp_path) -> None:
    client = codex_class.return_value.__enter__.return_value
    client.thread_start.return_value.run.return_value = SimpleNamespace(
        final_response='{"verdict":"ready","covered_surfaces":["core"],"findings":[]}',
        status=SimpleNamespace(value="completed"),
    )

    review = CodexAdapter(tmp_path).review(tmp_path, "review")

    assert review.verdict == ReviewVerdict.READY


@patch("cohorte.adapters.codex.inspect_codex_account", side_effect=subscription_status)
@patch("cohorte.adapters.codex.Codex")
def test_live_probe_is_read_only_ephemeral_and_deny_all(
    codex_class: Mock, _inspect: Mock, tmp_path
) -> None:
    client = codex_class.return_value.__enter__.return_value
    thread = client.thread_start.return_value
    thread.run.return_value = SimpleNamespace(final_response="G0_CODEX_OK")

    result = CodexAdapter(tmp_path, {"PATH": "/bin", "OPENAI_API_KEY": "secret"}).verify_live()

    assert result["probe"] == "passed"
    assert result["effective_auth_mode"] == "subscription"
    assert codex_class.call_args.args[0].env == {"PATH": "/bin"}
    assert client.thread_start.call_args.kwargs["ephemeral"] is True
    assert client.thread_start.call_args.kwargs["sandbox"].value == "read-only"
    assert client.thread_start.call_args.kwargs["approval_mode"].value == "deny_all"


@patch("cohorte.adapters.codex.inspect_codex_account")
def test_live_probe_refuses_api_mode(inspect: Mock, tmp_path) -> None:
    value = subscription_status().model_copy(update={"effective_auth_mode": EffectiveAuthMode.API})
    inspect.return_value = value
    with pytest.raises(CohorteError) as caught:
        CodexAdapter(tmp_path).verify_live()
    assert caught.value.code == ErrorCode.AUTH_MODE_MISMATCH


@pytest.mark.parametrize(
    ("account", "expected_code"),
    [
        (
            subscription_status().model_copy(update={"connection_state": ConnectionState.EXPIRED}),
            ErrorCode.AUTH_REQUIRED,
        ),
        (
            subscription_status().model_copy(update={"quota": Quota(state=QuotaState.EXHAUSTED)}),
            ErrorCode.QUOTA_EXHAUSTED,
        ),
    ],
)
@patch("cohorte.adapters.codex.Codex")
def test_adapter_suspends_before_start_for_expired_auth_or_quota(
    codex_class: Mock, account: AccountStatus, expected_code: ErrorCode, tmp_path
) -> None:
    with (
        patch("cohorte.adapters.codex.inspect_codex_account", return_value=account),
        pytest.raises(CohorteError) as caught,
    ):
        CodexAdapter(tmp_path).verify_live()

    assert caught.value.code == expected_code
    codex_class.assert_not_called()


@patch("cohorte.adapters.codex.time.sleep")
def test_provider_retry_is_bounded_and_only_for_transient_overload(sleep: Mock) -> None:
    operation = Mock(
        side_effect=[
            ServerBusyError(-32000, "busy", {"codex_error_info": "server_overloaded"}),
            "completed",
        ]
    )

    assert bounded_provider_call(operation) == "completed"
    assert operation.call_count == 2
    sleep.assert_called_once_with(0.25)

    permanent = Mock(side_effect=RuntimeError("permanent"))
    with pytest.raises(RuntimeError, match="permanent"):
        bounded_provider_call(permanent)
    assert permanent.call_count == 1


@patch("cohorte.adapters.codex.inspect_codex_account", side_effect=subscription_status)
@patch("cohorte.adapters.codex.Codex")
def test_read_only_probe_requires_marker_to_stay_absent(
    codex_class: Mock, _inspect: Mock, tmp_path
) -> None:
    client = codex_class.return_value.__enter__.return_value
    thread = client.thread_start.return_value
    thread.run.return_value = SimpleNamespace(status=SimpleNamespace(value="completed"))
    result = CodexAdapter(tmp_path, {"PATH": "/bin"}).verify_read_only()
    assert result == {
        "capability": "read_only_role",
        "status": "passed",
        "turn_status": "completed",
        "marker_absent": True,
    }


@patch("cohorte.adapters.codex.time.sleep")
@patch("cohorte.adapters.codex._matching_process_ids", side_effect=[[123], []])
@patch("cohorte.adapters.codex.inspect_codex_account", side_effect=subscription_status)
@patch("cohorte.adapters.codex.Codex")
def test_interrupt_probe_requires_interrupted_terminal_status(
    codex_class: Mock, _inspect: Mock, _processes: Mock, sleep: Mock, tmp_path
) -> None:
    client = codex_class.return_value.__enter__.return_value
    handle = client.thread_start.return_value.turn.return_value
    handle.run.return_value = SimpleNamespace(status=SimpleNamespace(value="interrupted"))
    result = CodexAdapter(tmp_path, {"PATH": "/bin"}).verify_interrupt()
    assert result["status"] == "passed"
    assert result["descendant_termination_proven"] is True
    handle.interrupt.assert_called_once_with()
    sleep.assert_not_called()


@patch("cohorte.adapters.codex.inspect_codex_account", side_effect=subscription_status)
@patch("cohorte.adapters.codex.Codex")
def test_permission_retry_requires_two_denied_commands(
    codex_class: Mock, _inspect: Mock, tmp_path
) -> None:
    client = codex_class.return_value.__enter__.return_value
    thread = client.thread_start.return_value
    markers: list[str] = []

    def run(prompt: str, **_kwargs):
        markers.extend(part for part in prompt.split() if ".cohorte-denied-" in part)
        first = prompt.split("touch ", 1)[1].split("`", 1)[0]
        second = prompt.split("Path('", 1)[1].split("')", 1)[0]
        return SimpleNamespace(
            items=[
                SimpleNamespace(
                    command=f"touch {first}",
                    status=SimpleNamespace(value="failed"),
                    exit_code=1,
                ),
                SimpleNamespace(
                    command=f"python write {second}",
                    status=SimpleNamespace(value="declined"),
                    exit_code=None,
                ),
            ]
        )

    thread.run.side_effect = run

    result = CodexAdapter(tmp_path, {"PATH": "/bin"}).verify_permission_retry()

    assert result["attempts"] == 2
    assert result["automatic_elevation"] is False


@patch("cohorte.adapters.codex.os.kill")
@patch("cohorte.adapters.codex.inspect_codex_account", side_effect=subscription_status)
@patch("cohorte.adapters.codex.Codex")
def test_killed_reviewer_never_returns_accepted_review(
    codex_class: Mock, _inspect: Mock, kill: Mock, tmp_path
) -> None:
    client = codex_class.return_value
    client._client._proc.pid = 4321
    client.thread_start.return_value.turn.return_value.run.side_effect = RuntimeError(
        "transport closed"
    )

    result = CodexAdapter(tmp_path, {"PATH": "/bin"}).verify_reviewer_death()

    assert result["review_accepted"] is False
    expected_signal = int(getattr(signal, "SIGKILL", signal.SIGTERM))
    assert result["process_signal"] == signal.Signals(expected_signal).name
    kill.assert_called_once_with(4321, expected_signal)


@patch("cohorte.adapters.codex.inspect_codex_account", side_effect=subscription_status)
@patch("cohorte.adapters.codex.Codex")
def test_resume_probe_checks_nonce_across_clients(
    codex_class: Mock, _inspect: Mock, tmp_path
) -> None:
    client = codex_class.return_value.__enter__.return_value
    original = client.thread_start.return_value
    original.id = "thread-1"
    nonce_holder: dict[str, str] = {}

    def first_run(prompt: str, **_kwargs):
        nonce = prompt.rsplit(" ", 1)[-1]
        nonce_holder["value"] = nonce
        return SimpleNamespace(final_response=f"STORED: {nonce}")

    original.run.side_effect = first_run
    resumed = client.thread_resume.return_value
    resumed.run.side_effect = lambda *_args, **_kwargs: SimpleNamespace(
        final_response=nonce_holder["value"]
    )

    result = CodexAdapter(tmp_path, {"PATH": "/bin"}).verify_resume()
    assert result["status"] == "passed"
    assert result["thread_id"] == "thread-1"
    client.thread_resume.assert_called_once()
