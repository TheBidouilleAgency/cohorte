from __future__ import annotations

from datetime import UTC, datetime

import pytest

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


def capabilities() -> CapabilitySet:
    value = Capability(support="supported")
    return CapabilitySet(
        structured_output=value,
        streaming=value,
        tool_permissions=value,
        user_questions=value,
        interrupt=value,
        session_resume=value,
        read_only_role=value,
        native_auth_status=value,
        model_catalog=value,
        usage_reporting=value,
    )


def status(mode: EffectiveAuthMode, quota: QuotaState = QuotaState.AVAILABLE) -> AccountStatus:
    return AccountStatus(
        account_id="account",
        connection_state=ConnectionState.CONNECTED,
        effective_auth_mode=mode,
        billing_evidence=BillingEvidence.RUNTIME_REPORTED,
        capabilities=capabilities(),
        checked_at=datetime.now(UTC),
        quota=Quota(state=quota),
    )


def test_subscription_gate_accepts_only_verified_subscription() -> None:
    require_subscription(status(EffectiveAuthMode.SUBSCRIPTION))
    for mode, code in [
        (EffectiveAuthMode.UNKNOWN, ErrorCode.AUTH_MODE_UNVERIFIED),
        (EffectiveAuthMode.API, ErrorCode.AUTH_MODE_MISMATCH),
        (EffectiveAuthMode.THIRD_PARTY, ErrorCode.AUTH_MODE_MISMATCH),
    ]:
        with pytest.raises(CohorteError) as caught:
            require_subscription(status(mode))
        assert caught.value.code == code


def test_exhausted_quota_never_falls_back() -> None:
    with pytest.raises(CohorteError) as caught:
        require_subscription(status(EffectiveAuthMode.SUBSCRIPTION, QuotaState.EXHAUSTED))
    assert caught.value.code == ErrorCode.QUOTA_EXHAUSTED
