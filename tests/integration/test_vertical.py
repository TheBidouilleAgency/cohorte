from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from cohorte.application.durable import SqliteRunJournal
from cohorte.application.vertical import AgentReport, AgentReview, VerticalRunner
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import (
    AgentDefaults,
    CheckDefinition,
    Criterion,
    DefinitionOfDone,
    FeatureSpec,
    MetadataMode,
    Policy,
    ProjectProfile,
    Provider,
    RequirementPlan,
    RunState,
    RunStatus,
    Scenario,
    SpecStatus,
    Stage,
    Surface,
    VcsConfig,
)
from cohorte.persistence.sqlite import Database


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True)
    return result.stdout.strip()


class FixingRuntime:
    def __init__(self) -> None:
        self.builds = 0
        self.reviews = 0
        self.fixes = 0

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        self.builds += 1
        assert "Frozen feature spec" in prompt
        (workspace / "src" / "message.txt").write_text("wrong\n")
        return AgentReport(summary="initial implementation", changed_files=["src/message.txt"])

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        self.reviews += 1
        assert "Independently review" in prompt
        return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=["core"])

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        self.fixes += 1
        assert "Failed checks" in prompt
        (workspace / "src" / "message.txt").write_text("hello\n")
        return AgentReport(summary="fixed check", changed_files=["src/message.txt"])


class OutOfScopeRuntime(FixingRuntime):
    def build(self, workspace: Path, prompt: str) -> AgentReport:
        (workspace / "README.md").write_text("unauthorized\n")
        return AgentReport(summary="claimed success", changed_files=["README.md"])


def profile() -> ProjectProfile:
    return ProjectProfile(
        schema_version=1,
        project_id="demo",
        name="Demo",
        language="en",
        metadata_mode=MetadataMode.LOCAL,
        vcs=VcsConfig(),
        surfaces=[Surface(id="core", label="Core", paths=["src"], role_profile="implementer")],
        checks=[
            CheckDefinition(
                id="content",
                argv=["sh", "-c", 'test "$(cat src/message.txt)" = hello'],
                timeout_seconds=10,
            )
        ],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
        policy=Policy(max_fix_cycles=2),
    )


def spec() -> FeatureSpec:
    return FeatureSpec(
        schema_version=1,
        feature_id="hello",
        revision=1,
        status=SpecStatus.FROZEN,
        title="Write hello",
        problem="The message is missing.",
        in_scope=["Write the expected message."],
        out_of_scope=[],
        surfaces=["core"],
        scenarios=[Scenario(id="message", given="a checkout", when="read", then="hello")],
        acceptance=[
            Criterion(
                id="message-content",
                statement="src/message.txt contains hello",
                verification="automatic",
                check_ids=["content"],
            )
        ],
        dod=DefinitionOfDone(required_checks=["content"]),
        contract_refs=[],
        dependencies=[],
        migrations=RequirementPlan(required=False, plan="No migration."),
        rollback=RequirementPlan(required=False, plan="Remove the file."),
        design_refs=[],
        rbac_requirements=[],
        open_questions=[],
    )


def test_vertical_runs_build_check_fix_and_independent_review(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    (repository / "src").mkdir()
    (repository / "src" / ".gitkeep").write_text("")
    (repository / "README.md").write_text("demo\n")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "initial")
    runtime = FixingRuntime()

    result = VerticalRunner(runtime).run(
        repository, tmp_path / "worktrees", profile(), spec(), "run-1"
    )

    assert result.ready_to_ship is True
    assert result.fix_cycles == 1
    assert result.changed_files == ["src/message.txt"]
    assert result.review["verdict"] == "ready"
    assert runtime.reviews == 2
    assert runtime.fixes == 1


def test_vertical_rejects_run_id_path_traversal(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="run_id"):
        VerticalRunner(FixingRuntime()).run(
            tmp_path, tmp_path / "worktrees", profile(), spec(), "../../escape"
        )


def test_vertical_rejects_out_of_scope_agent_change_without_false_success(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    (repository / "src").mkdir()
    (repository / "src" / ".gitkeep").write_text("")
    (repository / "README.md").write_text("original\n")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "initial")

    with pytest.raises(CohorteError) as caught:
        VerticalRunner(OutOfScopeRuntime()).run(
            repository, tmp_path / "worktrees", profile(), spec(), "ownership-run"
        )

    assert caught.value.code == ErrorCode.OWNERSHIP_VIOLATION
    assert (repository / "README.md").read_text() == "original\n"


def test_vertical_resumes_after_durable_build_checkpoint(tmp_path: Path) -> None:
    from datetime import UTC, datetime

    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    (repository / "src").mkdir()
    (repository / "src" / ".gitkeep").write_text("")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "initial")
    database = Database(tmp_path / "state.sqlite3")
    database.register_project("demo", str(repository), "profile")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="crash-run",
            project_id="demo",
            feature_id="hello",
            stage=Stage.BUILD,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit=git(repository, "rev-parse", "HEAD"),
            created_at=now,
            updated_at=now,
        )
    )
    journal = SqliteRunJournal(database, "crash-run")
    runtime = FixingRuntime()

    def crash_after_checkpoint(phase: str, data: dict[str, object]) -> None:
        journal(phase, data)
        if phase == "build":
            raise SystemExit("simulated crash")

    with pytest.raises(SystemExit, match="simulated crash"):
        VerticalRunner(runtime).run(
            repository,
            tmp_path / "worktrees",
            profile(),
            spec(),
            "crash-run",
            observe=crash_after_checkpoint,
        )

    checkpoint = database.get_run("crash-run")
    assert checkpoint.stage == Stage.CHECKS
    worktree = tmp_path / "worktrees" / "hello-crash-run"
    result = VerticalRunner(runtime).run(
        repository,
        tmp_path / "worktrees",
        profile(),
        spec(),
        "crash-run",
        existing_worktree=worktree,
        resume_stage=checkpoint.stage,
        initial_fix_cycles=checkpoint.fix_cycles,
        observe=journal,
    )

    assert result.ready_to_ship is True
    assert runtime.builds == 1
    recovered = database.get_run("crash-run")
    assert recovered.stage == Stage.SHIP
    assert recovered.status == RunStatus.WAITING_USER
    database.close()
