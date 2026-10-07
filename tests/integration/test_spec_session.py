from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from test_guided_feature import _setup

from cohorte.application.preparation import (
    BrainstormBrief,
    SpecCriterionSuggestion,
    SpecProposal,
    SpecQuestionSuggestion,
    StandingDecisionCandidate,
    canonical_model_bytes,
)
from cohorte.cli import main as cli
from cohorte.cli import spec_session
from cohorte.domain.models import Scenario
from cohorte.persistence.sqlite import Database


def _proposal(title: str) -> SpecProposal:
    return SpecProposal(
        title=title,
        response_to_feedback="JSON keeps the export local and readable." if "JSON" in title else "",
        in_scope=["Write one complete local export"],
        out_of_scope=["Cloud upload"],
        question_suggestions=[
            SpecQuestionSuggestion(
                question="Which format?", suggestion="JSON", caveat="Confirm consumers"
            )
        ],
        scenarios=[
            Scenario(id="export", given="data exists", when="export runs", then="one file exists")
        ],
        acceptance=[
            SpecCriterionSuggestion(statement="Export is atomic", surface_id="api", check_id="test")
        ],
        test_strategy=["Run test"],
        error_cases=["Disk full"],
        migrations_required=False,
        migrations="No migration",
        rollback="Revert export",
    )


def _call(data_dir: Path, repository: Path, capsys: pytest.CaptureFixture[str], *args: str) -> dict:
    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data_dir),
                "spec-session",
                "safe-export",
                *args,
                "--repo",
                str(repository),
            ]
        )
        == 0
    )
    return json.loads(capsys.readouterr().out)["data"]


def test_spec_session_discusses_proposal_then_requires_exact_freeze_approval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repository, data_dir = _setup(tmp_path, blocking=True)
    database = Database(data_dir / "cohorte.sqlite3")
    try:
        saved = database.latest_artifact("brief:safe-export")
        brief = BrainstormBrief.model_validate_json(saved["content"])
        synthesis = brief.synthesis.model_copy(
            update={
                "standing_decision_candidates": [
                    StandingDecisionCandidate(
                        area="export",
                        decision="Keep exports local",
                        reason="privacy",
                        source_answer="Keep data local",
                    )
                ]
            }
        )
        database.put_artifact(
            "brainstorm-brief",
            canonical_model_bytes(brief.model_copy(update={"synthesis": synthesis})),
            artifact_id="brief:safe-export",
        )
    finally:
        database.close()
    seen: list[tuple[list[str] | None, str | None]] = []

    def propose(_brief, _profile, _repository, _draft, feedback, previous):
        seen.append((feedback, previous.title if previous else None))
        return _proposal("Export with JSON" if feedback else "Export safely")

    monkeypatch.setattr(spec_session, "_propose_spec", propose)
    initial = _call(data_dir, repository, capsys, "show")
    assert initial["proposal"] is None
    first = _call(data_dir, repository, capsys, "propose")
    assert first["approved"] is False
    assert first["proposal_ref"]["revision"] == 1
    discussed = _call(data_dir, repository, capsys, "propose", "--message", "What about JSON?")
    assert discussed["proposal"]["title"] == "Export with JSON"
    assert "readable" in discussed["proposal"]["response_to_feedback"]
    assert discussed["feedback"] == ["What about JSON?"]
    assert seen[-1] == (["What about JSON?"], "Export safely")
    shown = _call(data_dir, repository, capsys, "show")
    assert shown["proposal_ref"]["revision"] == 2
    assert shown["draft"] is None
    accepted = _call(
        data_dir,
        repository,
        capsys,
        "accept",
        "--answer",
        "1=JSON",
        "--expect-proposal-revision",
        "2",
        "--expect-draft-revision",
        "0",
    )
    assert accepted["draft"]["open_questions"] == []
    assert "What about JSON?" not in accepted["draft"]["problem"]
    preparation_result = _call(data_dir, repository, capsys, "prepare")
    prepared = preparation_result["preparation"]
    assert preparation_result["candidate"]["status"] == "frozen"
    assert (
        hashlib.sha256(
            json.dumps(
                preparation_result["candidate"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        == prepared["spec_hash"]
    )
    assert preparation_result["profile_snapshot"]["project_id"] == "project"
    with pytest.raises(SystemExit) as stale:
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data_dir),
                "spec-session",
                "safe-export",
                "freeze",
                "--repo",
                str(repository),
                "--request-id",
                prepared["request_id"],
                "--spec-hash",
                "0" * 64,
                "--profile-hash",
                prepared["profile_hash"],
            ]
        )
    assert stale.value.code == 3
    assert "request a fresh approval" in capsys.readouterr().out
    frozen = _call(
        data_dir,
        repository,
        capsys,
        "freeze",
        "--request-id",
        prepared["request_id"],
        "--spec-hash",
        prepared["spec_hash"],
        "--profile-hash",
        prepared["profile_hash"],
    )
    assert frozen["spec"]["status"] == "frozen"
    frozen_state = _call(data_dir, repository, capsys, "show")
    assert frozen_state["feature_status"] == "frozen"
    assert frozen_state["standing_candidates"][0]["decision"] == "Keep exports local"
    kept = _call(data_dir, repository, capsys, "ratify", "--candidate-index", "1")
    assert "Keep exports local" in kept["entry"]
    assert _call(data_dir, repository, capsys, "show")["standing_candidates"] == []
