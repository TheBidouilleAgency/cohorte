from __future__ import annotations

import builtins
import json
import subprocess
import sys
from pathlib import Path

import pytest

from cohorte.application.patch import PatchProposal, PatchSpec
from cohorte.application.preparation import (
    BrainstormBrief,
    BrainstormContribution,
    BrainstormSynthesis,
    SpecCriterionSuggestion,
    SpecFreezer,
    SpecProposal,
    SpecQuestionSuggestion,
    canonical_model_bytes,
)
from cohorte.application.service import CohorteService
from cohorte.application.vertical import AgentReport, AgentReview
from cohorte.cli import guided_feature
from cohorte.cli import main as cli
from cohorte.cli.guided_feature import _new_draft, guided_start, repository_head
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import (
    AgentDefaults,
    CheckDefinition,
    FeatureSpec,
    ProjectProfile,
    Provider,
    Scenario,
    Surface,
    VcsConfig,
)
from cohorte.persistence.sqlite import Database


def _setup(tmp_path: Path, *, blocking: bool = False) -> tuple[Path, Path]:
    repository = tmp_path / "repository"
    repository.mkdir()
    (repository / "src").mkdir()
    (repository / "src" / "export.txt").write_text("original\n")
    (repository / "src" / "export.py").write_text("def export_atomic():\n    return 'local'\n")
    subprocess.run(["git", "init", "-b", "main"], cwd=repository, check=True, capture_output=True)
    subprocess.run(["git", "add", "."], cwd=repository, check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "initial",
        ],
        cwd=repository,
        check=True,
        capture_output=True,
    )
    data_dir = tmp_path / "data"
    database = Database(data_dir / "cohorte.sqlite3")
    profile = ProjectProfile(
        project_id="project",
        name="Project",
        language="fr",
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="api", label="API", paths=["src"], role_profile="implementer", check_ids=["test"]
            )
        ],
        checks=[
            CheckDefinition(
                id="test", argv=[sys.executable, "-c", "print('ok')"], timeout_seconds=30
            )
        ],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )
    profile_ref = database.put_artifact("project-profile", canonical_model_bytes(profile))
    database.ensure_project("project", str(repository), profile_ref["id"])
    database.ensure_feature("safe-export", "project", "Safe export")
    brief = BrainstormBrief(
        feature_id="safe-export",
        idea="Safe export",
        project_context="",
        prior_decisions=[],
        panel=["product", "architecture", "qa"],
        session_refs=["product", "architecture", "qa", "synthesis"],
        contributions=[
            BrainstormContribution(
                contribution_id=perspective,
                perspective=perspective,
                problem="Partial exports",
                assumptions=[],
                alternatives=[],
                risks=[],
                questions=[],
                disagreements=[],
            )
            for perspective in ("product", "architecture", "qa")
        ],
        synthesis=BrainstormSynthesis(
            contribution_refs=["product", "architecture", "qa"],
            problem="Exports can be partial",
            beneficiaries=["operators"],
            in_scope=["Write an atomic export"],
            out_of_scope=["Cloud upload"],
            options=["atomic file"],
            recommendation="Use an atomic file",
            divergences=[],
            strong_objections=[],
            blocking_questions=["Which format?"] if blocking else [],
            non_blocking_questions=[],
            criterion_leads=["The export is atomic"],
        ),
        user_answers=["Keep data local"],
        decisions=["Keep data local"],
        panel_executed=True,
    )
    database.put_artifact(
        "brainstorm-brief", canonical_model_bytes(brief), artifact_id="brief:safe-export"
    )
    database.close()
    return repository, data_dir


def _answers(*, blocking_answer: str | None = None, approve: str = "oui") -> list[str]:
    return [
        *([blocking_answer] if blocking_answer is not None else []),
        "",
        "",
        "",
        "",
        "",
        "",
        "a completed run",
        "the export starts",
        "one complete file exists",
        "",
        "Export is atomic",
        "test",
        "",
        "Test interrupted writes",
        "Disk full",
        "",
        "Revert the export",
        approve,
    ]


