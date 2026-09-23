from __future__ import annotations

import pytest

from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import (
    CheckEvidence,
    CheckStatus,
    EvidenceIdentity,
    ReviewEvidence,
    ReviewVerdict,
    require_shippable,
)


def identity() -> EvidenceIdentity:
    return EvidenceIdentity(
        base_commit="a" * 40,
        candidate_tree_hash="b" * 64,
        spec_hash="c" * 64,
        profile_hash="d" * 64,
        check_config_hash="e" * 64,
    )


def test_ship_gate_accepts_exact_complete_evidence() -> None:
    target = identity()
    checks = [
        CheckEvidence(
            check_id="unit",
            required=True,
            status=CheckStatus.PASSED,
            evidence_digest=target.digest,
        )
    ]
    review = ReviewEvidence(
        verdict=ReviewVerdict.READY,
        evidence_digest=target.digest,
        covered_surfaces=["backend"],
        unreviewed_surfaces=[],
        blocking_findings=[],
    )
    require_shippable(target, checks, review, {"backend"})


def test_ship_gate_rejects_stale_proof() -> None:
    target = identity()
    check = CheckEvidence(
        check_id="unit", required=True, status=CheckStatus.PASSED, evidence_digest="f" * 64
    )
    review = ReviewEvidence(
        verdict=ReviewVerdict.READY,
        evidence_digest=target.digest,
        covered_surfaces=["backend"],
        unreviewed_surfaces=[],
        blocking_findings=[],
    )
    with pytest.raises(CohorteError) as caught:
        require_shippable(target, [check], review, {"backend"})
    assert caught.value.code == ErrorCode.SPEC_STALE


def test_ship_gate_rejects_dead_reviewer_surface() -> None:
    target = identity()
    review = ReviewEvidence(
        verdict=ReviewVerdict.BLOCKED,
        evidence_digest=target.digest,
        covered_surfaces=[],
        unreviewed_surfaces=["backend"],
        blocking_findings=[],
    )
    with pytest.raises(CohorteError) as caught:
        require_shippable(target, [], review, {"backend"})
    assert caught.value.code == ErrorCode.REVIEW_INCOMPLETE
