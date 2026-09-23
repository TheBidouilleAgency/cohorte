from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from cohorte.application.preparation import (
    BrainstormBrief,
    BrainstormContribution,
    BrainstormPerspectiveTurn,
    BrainstormRunner,
    BrainstormSynthesis,
    BrainstormSynthesisTurn,
    SpecFreezer,
    canonical_model_bytes,
    model_hash,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import (
    AgentDefaults,
    ArtifactRef,
    CheckDefinition,
    Criterion,
    DefinitionOfDone,
    FeatureSpec,
    ProjectProfile,
    Provider,
    RequirementPlan,
    Scenario,
    SpecStatus,
    Surface,
    VcsConfig,
)
from cohorte.persistence.sqlite import Database


class PanelRuntime:
    def __init__(self, reuse_session: bool = False) -> None:
        self.reuse_session = reuse_session
        self.calls: list[str] = []
        self.prompts: list[str] = []

    def brainstorm_perspective(
        self, workspace: Path, prompt: str, perspective: str
    ) -> BrainstormPerspectiveTurn:
        assert '"idea": "Add safe export"' in prompt
        self.calls.append(perspective)
        self.prompts.append(prompt)
        return BrainstormPerspectiveTurn(
            session_ref="same" if self.reuse_session else f"session-{perspective}",
            contribution=BrainstormContribution(
                contribution_id=perspective,
                perspective=perspective,
                problem=f"{perspective} problem",
                assumptions=[f"{perspective} assumption"],
                alternatives=[f"{perspective} option"],
                risks=[f"{perspective} risk"],
                questions=[f"{perspective} question"],
                disagreements=[f"{perspective} disagrees about synchronous export"],
            ),
        )

    def brainstorm_synthesis(self, workspace: Path, prompt: str) -> BrainstormSynthesisTurn:
        assert all(f'"contribution_id": "{item}"' in prompt for item in self.calls)
        self.prompts.append(prompt)
        return BrainstormSynthesisTurn(
            session_ref="same" if self.reuse_session else "session-synthesis",
            synthesis=BrainstormSynthesis(
                contribution_refs=self.calls,
                problem="Exports need a safe boundary.",
                beneficiaries=["operators"],
                in_scope=["bounded export"],
                out_of_scope=["remote storage"],
                options=["sync", "async"],
                recommendation="Use an atomic bounded export.",
                divergences=["Synchronous versus asynchronous delivery"],
                strong_objections=["Large exports must not exhaust memory"],
                blocking_questions=[],
                non_blocking_questions=["Which filename?"],
                criterion_leads=["Export is atomic"],
            ),
        )


class CorrectedSynthesisRuntime(PanelRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.synthesis_calls = 0

    def brainstorm_synthesis(self, workspace: Path, prompt: str) -> BrainstormSynthesisTurn:
        self.synthesis_calls += 1
        turn = super().brainstorm_synthesis(workspace, prompt)
        refs = self.calls[:-1] if self.synthesis_calls == 1 else self.calls
        return turn.model_copy(
            update={
                "session_ref": f"session-synthesis-{self.synthesis_calls}",
                "synthesis": turn.synthesis.model_copy(update={"contribution_refs": refs}),
            }
        )


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True
    ).stdout.strip()


def run_cli(data_dir: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "cohorte.cli.main",
            "--json",
            "--data-dir",
            str(data_dir),
            *args,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def profile() -> ProjectProfile:
    return ProjectProfile(
        project_id="project",
        name="Project",
        language="en",
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="api",
                label="API",
                paths=["src"],
                role_profile="implementer",
                check_ids=["test"],
            )
        ],
        checks=[CheckDefinition(id="test", argv=["pytest"], timeout_seconds=30)],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )


