from __future__ import annotations

from datetime import UTC, datetime

import pytest

from cohorte.application.durable import record_run_error
from cohorte.domain.auth import (
    AccountStatus,
    BillingEvidence,
    Capability,
    CapabilitySet,
    ConnectionState,
    EffectiveAuthMode,
    Quota,
    QuotaState,
    require_subscription,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database


def _capabilities() -> CapabilitySet:
    supported = Capability(support="supported")
    return CapabilitySet(
        structured_output=supported,
        streaming=supported,
        tool_permissions=supported,
        user_questions=supported,
        interrupt=supported,
        session_resume=supported,
        read_only_role=supported,
        native_auth_status=supported,
        model_catalog=supported,
        usage_reporting=supported,
    )


@pytest.mark.parametrize(
    ("connection", "quota", "expected_code", "expected_status", "event_type"),
    [
        (
            ConnectionState.EXPIRED,
            QuotaState.UNKNOWN,
            ErrorCode.AUTH_REQUIRED,
            RunStatus.WAITING_AUTH,
            "run.waiting_auth",
        ),
        (
            ConnectionState.CONNECTED,
            QuotaState.EXHAUSTED,
            ErrorCode.QUOTA_EXHAUSTED,
            RunStatus.WAITING_QUOTA,
            "run.waiting_quota",
        ),
    ],
)
def test_auth_and_quota_failures_suspend_run_without_losing_results(
    tmp_path, connection, quota, expected_code, expected_status, event_type
) -> None:
    database = Database(tmp_path / "state.sqlite3")
    database.register_project("project", str(tmp_path), "profile")
    now = datetime.now(UTC)
    candidate_hash = "b" * 64
    database.create_run(
        RunState(
            id="provider-run",
            project_id="project",
            feature_id="feature",
            stage=Stage.REVIEW,
            status=RunStatus.RUNNING,
            state_version=4,
            base_commit="a" * 40,
            candidate_tree_hash=candidate_hash,
            created_at=now,
            updated_at=now,
        )
    )
    status = AccountStatus(
        account_id="codex-native",
        connection_state=connection,
        effective_auth_mode=EffectiveAuthMode.SUBSCRIPTION,
        billing_evidence=BillingEvidence.RUNTIME_REPORTED,
        capabilities=_capabilities(),
        checked_at=now,
        quota=Quota(state=quota),
    )

    with pytest.raises(CohorteError) as caught:
        require_subscription(status)
    assert caught.value.code == expected_code
    record_run_error(database, "provider-run", caught.value)

    preserved = database.get_run("provider-run")
    assert preserved.status == expected_status
    assert preserved.stage == Stage.REVIEW
    assert preserved.candidate_tree_hash == candidate_hash
    assert preserved.state_version == 5
    event = database.latest_event("provider-run", event_type)
    assert event["data"]["code"] == expected_code.value
    database.close()


def test_uncertain_termination_blocks_run_and_preserves_candidate(tmp_path) -> None:
    database = Database(tmp_path / "state.sqlite3")
    database.register_project("project", str(tmp_path), "profile")
    now = datetime.now(UTC)
    state = RunState(
        id="uncertain-run",
        project_id="project",
        feature_id="feature",
        stage=Stage.BUILD,
        status=RunStatus.RUNNING,
        state_version=1,
        base_commit="a" * 40,
        candidate_tree_hash="b" * 64,
        created_at=now,
        updated_at=now,
    )
    database.create_run(state)
    error = CohorteError(
        ErrorCode.EFFECT_UNCERTAIN,
        "descendant termination was not proven",
        "resume is unsafe",
    )

    record_run_error(database, state.id, error)

    blocked = database.get_run(state.id)
    assert blocked.status == RunStatus.BLOCKED_UNCERTAIN
    assert blocked.candidate_tree_hash == state.candidate_tree_hash
    assert database.latest_event(state.id, "run.effect_uncertain")["data"]["code"] == (
        ErrorCode.EFFECT_UNCERTAIN.value
    )
    database.close()
