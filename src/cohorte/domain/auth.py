from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import Field

from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import Provider, StrictModel


class ConnectionState(StrEnum):
    NOT_CONFIGURED = "not_configured"
    LOGIN_REQUIRED = "login_required"
    LOGIN_IN_PROGRESS = "login_in_progress"
    CONNECTED = "connected"
    EXPIRED = "expired"
    REFRESHING = "refreshing"
    UNAVAILABLE = "unavailable"
    ERROR = "error"


class EffectiveAuthMode(StrEnum):
    SUBSCRIPTION = "subscription"
    API = "api"
    THIRD_PARTY = "third_party"
    UNKNOWN = "unknown"


class BillingEvidence(StrEnum):
    PROVIDER_REPORTED = "provider_reported"
    RUNTIME_REPORTED = "runtime_reported"
    CONFIGURATION_ONLY = "configuration_only"
    UNVERIFIED = "unverified"


class QuotaState(StrEnum):
    UNKNOWN = "unknown"
    AVAILABLE = "available"
    LIMITED = "limited"
    EXHAUSTED = "exhausted"


class AccountRef(StrictModel):
    id: str = Field(min_length=1)
    provider: Provider
    label: str = Field(min_length=1, max_length=200)
    native_context_ref: str = Field(min_length=1)
    desired_auth_mode: Literal["subscription_only"] = "subscription_only"
    default_model: str | None = None
    created_at: datetime
    last_verified_at: datetime | None = None


class Capability(StrictModel):
    support: Literal["supported", "unsupported", "unknown"]
    version: str | None = None
    limitations: list[str] = Field(default_factory=list)


class CapabilitySet(StrictModel):
    structured_output: Capability
    streaming: Capability
    tool_permissions: Capability
    user_questions: Capability
    interrupt: Capability
    session_resume: Capability
    read_only_role: Capability
    native_auth_status: Capability
    model_catalog: Capability
    usage_reporting: Capability


class Quota(StrictModel):
    state: QuotaState = QuotaState.UNKNOWN
    remaining_percent: float | None = Field(default=None, ge=0, le=100)
    remaining_units: float | None = Field(default=None, ge=0)
    reset_at: datetime | None = None
    source: str | None = None
    measured_at: datetime | None = None


class AccountStatus(StrictModel):
    account_id: str
    connection_state: ConnectionState
    effective_auth_mode: EffectiveAuthMode
    billing_evidence: BillingEvidence
    capabilities: CapabilitySet
    runtime_version: str | None = None
    checked_at: datetime
    account_label: str | None = None
    quota: Quota = Field(default_factory=Quota)


def require_subscription(status: AccountStatus) -> None:
    if status.connection_state != ConnectionState.CONNECTED:
        raise CohorteError(
            ErrorCode.AUTH_REQUIRED,
            "provider account is not connected",
            "the phase cannot start",
            remediation="complete the official provider login and verify the account",
        )
    if status.effective_auth_mode == EffectiveAuthMode.UNKNOWN:
        raise CohorteError(
            ErrorCode.AUTH_MODE_UNVERIFIED,
            "subscription routing could not be verified",
            "the phase cannot start in subscription_only mode",
            remediation="run an explicit live account verification",
        )
    if status.effective_auth_mode != EffectiveAuthMode.SUBSCRIPTION:
        raise CohorteError(
            ErrorCode.AUTH_MODE_MISMATCH,
            f"effective mode is {status.effective_auth_mode.value}",
            "the phase cannot start in subscription_only mode",
            remediation="remove conflicting API or gateway routing and verify again",
        )
    if status.quota.state == QuotaState.EXHAUSTED:
        raise CohorteError(
            ErrorCode.QUOTA_EXHAUSTED,
            "provider quota is exhausted",
            "new tasks are suspended; completed results are preserved",
            retryable=status.quota.reset_at is not None,
            remediation="wait for a verified reset or explicitly select another account",
        )