def test_structured_spec_proposal_preserves_brief_and_requires_approval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repository, data_dir = _setup(tmp_path, blocking=True)
    proposal = SpecProposal(
        title="Export safely",
        in_scope=["Write one complete local export"],
        out_of_scope=["Cloud upload"],
        question_suggestions=[
            SpecQuestionSuggestion(
                question="Which format?", suggestion="CSV", caveat="Confirm consumers"
            )
        ],
        scenarios=[
            Scenario(
                id="complete-export",
                given="an operator has data",
                when="the export completes",
                then="one complete file exists",
            )
        ],
        acceptance=[
            SpecCriterionSuggestion(
                statement="The export is atomic", surface_id="api", check_id="test"
            )
        ],
        test_strategy=["Run test"],
        error_cases=["Disk full"],
        migrations_required=False,
        migrations="No migration",
        rollback="Revert the change",
    )
    monkeypatch.setattr(guided_feature, "_propose_spec", lambda *_args: proposal)
    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data_dir),
                "spec-propose",
                "safe-export",
                "--repo",
                str(repository),
            ]
        )
        == 0
    )
    payload = json.loads(capsys.readouterr().out)["data"]
    assert payload["approved"] is False
    assert payload["proposal"]["question_suggestions"][0]["suggestion"] == "CSV"
    database = Database(data_dir / "cohorte.sqlite3")
    try:
        assert (
            payload["brief_ref"]["sha256"]
            == database.latest_artifact("brief:safe-export")["sha256"]
        )
        assert database.latest_artifact("proposal:safe-export")["revision"] == 1
        assert database.get_feature("safe-export")["status"] == "draft"
    finally:
        database.close()


def test_guided_spec_requires_answer_before_freeze_and_preserves_draft(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repository, data_dir = _setup(tmp_path, blocking=True)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    answers = iter(_answers(blocking_answer=""))
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export", "--manual"]) == 0
    draft_path = data_dir / "guided" / "project" / "safe-export" / "draft.json"
    draft = FeatureSpec.model_validate_json(draft_path.read_text())
    assert draft.open_questions == ["Which format?"]
    assert not (draft_path.parent / "frozen.json").exists()
    database = Database(data_dir / "cohorte.sqlite3")
    assert database.get_feature("safe-export")["status"] == "draft"
    output = capsys.readouterr().out
    assert "Questions encore ouvertes" in output
    assert "Pistes du dépôt à vérifier" in output
    assert "src/export.py:" in output
    database.close()

    answers = iter(["CSV", "oui"])
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))
    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export", "--manual"]) == 0
    frozen = FeatureSpec.model_validate_json((draft_path.parent / "frozen.json").read_text())
    assert "Which format? CSV" in frozen.problem
    assert frozen.open_questions == []


def test_guided_spec_agent_proposes_complete_editable_draft(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repository, data_dir = _setup(tmp_path, blocking=True)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    proposal = SpecProposal(
        title="Export safely",
        in_scope=["Write a complete local export"],
        out_of_scope=["Cloud upload"],
        question_suggestions=[
            SpecQuestionSuggestion(
                question="What file format should be used?",
                suggestion="CSV",
                caveat="Confirm consumer compatibility",
            )
        ],
        scenarios=[
            Scenario(
                id="complete-export",
                given="an operator has data",
                when="the export completes",
                then="one complete CSV file exists",
            )
        ],
        acceptance=[
            SpecCriterionSuggestion(
                statement="No partial file remains", surface_id="api", check_id="test"
            )
        ],
        test_strategy=["Interrupt an export and assert atomic replacement"],
        error_cases=["Disk full leaves the previous export intact"],
        migrations_required=False,
        migrations="No migration required",
        rollback="Restore the previous exporter",
    )
    monkeypatch.setattr(guided_feature, "_propose_spec", lambda *_args: proposal)
    answers = iter(["p", "", "oui", "non"])
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export"]) == 0
    draft_path = data_dir / "guided" / "project" / "safe-export" / "draft.json"
    draft = FeatureSpec.model_validate_json(draft_path.read_text())
    assert draft.title == "Export safely"
    assert draft.open_questions == []
    assert "Which format? CSV" in draft.problem
    assert draft.acceptance[0].check_ids == ["test"]
    assert draft.scenarios[0].then == "one complete CSV file exists"
    assert not (draft_path.parent / "frozen.json").exists()
    database = Database(data_dir / "cohorte.sqlite3")
    assert database.latest_artifact("proposal:safe-export")["revision"] == 1
    database.close()
    output = capsys.readouterr().out
    assert "What file format should be used?" in output
    assert "Proposition de l'agent : CSV" in output
    assert "Proposition de spec (agent, à valider)" in output


def test_agent_can_improve_existing_draft_without_erasing_user_decisions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, data_dir = _setup(tmp_path)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    first_answers = iter(_answers(approve="non"))
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(first_answers))
    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export", "--manual"]) == 0
    draft_path = data_dir / "guided" / "project" / "safe-export" / "draft.json"
    original = FeatureSpec.model_validate_json(draft_path.read_text())
    proposal = SpecProposal(
        title="Atomic export",
        in_scope=["Complete export only"],
        out_of_scope=["Cloud upload"],
        question_suggestions=[],
        scenarios=[
            Scenario(id="atomic", given="data exists", when="export runs", then="file is complete")
        ],
        acceptance=[
            SpecCriterionSuggestion(statement="No partial file", surface_id="api", check_id="test")
        ],
        test_strategy=["Interrupt the writer"],
        error_cases=["Disk full"],
        migrations_required=False,
        migrations="No migration",
        rollback="Restore exporter",
    )
    monkeypatch.setattr(guided_feature, "_propose_spec", lambda *_args: proposal)
    second_answers = iter(["oui", "non"])
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(second_answers))

    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export"]) == 0
    revised = FeatureSpec.model_validate_json(draft_path.read_text())
    assert revised.revision == original.revision + 1
    assert revised.title == "Atomic export"
    assert revised.problem == original.problem
    assert revised.brief_ref == original.brief_ref
    assert revised.scenarios[0].id == "atomic"
    assert not (draft_path.parent / "frozen.json").exists()


