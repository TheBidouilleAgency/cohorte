from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from cohorte.application.retrospective import (
    RetroRuleSuggestion,
    RetroSuggestions,
    mine_review_patterns,
    proposal_from_pattern,
    suggest_retro_rules,
)
from cohorte.cli import main as cli
from cohorte.domain.models import (
    AgentDefaults,
    ProjectProfile,
    Provider,
    RunState,
    RunStatus,
    Stage,
    Surface,
    VcsConfig,
)
from cohorte.persistence.sqlite import Database


def profile() -> ProjectProfile:
    return ProjectProfile(
        project_id="retro-demo",
        name="Retro demo",
        language="fr",
        vcs=VcsConfig(),
        surfaces=[Surface(id="api", label="API", paths=["src/api"], role_profile="backend")],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )


def review_event(db: Database, feature_id: str, run_id: str, message: str) -> None:
    now = datetime.now(UTC)
    db.ensure_feature(feature_id, "retro-demo", feature_id)
    db.create_run(
        RunState(
            id=run_id,
            project_id="retro-demo",
            feature_id=feature_id,
            stage=Stage.REVIEW,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit="a" * 40,
            created_at=now,
            updated_at=now,
        )
    )
    db.append_event(
        "phase.review.completed",
        {"findings": [{"severity": "high", "path": "src/api/routes.py", "message": message}]},
        project_id="retro-demo",
        run_id=run_id,
    )


def test_mines_only_cross_feature_review_patterns(tmp_path: Path) -> None:
    db = Database(tmp_path / "state.sqlite3")
    db.register_project("retro-demo", str(tmp_path), "profile")
    review_event(db, "first", "run-1", "Missing authorization check")
    assert mine_review_patterns(db, profile()) == []
    review_event(db, "second", "run-2", "Missing route authorization")

    patterns = mine_review_patterns(db, profile())
    assert len(patterns) == 1
    assert patterns[0].surface_id == "api"
    assert patterns[0].category == "security"
    assert {item.feature_id for item in patterns[0].evidence} == {"first", "second"}
    proposal = proposal_from_pattern(
        patterns[0], "retro-auth", "Every API route checks authorization."
    )
    assert len(proposal.evidence_fingerprints) == 2
    db.close()


def test_retro_agent_suggestions_remain_advisory_and_bound_to_patterns(tmp_path: Path) -> None:
    db = Database(tmp_path / "state.sqlite3")
    db.register_project("retro-demo", str(tmp_path), "profile")
    review_event(db, "first", "run-1", "Missing authorization check")
    review_event(db, "second", "run-2", "Missing route authorization")
    patterns = mine_review_patterns(db, profile())

    class Runtime:
        def retro_suggestions(self, workspace: Path, prompt: str) -> RetroSuggestions:
            assert "Missing route authorization" in prompt
            return RetroSuggestions(
                suggestions=[
                    RetroRuleSuggestion(
                        pattern_id=patterns[0].id,
                        rule="Every API route checks authorization before executing.",
                        rationale="Two features repeated the same missing check.",
                        caveat="Review route exceptions before ratification.",
                    )
                ]
            )

    suggestions = suggest_retro_rules(Runtime(), tmp_path, profile(), patterns)
    assert suggestions.suggestions[0].pattern_id == patterns[0].id
    assert profile().conventions == []
    db.close()


def test_retro_cli_ratification_updates_active_project_profile(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    repository = tmp_path / "retro-demo"
    repository.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    db = Database(data / "cohorte.sqlite3")
    project_profile = profile()
    stored = db.put_artifact("project-profile", project_profile.model_dump_json().encode())
    db.register_project("retro-demo", str(repository), stored["id"])
    review_event(db, "first", "run-1", "Missing authorization check")
    review_event(db, "second", "run-2", "Missing route authorization")
    pattern_id = mine_review_patterns(db, project_profile)[0].id
    db.close()
    monkeypatch.chdir(repository)

    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data),
                "retro",
                "--pattern",
                pattern_id,
                "--rule",
                "Every API route checks authorization before its handler.",
                "--manual",
            ]
        )
        == 0
    )
    proposed = json.loads(capsys.readouterr().out)["data"]
    db = Database(data / "cohorte.sqlite3")
    request = db.get_request(proposed["ratification_request_id"])
    answer = db.respond_request(
        request["id"], "accept-retro", {"approved": True}, request["subject_hash"]
    )
    db.close()
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(project_profile.model_dump_json())
    output = tmp_path / "updated-profile.json"
    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data),
                "retro-apply",
                proposed["output"],
                "--profile",
                str(profile_path),
                "--decision-id",
                answer["decision_id"],
                "--output",
                str(output),
            ]
        )
        == 0
    )
    capsys.readouterr()
    db = Database(data / "cohorte.sqlite3")
    active = db.get_project("retro-demo")
    assert active["profile"]["conventions"] == [
        "Every API route checks authorization before its handler."
    ]
    assert active["profile_ref"]["revision"] == 2
    db.close()
