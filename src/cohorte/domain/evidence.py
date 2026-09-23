from __future__ import annotations

import hashlib
from enum import StrEnum

from pydantic import Field

from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import Sha256, StrictModel


class CheckStatus(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    ERRORED = "errored"
    NOT_RUN = "not_run"


class ReviewVerdict(StrEnum):
    READY = "ready"
    FIX = "fix"
    BLOCKED = "blocked"


class EvidenceIdentity(StrictModel):
    base_commit: str = Field(pattern=r"^[a-f0-9]{40,64}$")
    candidate_tree_hash: Sha256
    spec_hash: Sha256
    profile_hash: Sha256
    check_config_hash: Sha256

    @property
    def digest(self) -> str:
        material = "\0".join(
            [
                self.base_commit,
                self.candidate_tree_hash,
                self.spec_hash,
                self.profile_hash,
                self.check_config_hash,
            ]
        )
        return hashlib.sha256(material.encode()).hexdigest()


class CheckEvidence(StrictModel):
    check_id: str
    required: bool
    status: CheckStatus
    evidence_digest: Sha256


class ReviewEvidence(StrictModel):
    verdict: ReviewVerdict
    evidence_digest: Sha256
    covered_surfaces: list[str]
    unreviewed_surfaces: list[str]
    blocking_findings: list[str]


def require_shippable(
    identity: EvidenceIdentity,
    checks: list[CheckEvidence],
    review: ReviewEvidence,
    required_surfaces: set[str],
) -> None:
    stale = [check.check_id for check in checks if check.evidence_digest != identity.digest]
    if review.evidence_digest != identity.digest:
        stale.append("review")
    if stale:
        raise CohorteError(
            ErrorCode.SPEC_STALE,
            f"evidence is stale: {', '.join(stale)}",
            "delivery is blocked",
            remediation="rerun checks and review for the exact candidate",
        )
    failed = [
        check.check_id for check in checks if check.required and check.status != CheckStatus.PASSED
    ]
    if failed:
        raise CohorteError(
            ErrorCode.CHECK_FAILED,
            f"required checks are not passing: {', '.join(failed)}",
            "delivery is blocked",
            remediation="fix the candidate and rerun required checks",
        )
    if set(review.covered_surfaces) != required_surfaces or review.unreviewed_surfaces:
        raise CohorteError(
            ErrorCode.REVIEW_INCOMPLETE,
            "review does not cover every required surface",
            "delivery is blocked",
            remediation="run independent review for the missing surfaces",
        )
    if review.verdict != ReviewVerdict.READY or review.blocking_findings:
        raise CohorteError(
            ErrorCode.REVIEW_INCOMPLETE,
            "review has not produced a blocker-free ready verdict",
            "delivery is blocked",
            remediation="complete the fix and independent re-review cycle",
        )