def test_guided_spec_can_scope_multiple_surfaces_scenarios_and_criteria(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, data_dir = _setup(tmp_path)
    (repository / "web").mkdir()
    (repository / "contract.txt").write_text("API response shared with web\n")
    database = Database(data_dir / "cohorte.sqlite3")
    project = database.get_project("project")
    profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
    profile.surfaces.append(
        Surface(
            id="web", label="Web", paths=["web"], role_profile="implementer", check_ids=["test"]
        )
    )
    database.update_project_profile(
        "project", canonical_model_bytes(profile), project["profile_ref"]["revision"]
    )
    stored = database.latest_artifact("brief:safe-export")
    brief = BrainstormBrief.model_validate_json(stored["content"])
    from cohorte.domain.models import ArtifactRef

    brief_ref = ArtifactRef.model_validate(
        {key: stored[key] for key in ("id", "revision", "sha256")}
    )
    answers = iter(
        [
            "api,web",
            "contract.txt",
            "",
            "",
            "",
            "",
            "an operator",
            "starts an export",
            "gets a complete file",
            "oui",
            "a visitor",
            "opens exports",
            "sees status",
            "",
            "The API creates an atomic file",
            "test",
            "The web displays export status",
            "test",
            "",
            "Run both checks",
            "Interrupted write",
            "",
            "Revert export",
        ]
    )
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))
    draft = _new_draft(brief, brief_ref, profile, database, repository)

    assert draft.surfaces == ["api", "web"]
    assert len(draft.scenarios) == 2
    assert {item.surface_ids[0] for item in draft.acceptance} == {"api", "web"}
    assert len(draft.contract_refs) == 1
    SpecFreezer(database).prepare(draft, profile, repository_head(repository))
    database.close()


def test_guided_spec_reconciles_new_brief_without_erasing_draft(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, data_dir = _setup(tmp_path)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    answers = iter(_answers(approve="non"))
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))
    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export", "--manual"]) == 0
    draft_path = data_dir / "guided" / "project" / "safe-export" / "draft.json"
    first = FeatureSpec.model_validate_json(draft_path.read_text())

    database = Database(data_dir / "cohorte.sqlite3")
    original = BrainstormBrief.model_validate_json(
        database.latest_artifact("brief:safe-export")["content"]
    )
    revised = original.model_copy(
        update={
            "synthesis": original.synthesis.model_copy(
                update={"blocking_questions": ["Which error state must be shown?"]}
            )
        }
    )
    database.put_artifact(
        "brainstorm-brief", canonical_model_bytes(revised), artifact_id="brief:safe-export"
    )
    database.close()

    answers = iter(["oui", "Show disk full", "non"])
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))
    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export", "--manual"]) == 0
    second = FeatureSpec.model_validate_json(draft_path.read_text())
    assert second.brief_ref is not None and second.brief_ref.revision == 2
    assert second.scenarios == first.scenarios
    assert second.acceptance == first.acceptance
    assert "Which error state must be shown? Show disk full" in second.problem


def test_patch_spec_guided_from_intake_keeps_provenance_and_regression_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, data_dir = _setup(tmp_path)
    database = Database(data_dir / "cohorte.sqlite3")
    result = CohorteService(database).intake(
        "project", "Bug: export fails. Steps to reproduce: start export then interrupt."
    )
    feature_id = result["feature_id"]
    database.close()
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    answers = iter(
        [
            "start export then interrupt",
            "",
            "A complete file is saved",
            "api",
            "src/export.txt",
            "",
            "",
            "Revert export",
        ]
    )
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert (
        cli.run(
            ["--data-dir", str(data_dir), "patch-spec", "--from-intake", feature_id, "--manual"]
        )
        == 0
    )
    path = data_dir / "guided" / "project" / feature_id / "patch.json"
    patch = PatchSpec.model_validate_json(path.read_text())
    assert patch.source_ref.id == f"intake:{feature_id}"
    assert patch.regression_check_ids == ["test"]
    assert patch.write_paths == ["src/export.txt"]