def draft(brief_ref: ArtifactRef, title: str = "Safe export") -> FeatureSpec:
    return FeatureSpec(
        feature_id="safe-export",
        revision=1,
        status=SpecStatus.DRAFT,
        title=title,
        brief_ref=brief_ref,
        problem="Exports can be partial.",
        in_scope=["Atomic export"],
        out_of_scope=["Cloud upload"],
        surfaces=["api"],
        scenarios=[
            Scenario(
                id="export",
                given="a completed run",
                when="the run is exported",
                then="one complete file is produced",
            )
        ],
        acceptance=[
            Criterion(
                id="atomic",
                statement="Export is atomic",
                verification="automatic",
                check_ids=["test"],
                surface_ids=["api"],
            )
        ],
        dod=DefinitionOfDone(required_checks=["test"]),
        test_strategy=["Exercise interrupted and successful writes"],
        error_cases=["Destination becomes unavailable"],
        contract_refs=[],
        dependencies=[],
        migrations=RequirementPlan(required=False, plan="No migration."),
        rollback=RequirementPlan(required=False, plan="Remove the export command."),
        design_refs=[],
        rbac_requirements=[],
        open_questions=[],
    )


def test_brainstorm_uses_distinct_sessions_and_persists_divergence_and_user_answer(
    tmp_path: Path,
) -> None:
    runtime = PanelRuntime()
    brief = BrainstormRunner(runtime).run(
        tmp_path,
        "safe-export",
        "Add safe export",
        "Local workflow engine",
        ["Keep exports local"],
    )

    assert runtime.calls == ["product", "architecture", "qa"]
    assert len(set(brief.session_refs)) == 4
    assert brief.synthesis.divergences == ["Synchronous versus asynchronous delivery"]
    assert brief.user_answers == brief.decisions == ["Keep exports local"]
    database = Database(tmp_path / "state.sqlite3")
    reference = database.put_artifact("brainstorm-brief", canonical_model_bytes(brief))
    stored = database.get_artifact(reference["id"], reference["revision"])
    assert BrainstormBrief.model_validate_json(stored["content"]) == brief
    database.close()


def test_brainstorm_rejects_reused_runtime_session(tmp_path: Path) -> None:
    with pytest.raises(CohorteError) as caught:
        BrainstormRunner(PanelRuntime(reuse_session=True)).run(
            tmp_path,
            "safe-export",
            "Add safe export",
            "Local workflow engine",
            ["Keep exports local"],
        )
    assert caught.value.code == ErrorCode.CAPABILITY_MISSING


def test_brainstorm_continuation_links_rounds_and_revisits_previous_synthesis(
    tmp_path: Path,
) -> None:
    first = BrainstormRunner(PanelRuntime()).run(
        tmp_path, "safe-export", "Add safe export", "Local workflow engine", ["Keep exports local"]
    )
    database = Database(tmp_path / "state.sqlite3")
    reference = ArtifactRef.model_validate(
        database.put_artifact(
            "brainstorm-brief", canonical_model_bytes(first), artifact_id="brief:safe-export"
        )
    )
    runtime = PanelRuntime()
    continued = BrainstormRunner(runtime).run(
        tmp_path,
        "safe-export",
        "Add safe export",
        "Local workflow engine",
        ["Which filename? export.json"],
        previous_brief=first,
        previous_brief_ref=reference,
    )
    assert continued.previous_brief_ref == reference
    assert continued.user_answers == ["Keep exports local", "Which filename? export.json"]
    assert continued.decisions == continued.user_answers
    assert all('"previous_round":' in prompt for prompt in runtime.prompts)
    assert all("Which filename? export.json" in prompt for prompt in runtime.prompts)
    assert all(
        '"new_user_answers": ["Which filename? export.json"]' in prompt
        for prompt in runtime.prompts
    )
    assert all('"contributions":' in prompt for prompt in runtime.prompts)
    assert "previous_brief_ref" in canonical_model_bytes(continued).decode()
    database.close()


