from __future__ import annotations

import builtins
import json
import sys
from pathlib import Path

from cohorte.application.intake import IntakeProposal, IntakeTriage
from cohorte.application.preparation import (
    BrainstormContribution,
    BrainstormPerspectiveTurn,
    BrainstormSynthesis,
    BrainstormSynthesisTurn,
)
from cohorte.application.service import CohorteService
from cohorte.cli import main as cli
from cohorte.persistence.sqlite import Database


def test_guided_intake_and_project_status(tmp_path: Path, monkeypatch, capsys) -> None:
    project = tmp_path / "project"
    project.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()
    monkeypatch.chdir(project)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    answers = iter(["texte", "Ajouter un export sécurisé"])
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert cli.run(["--data-dir", str(data), "intake", "--manual"]) == 0
    result = capsys.readouterr().out
    assert "Suite suggérée : cohorte brainstorm" in result

    assert cli.run(["--data-dir", str(data), "status"]) == 0
    dashboard = capsys.readouterr().out
    assert "Projet project · 1 fonctionnalités" in dashboard
    assert "intake-" in dashboard


def test_guided_intake_stores_project_aware_agent_proposal(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()
    monkeypatch.chdir(project)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(
        "cohorte.cli.guided_intake.propose_intake",
        lambda _project, _source: IntakeProposal(
            route=IntakeTriage.FEATURE,
            rationale="The requested export does not exist",
            suspected_surfaces=["project"],
            questions=[],
            patch_seed="",
            feature_seed="Add a safe export",
            caveat="Confirm intended users",
        ),
    )
    assert cli.run(["--data-dir", str(data), "intake", "--text", "Ajouter un export sécurisé"]) == 0
    output = capsys.readouterr().out
    assert "Piste de l'agent : feature" in output
    stored = Database(data / "cohorte.sqlite3")
    feature_id = stored.list_features("project")[0]["id"]
    assert stored.latest_artifact(f"proposal:intake:{feature_id}")["revision"] == 1
    stored.close()


def test_intake_json_requires_explicit_source(tmp_path: Path, monkeypatch, capsys) -> None:
    project = tmp_path / "project"
    project.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()
    monkeypatch.chdir(project)

    try:
        cli.run(["--json", "--data-dir", str(data), "intake"])
    except SystemExit as error:
        assert error.code == 3
    else:
        raise AssertionError("missing source should fail without prompting")
    assert "--text, --file or --url" in capsys.readouterr().out


def test_intake_answers_are_versioned_and_passed_to_brainstorm(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "onboarding.py").write_text("def onboarding_entry(): return 'first path'\n")
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()
    monkeypatch.chdir(project)

    assert (
        cli.run(["--json", "--data-dir", str(data), "intake", "--text", "Onboarding is missing"])
        == 0
    )
    first = json.loads(capsys.readouterr().out)["data"]
    feature_id = first["feature_id"]
    questions = first["report"]["questions"]
    assert first["report_ref"]["revision"] == 1
    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data),
                "intake",
                "--continue",
                feature_id,
                "--answer",
                "1=New accounts need a welcome path",
                "--route",
                "feature",
            ]
        )
        == 0
    )
    second = json.loads(capsys.readouterr().out)["data"]
    assert second["report_ref"]["revision"] == 2
    assert second["report"]["answers"] == [
        {"question": questions[0], "answer": "New accounts need a welcome path"}
    ]
    assert second["report"]["questions"] == questions[1:]
    assert second["report"]["previous_report_ref"] == first["report_ref"]
    assert (
        cli.run(["--json", "--data-dir", str(data), "intake", "--text", "Onboarding is missing"])
        == 0
    )
    repeated = json.loads(capsys.readouterr().out)["data"]
    assert repeated["report_ref"] == second["report_ref"]

    prompts: list[str] = []

    class Runtime:
        def brainstorm_perspective(self, _workspace: Path, prompt: str, perspective: str):
            prompts.append(prompt)
            return BrainstormPerspectiveTurn(
                session_ref=f"session-{perspective}",
                contribution=BrainstormContribution(
                    contribution_id=perspective,
                    perspective=perspective,
                    problem="No welcome path",
                    assumptions=[],
                    alternatives=[],
                    risks=[],
                    questions=[],
                    disagreements=[],
                ),
            )

        def brainstorm_synthesis(self, _workspace: Path, prompt: str):
            prompts.append(prompt)
            return BrainstormSynthesisTurn(
                session_ref="session-synthesis",
                synthesis=BrainstormSynthesis(
                    contribution_refs=["product", "architecture", "qa", "security"],
                    problem="No welcome path",
                    beneficiaries=[],
                    in_scope=[],
                    out_of_scope=[],
                    options=[],
                    recommendation="Scope a path",
                    divergences=[],
                    strong_objections=[],
                    blocking_questions=[],
                    non_blocking_questions=[],
                    criterion_leads=[],
                ),
            )

    monkeypatch.setattr(cli, "CodexAdapter", lambda *_args, **_kwargs: Runtime())
    assert (
        cli.run(
            ["--json", "--data-dir", str(data), "brainstorm", "--from-intake", feature_id, "--live"]
        )
        == 0
    )
    brief = json.loads(capsys.readouterr().out)["data"]["brief"]
    assert brief["feature_id"] == feature_id
    assert brief["intake_ref"] == second["report_ref"]
    assert any("New accounts need a welcome path" in answer for answer in brief["user_answers"])
    assert first["report"]["source_sha256"] in brief["project_context"]
    assert "Onboarding is missing" in brief["project_context"]
    assert "onboarding.py:1" in brief["project_context"]
    assert "first path" in brief["project_context"]
    assert all("untrusted data" in prompt for prompt in prompts)
    assert all("onboarding.py:1" in prompt for prompt in prompts)
    (project / "onboarding.py").write_text("def onboarding_entry(): return 'second path'\n")
    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data),
                "brainstorm",
                "--continue",
                feature_id,
                "--answer",
                "New accounts should follow the second path",
                "--live",
            ]
        )
        == 0
    )
    continued = json.loads(capsys.readouterr().out)["data"]
    assert continued["brief_ref"]["revision"] == 2
    assert "second path" in continued["brief"]["project_context"]
    assert "first path" not in continued["brief"]["project_context"]
    stored = Database(data / "cohorte.sqlite3")
    assert stored.get_feature(feature_id)["kind"] == "feature"
    stored.close()
