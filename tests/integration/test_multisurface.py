from __future__ import annotations

import subprocess
import threading
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import pytest

from cohorte.application.durable import SqliteRunJournal, SqliteTaskJournal
from cohorte.application.multisurface import MultiSurfaceRunner, plan_multisurface
from cohorte.application.vertical import AgentReport, AgentReview
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


class ParallelRuntime:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.build_order: list[str] = []

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        task_id = next(
            item for item in ("build-contract", "build-backend", "build-client") if item in prompt
        )
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.build_order.append(task_id)
        try:
            if task_id != "build-contract":
                assert (workspace / "contract" / "schema.txt").read_text() == "v1\n"
                time.sleep(0.05)
            target = {
                "build-contract": workspace / "contract" / "schema.txt",
                "build-backend": workspace / "backend" / "service.txt",
                "build-client": workspace / "client" / "screen.txt",
            }[task_id]
            target.write_text("v1\n" if task_id == "build-contract" else "uses-v1\n")
            return AgentReport(summary=task_id, changed_files=[str(target.relative_to(workspace))])
        finally:
            with self.lock:
                self.active -= 1

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        if "cross-surface integration" in prompt:
            covered = ["contract", "backend", "client"]
        else:
            covered = [
                item
                for item in ("contract", "backend", "client")
                if f"Review surface {item} specifically" in prompt
            ]
        return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=covered)

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        raise AssertionError("fix should not run")


def profile() -> ProjectProfile:
    return ProjectProfile(
        schema_version=1,
        project_id="multi-demo",
        name="Multi demo",
        language="en",
        metadata_mode=MetadataMode.LOCAL,
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="contract",
                label="Contract",
                paths=["contract"],
                role_profile="implementer",
                check_ids=["all"],
            ),
            Surface(
                id="backend",
                label="Backend",
                paths=["backend"],
                depends_on=["contract"],
                role_profile="implementer",
                check_ids=["all"],
            ),
            Surface(
                id="client",
                label="Client",
                paths=["client"],
                depends_on=["contract"],
                role_profile="implementer",
                check_ids=["all"],
            ),
        ],
        checks=[
            CheckDefinition(
                id="all",
                argv=[
                    "sh",
                    "-c",
                    'test "$(cat contract/schema.txt)" = v1 && '
                    'test "$(cat backend/service.txt)" = uses-v1 && '
                    'test "$(cat client/screen.txt)" = uses-v1',
                ],
                timeout_seconds=10,
            )
        ],
        agent_defaults=AgentDefaults(provider=Provider.CODEX, account_ref="codex-native"),
        policy=Policy(max_parallel_per_account=2, max_parallel_global=3),
    )


def spec() -> FeatureSpec:
    return FeatureSpec(
        schema_version=1,
        feature_id="multi-change",
        revision=1,
        status=SpecStatus.FROZEN,
        title="Coordinate three surfaces",
        problem="The contract and its two consumers are missing.",
        in_scope=["Add contract", "Add consumers"],
        out_of_scope=[],
        surfaces=["contract", "backend", "client"],
        scenarios=[Scenario(id="flow", given="v1", when="consumed", then="both clients work")],
        acceptance=[
            Criterion(
                id="contract-exists",
                statement="Contract v1 exists",
                verification="automatic",
                check_ids=["all"],
                surface_ids=["contract"],
            ),
            Criterion(
                id="consumers-use-contract",
                statement="Both consumers use contract v1",
                verification="automatic",
                check_ids=["all"],
                surface_ids=["backend", "client"],
            ),
        ],
        dod=DefinitionOfDone(required_checks=["all"]),
        contract_refs=[],
        dependencies=[],
        migrations=RequirementPlan(required=False, plan="No migration."),
        rollback=RequirementPlan(required=False, plan="Remove generated files."),
        design_refs=[],
        rbac_requirements=[],
        open_questions=[],
    )