def test_patch_agent_prefills_reviewable_diagnosis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, data_dir = _setup(tmp_path)
    database = Database(data_dir / "cohorte.sqlite3")
    intake = CohorteService(database).intake(
        "project", "Bug: export fails. Steps to reproduce: start export then interrupt."
    )
    feature_id = intake["feature_id"]
    database.close()
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(
        "cohorte.adapters.codex.CodexAdapter.patch_proposal",
        lambda self, _workspace, _prompt: PatchProposal(
            reproduction="start export then interrupt",
            observed_behavior="partial file remains",
            expected_behavior="previous complete file remains",
            suspected_surfaces=["api"],
            write_paths=["src/export.txt"],
            regression_check_ids=["test"],
            in_scope=["atomic replacement"],
            out_of_scope=["cloud export"],
            rollback="revert exporter",
            caveats=["Confirm existing export behavior"],
        ),
    )
    monkeypatch.setattr(builtins, "input", lambda _prompt: "")

    assert cli.run(["--data-dir", str(data_dir), "patch-spec", "--from-intake", feature_id]) == 0
    stored = Database(data_dir / "cohorte.sqlite3")
    patch = PatchSpec.model_validate_json(
        (data_dir / "guided" / "project" / feature_id / "patch.json").read_text()
    )
    assert patch.reproduction == "start export then interrupt"
    assert patch.surfaces == ["api"]
    assert patch.out_of_scope == ["cloud export"]
    assert stored.latest_artifact(f"proposal:patch:{feature_id}")["revision"] == 1
    stored.close()


def test_guided_freeze_binds_profile_and_start_refuses_tampered_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, data_dir = _setup(tmp_path)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    answers = iter(_answers())
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export", "--manual"]) == 0
    database = Database(data_dir / "cohorte.sqlite3")
    project = database.get_project("project")
    assert database.get_feature("safe-export")["status"] == "frozen"
    location = data_dir / "guided" / "project" / "safe-export"
    spec = FeatureSpec.model_validate_json((location / "frozen.json").read_text())
    assert spec.status.value == "frozen"
    assert spec.brief_ref is not None
    assert database.latest_artifact("ready:safe-export")["content"]

    monkeypatch.setattr(builtins, "input", lambda _prompt: "non")
    with pytest.raises(ValueError, match="cancelled before creating a run"):
        guided_start(database, data_dir, project, "safe-export")
    assert database.list_runs("project") == []

    frozen_bytes = (location / "frozen.json").read_bytes()
    (location / "frozen.json").write_text(json.dumps({"changed": True}))
    with pytest.raises(ValueError, match="changed after freeze"):
        guided_start(database, data_dir, project, "safe-export")
    (location / "frozen.json").write_bytes(frozen_bytes)
    changed_profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
    changed_profile.name = "Changed project"
    database.update_project_profile(
        "project", canonical_model_bytes(changed_profile), project["profile_ref"]["revision"]
    )
    with pytest.raises(ValueError, match="project profile changed after freeze"):
        guided_start(database, data_dir, database.get_project("project"), "safe-export")
    database.close()


class _Runtime:
    def build(self, workspace: Path, prompt: str) -> AgentReport:
        assert "Frozen feature spec" in prompt
        (workspace / "src" / "export.txt").write_text("ready\n")
        return AgentReport(summary="implemented", changed_files=["src/export.txt"])

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        assert "Independently review" in prompt
        return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=["api"])

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        raise AssertionError("unexpected fix")


def test_guided_start_reuses_loop_and_creates_ship_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repository, data_dir = _setup(tmp_path)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    answers = iter(_answers())
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))
    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export", "--manual"]) == 0
    capsys.readouterr()

    monkeypatch.setattr(builtins, "input", lambda _prompt: "oui")
    monkeypatch.setattr(cli, "workflow_runtime", lambda *_args, **_kwargs: _Runtime())
    assert cli.run(["--data-dir", str(data_dir), "start", "safe-export"]) == 0
    database = Database(data_dir / "cohorte.sqlite3")
    runs = database.list_runs("project")
    assert len(runs) == 1
    ship_request = database.ship_request_for_run(runs[0].id)
    assert ship_request["status"] == "pending"
    assert (repository / "src" / "export.txt").read_text() == "original\n"
    assert "ship_request_id" in capsys.readouterr().out
    database.close()