def test_brainstorm_retries_invalid_synthesis_with_a_bounded_correction(tmp_path: Path) -> None:
    runtime = CorrectedSynthesisRuntime()
    brief = BrainstormRunner(runtime).run(
        tmp_path,
        "safe-export",
        "Add safe export",
        "Local workflow engine",
        ["Keep exports local"],
    )
    assert runtime.synthesis_calls == 2
    assert brief.synthesis.contribution_refs == ["product", "architecture", "qa"]


def test_spec_freeze_refuses_incomplete_or_stale_draft_and_binds_exact_hash(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    (repository / "README.md").write_text("project\n")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "initial")
    database = Database(tmp_path / "state.sqlite3")
    brief = database.put_artifact("brainstorm-brief", b'{"brief":true}')
    brief_ref = ArtifactRef.model_validate(brief)
    freezer = SpecFreezer(database)
    complete = draft(brief_ref)

    with pytest.raises(CohorteError) as incomplete:
        freezer.prepare(
            complete.model_copy(update={"open_questions": ["Which limit?"]}),
            profile(),
            git(repository, "rev-parse", "HEAD"),
        )
    assert incomplete.value.code == ErrorCode.SPEC_NOT_FROZEN

    prepared = freezer.prepare(complete, profile(), git(repository, "rev-parse", "HEAD"))
    request = database.get_request(prepared.request_id)
    assert request["subject_hash"] == prepared.spec_hash
    decision = database.respond_request(
        prepared.request_id,
        "approve-freeze",
        {"approved": True},
        prepared.spec_hash,
    )

    with pytest.raises(CohorteError) as stale:
        freezer.freeze(
            draft(brief_ref, title="Changed after approval"),
            profile(),
            git(repository, "rev-parse", "HEAD"),
            decision["decision_id"],
        )
    assert stale.value.code == ErrorCode.APPROVAL_REQUIRED

    frozen = freezer.freeze(
        complete,
        profile(),
        git(repository, "rev-parse", "HEAD"),
        decision["decision_id"],
    )
    assert frozen.spec.status == SpecStatus.FROZEN
    assert frozen.spec_ref.sha256 == model_hash(frozen.spec) == prepared.spec_hash
    assert list(frozen.plan.coverage.values()) == [["atomic"]]
    assert json.loads(
        database.get_artifact(frozen.plan_ref.id, frozen.plan_ref.revision)["content"]
    )
    database.close()


def test_spec_freeze_cli_persists_frozen_feature_after_exact_approval(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    (repository / "README.md").write_text("project\n")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "initial")
    data_dir = tmp_path / "data"
    database = Database(data_dir / "cohorte.sqlite3")
    brief_ref = ArtifactRef.model_validate(
        database.put_artifact("brainstorm-brief", b'{"brief":true}')
    )
    database.close()
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(profile().model_dump_json())
    draft_path = tmp_path / "draft.json"
    draft_path.write_text(draft(brief_ref).model_dump_json())

    prepared = run_cli(
        data_dir,
        "spec-freeze-request",
        str(draft_path),
        "--profile",
        str(profile_path),
        "--repo",
        str(repository),
    )
    assert prepared.returncode == 0, prepared.stderr
    preparation = json.loads(prepared.stdout)["data"]
    approved = run_cli(data_dir, "approve", preparation["request_id"])
    assert approved.returncode == 0, approved.stderr
    decision_id = json.loads(approved.stdout)["data"]["decision_id"]
    output = tmp_path / "frozen.json"
    frozen = run_cli(
        data_dir,
        "spec-freeze",
        str(draft_path),
        "--profile",
        str(profile_path),
        "--repo",
        str(repository),
        "--decision-id",
        decision_id,
        "--output",
        str(output),
    )
    assert frozen.returncode == 0, frozen.stderr
    document = FeatureSpec.model_validate_json(output.read_text())
    assert document.status == SpecStatus.FROZEN
    assert model_hash(document) == preparation["spec_hash"]
    database = Database(data_dir / "cohorte.sqlite3")
    assert database.get_feature("safe-export")["status"] == "frozen"
    database.close()