def test_multisurface_runs_dependency_wave_then_parallel_consumers(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    for directory in ("contract", "backend", "client"):
        (repository / directory).mkdir()
        (repository / directory / ".gitkeep").write_text("")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "initial")
    runtime = ParallelRuntime()

    result = MultiSurfaceRunner(runtime).run(
        repository, tmp_path / "worktrees", profile(), spec(), "multi-run"
    )

    assert result.ready_to_ship is True
    assert result.max_scheduled_parallelism == 2
    assert runtime.max_active == 2
    assert runtime.build_order[0] == "build-contract"
    assert {item["surface_id"] for item in result.tasks} == {"contract", "backend", "client"}
    candidate = Path(result.worktree)
    assert (candidate / "contract" / "schema.txt").read_text() == "v1\n"
    assert (candidate / "backend" / "service.txt").read_text() == "uses-v1\n"
    assert (candidate / "client" / "screen.txt").read_text() == "uses-v1\n"
    assert git(candidate, "log", "--format=%B").count("Cohorte-Task:") == 3


def test_multisurface_plan_maps_surface_dependencies() -> None:
    plan = plan_multisurface(profile(), spec(), "a" * 40)
    tasks = {task.id: task for task in plan.tasks}

    assert tasks["build-contract"].depends_on == []
    assert tasks["build-backend"].depends_on == ["build-contract"]
    assert tasks["build-client"].depends_on == ["build-contract"]
    assert tasks["build-backend"].read_paths == ["contract"]


def test_multisurface_recovers_committed_parallel_task_without_rebuilding(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    for directory in ("contract", "backend", "client"):
        (repository / directory).mkdir()
        (repository / directory / ".gitkeep").write_text("")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "initial")
    database = Database(tmp_path / "state.sqlite3")
    database.register_project("multi-demo", str(repository), "profile")
    database.create_feature("multi-change", "multi-demo", "Multi change")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="crash-wave",
            project_id="multi-demo",
            feature_id="multi-change",
            stage=Stage.BUILD,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit=git(repository, "rev-parse", "HEAD"),
            created_at=now,
            updated_at=now,
        )
    )
    runtime = ParallelRuntime()
    task_journal = SqliteTaskJournal(database, "crash-wave")

    def crash_after_backend(event: str, data: dict[str, object]) -> None:
        if event == "task.integrated" and data["task_id"] == "build-backend":
            raise SystemExit("simulated controller crash inside parallel wave")

    with pytest.raises(SystemExit, match="parallel wave"):
        MultiSurfaceRunner(runtime).run(
            repository,
            tmp_path / "worktrees",
            profile(),
            spec(),
            "crash-wave",
            task_journal=task_journal,
            task_observe=crash_after_backend,
        )

    records = task_journal.records()
    assert records["build-contract"]["status"] == "integrated"
    assert records["build-backend"]["status"] == "integrated"
    assert records["build-client"]["status"] == "running"
    candidate = tmp_path / "worktrees" / "multi-change-crash-wave"

    result = MultiSurfaceRunner(runtime).run(
        repository,
        tmp_path / "worktrees",
        profile(),
        spec(),
        "crash-wave",
        existing_worktree=candidate,
        resume_stage=Stage.BUILD,
        observe=SqliteRunJournal(database, "crash-wave"),
        task_journal=task_journal,
    )

    assert result.ready_to_ship is True
    assert result.max_scheduled_parallelism == 2
    assert Counter(runtime.build_order) == {
        "build-contract": 1,
        "build-backend": 1,
        "build-client": 1,
    }
    assert git(candidate, "log", "--format=%B").count("Cohorte-Task:") == 3
    assert {row["status"] for row in database.task_records("crash-wave")} == {"integrated"}
    assert database.connection.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 3
    assert database.connection.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0
    recovered = database.get_run("crash-wave")
    assert recovered.stage == Stage.SHIP
    assert recovered.status == RunStatus.WAITING_USER
    database.close()
