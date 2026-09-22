from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    AUTH_REQUIRED = "AUTH_REQUIRED"
    AUTH_BUSY = "AUTH_BUSY"
    AUTH_MODE_MISMATCH = "AUTH_MODE_MISMATCH"
    AUTH_MODE_UNVERIFIED = "AUTH_MODE_UNVERIFIED"
    ACCOUNT_IN_USE = "ACCOUNT_IN_USE"
    MULTI_ACCOUNT_UNSUPPORTED = "MULTI_ACCOUNT_UNSUPPORTED"
    QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    RUNTIME_INCOMPATIBLE = "RUNTIME_INCOMPATIBLE"
    CAPABILITY_MISSING = "CAPABILITY_MISSING"
    OUTPUT_INVALID = "OUTPUT_INVALID"
    SPEC_NOT_FROZEN = "SPEC_NOT_FROZEN"
    REPRODUCTION_MISSING = "REPRODUCTION_MISSING"
    AUDIT_MUTATION = "AUDIT_MUTATION"
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    DESIGN_UNAVAILABLE = "DESIGN_UNAVAILABLE"
    RETRIEVAL_UNAVAILABLE = "RETRIEVAL_UNAVAILABLE"
    PROJECTION_UNAVAILABLE = "PROJECTION_UNAVAILABLE"
    SPEC_STALE = "SPEC_STALE"
    PROFILE_INVALID = "PROFILE_INVALID"
    OWNERSHIP_VIOLATION = "OWNERSHIP_VIOLATION"
    CHECK_FAILED = "CHECK_FAILED"
    CHECK_ENVIRONMENT = "CHECK_ENVIRONMENT"
    REVIEW_INCOMPLETE = "REVIEW_INCOMPLETE"
    MERGE_CONFLICT = "MERGE_CONFLICT"
    EFFECT_UNCERTAIN = "EFFECT_UNCERTAIN"
    WORKER_NOT_STOPPED = "WORKER_NOT_STOPPED"
    PERMISSION_DENIED = "PERMISSION_DENIED"
    VERSION_CONFLICT = "VERSION_CONFLICT"
    REQUEST_ALREADY_RESOLVED = "REQUEST_ALREADY_RESOLVED"
    CURSOR_EXPIRED = "CURSOR_EXPIRED"
    ARTIFACT_CORRUPT = "ARTIFACT_CORRUPT"
    PROTOCOL_INCOMPATIBLE = "PROTOCOL_INCOMPATIBLE"


@dataclass(slots=True)
class CohorteError(Exception):
    code: ErrorCode
    message: str
    impact: str
    retryable: bool = False
    remediation: str = ""
    details: dict[str, Any] | None = None

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def as_data(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "code": self.code.value,
            "message": self.message,
            "impact": self.impact,
            "retryable": self.retryable,
            "remediation": self.remediation,
        }
        if self.details is not None:
            data["details"] = self.details
        return data
