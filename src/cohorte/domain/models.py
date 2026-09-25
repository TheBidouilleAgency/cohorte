from __future__ import annotations

import re
from datetime import datetime
from enum import StrEnum
from pathlib import PurePosixPath
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Slug = Annotated[str, Field(pattern=r"^[a-z0-9-]{1,80}$")]
Sha256 = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Title = Annotated[str, Field(min_length=1, max_length=200)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def validate_rel_path(value: str) -> str:
    if not value or "\x00" in value or "\\" in value:
        raise ValueError("path must be a normalized POSIX relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value:
        raise ValueError("path traversal or non-normalized path")
    return value


RelPath = Annotated[str, Field(min_length=1), validate_rel_path]


class ArtifactRef(StrictModel):
    id: str = Field(min_length=1)
    revision: int = Field(ge=1)
    sha256: Sha256


class MetadataMode(StrEnum):
    LOCAL = "local"
    SHARED = "shared"


class Provider(StrEnum):
    CLAUDE = "claude"
    CODEX = "codex"


class CheckScope(StrEnum):
    PROJECT = "project"
    SURFACE = "surface"
    CRITERION = "criterion"


class CheckDefinition(StrictModel):
    id: Slug
    argv: list[str] = Field(min_length=1, max_length=64)
    cwd: str = "."
    timeout_seconds: int = Field(gt=0, le=7200)
    required: bool = True
    scope: CheckScope = CheckScope.PROJECT
    environment_ref: str | None = None
    produces: list[str] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def safe(self) -> CheckDefinition:
        validate_rel_path(self.cwd)
        if any("\x00" in arg for arg in self.argv):
            raise ValueError("argv contains NUL")
        return self


class Surface(StrictModel):
    id: Slug
    label: str = Field(min_length=1, max_length=200)
    paths: list[str] = Field(min_length=1, max_length=128)
    depends_on: list[Slug] = Field(default_factory=list)
    role_profile: Slug
    check_ids: list[Slug] = Field(default_factory=list)
    uses_design: bool = False

    @model_validator(mode="after")
    def paths_are_safe(self) -> Surface:
        for path in self.paths:
            validate_rel_path(path)
        return self


class VcsConfig(StrictModel):
    host: Literal["github", "gitlab", "other"] = "other"
    remote: str = "origin"
    default_branch: str = "main"
    feature_branch_prefix: str = "feature/"
    patch_branch_prefix: str = "fix/"


class ContractConfig(StrictModel):
    enabled: bool = False
    mechanism: str = "none"
    paths: list[str] = Field(default_factory=list)


class ExecutionConfig(StrictModel):
    mode: Literal["local", "container"] = "local"
    dependency_setup: CheckDefinition | None = None


class AgentDefaults(StrictModel):
    provider: Provider
    account_ref: str | None = None
    model: str | None = None
    role_profile: Slug = "implementer"


def default_blocking_severities() -> list[Literal["critical", "high", "medium", "low"]]:
    return ["critical", "high"]


class Policy(StrictModel):
    auth_mode: Literal["subscription_only"] = "subscription_only"
    max_fix_cycles: int = Field(default=3, ge=0, le=20)
    max_parallel_per_account: int = Field(default=2, ge=1, le=32)
    max_parallel_global: int = Field(default=4, ge=1, le=128)
    require_frozen_spec: bool = True
    review_blocking_severities: list[Literal["critical", "high", "medium", "low"]] = Field(
        default_factory=default_blocking_severities
    )
    ship_authorization: Literal["explicit_or_pregranted"] = "explicit_or_pregranted"


class RetrievalConfig(StrictModel):
    provider: Literal["none", "files", "serena", "graphify"] = "none"
    fallback_to_files: bool = False
    roots: list[str] = Field(default_factory=lambda: ["."])

    @model_validator(mode="after")
    def roots_are_safe(self) -> RetrievalConfig:
        for root in self.roots:
            validate_rel_path(root)
        return self


class DesignConfig(StrictModel):
    enabled: bool = False
    provider: Literal["none", "file", "figma"] = "none"
    source: str | None = None
    snapshot_path: str | None = None

    @model_validator(mode="after")
    def enabled_source_is_explicit(self) -> DesignConfig:
        if self.enabled and (self.provider == "none" or not self.source):
            raise ValueError("enabled design integration requires provider and source")
        if not self.enabled and self.provider != "none":
            raise ValueError("disabled design integration must use provider none")
        if self.snapshot_path is not None:
            validate_rel_path(self.snapshot_path)
        return self


class KanbanConfig(StrictModel):
    enabled: bool = False
    provider: Literal["none", "obsidian"] = "none"
    vault_path: str | None = None
    board_path: str | None = None
    backup_path: str = ".cohorte-backups"
    columns: dict[str, str] = Field(
        default_factory=lambda: {
            "draft": "Backlog",
            "running": "In Progress",
            "waiting_user": "Review",
            "completed": "Done",
            "failed": "Blocked",
        }
    )

    @model_validator(mode="after")
    def explicit_connection(self) -> KanbanConfig:
        if self.enabled and (
            self.provider != "obsidian" or not self.vault_path or not self.board_path
        ):
            raise ValueError("enabled Obsidian projection requires vault_path and board_path")
        if not self.enabled and self.provider != "none":
            raise ValueError("disabled Kanban integration must use provider none")
        if self.board_path is not None:
            validate_rel_path(self.board_path)
        validate_rel_path(self.backup_path)
        if not self.columns:
            raise ValueError("Kanban columns cannot be empty")
        return self


class Integrations(StrictModel):
    retrieval: RetrievalConfig = Field(default_factory=RetrievalConfig)
    design: DesignConfig = Field(default_factory=DesignConfig)
    rbac: dict[str, Any] = Field(default_factory=lambda: {"enabled": False})
    mobile: dict[str, Any] = Field(default_factory=lambda: {"enabled": False})
    kanban: KanbanConfig = Field(default_factory=KanbanConfig)
    release_notes: dict[str, Any] = Field(default_factory=lambda: {"enabled": False})


class ProjectProfile(StrictModel):
    schema_version: Literal[1] = 1
    revision: int = Field(default=1, ge=1)
    project_id: Slug
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=1000)
    language: str = Field(min_length=2, max_length=16)
    metadata_mode: MetadataMode = MetadataMode.LOCAL
    vcs: VcsConfig
    surfaces: list[Surface] = Field(min_length=1, max_length=128)
    checks: list[CheckDefinition] = Field(default_factory=list, max_length=128)
    contract: ContractConfig = Field(default_factory=ContractConfig)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    agent_defaults: AgentDefaults
    brainstorm_panel: list[Slug] = Field(
        default_factory=lambda: ["product", "architecture", "qa"], min_length=3, max_length=8
    )
    policy: Policy = Field(default_factory=Policy)
    integrations: Integrations = Field(default_factory=Integrations)
    conventions: list[str] = Field(default_factory=list, max_length=256)

    @model_validator(mode="after")
    def references_are_valid(self) -> ProjectProfile:
        if len(self.brainstorm_panel) != len(set(self.brainstorm_panel)):
            raise ValueError("brainstorm panel members must be distinct")
        surface_ids = [surface.id for surface in self.surfaces]
        if len(surface_ids) != len(set(surface_ids)):
            raise ValueError("surface ids must be unique")
        check_ids = [check.id for check in self.checks]
        if len(check_ids) != len(set(check_ids)):
            raise ValueError("check ids must be unique")
        known_surfaces, known_checks = set(surface_ids), set(check_ids)
        owners: list[tuple[str, str]] = []
        for surface in self.surfaces:
            if not set(surface.depends_on) <= known_surfaces:
                raise ValueError(f"unknown dependency for surface {surface.id}")
            if not set(surface.check_ids) <= known_checks:
                raise ValueError(f"unknown check for surface {surface.id}")
            for path in surface.paths:
                for owned_path, owner in owners:
                    left = path.rstrip("/")
                    right = owned_path.rstrip("/")
                    overlaps = (
                        left == "."
                        or right == "."
                        or left == right
                        or left.startswith(right + "/")
                        or right.startswith(left + "/")
                    )
                    if overlaps and owner != surface.id:
                        raise ValueError(f"ambiguous path ownership: {path} overlaps {owned_path}")
                owners.append((path, surface.id))

        incoming = {surface.id: set(surface.depends_on) for surface in self.surfaces}
        ready = [surface_id for surface_id, dependencies in incoming.items() if not dependencies]
        visited: set[str] = set()
        while ready:
            current = ready.pop()
            visited.add(current)
            for surface_id, dependencies in incoming.items():
                dependencies.discard(current)
                if not dependencies and surface_id not in visited:
                    ready.append(surface_id)
        if visited != known_surfaces:
            raise ValueError("surface dependency graph contains a cycle")
        return self


class SpecStatus(StrEnum):
    DRAFT = "draft"
    FROZEN = "frozen"
    SUPERSEDED = "superseded"


class Criterion(StrictModel):
    id: Slug
    statement: str = Field(min_length=1, max_length=65536)
    verification: Literal["automatic", "review", "manual"]
    check_ids: list[Slug] = Field(default_factory=list)
    surface_ids: list[Slug] = Field(default_factory=list)
    evidence_required: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def automatic_has_check(self) -> Criterion:
        if self.verification == "automatic" and not self.check_ids:
            raise ValueError("automatic criterion requires a check")
        return self


class Scenario(StrictModel):
    id: Slug
    given: str
    when: str
    then: str


class RequirementPlan(StrictModel):
    required: bool
    plan: str = Field(min_length=1, max_length=65536)


class DefinitionOfDone(StrictModel):
    required_checks: list[Slug] = Field(default_factory=list)
    review_required: bool = True
    manual_validations: list[str] = Field(default_factory=list)


class FeatureSpec(StrictModel):
    schema_version: Literal[1] = 1
    feature_id: Slug
    revision: int = Field(ge=1)
    status: SpecStatus
    title: Title
    brief_ref: ArtifactRef | None = None
    problem: str = Field(min_length=1, max_length=65536)
    in_scope: list[str] = Field(min_length=1)
    out_of_scope: list[str]
    surfaces: list[Slug] = Field(min_length=1)
    scenarios: list[Scenario] = Field(min_length=1)
    acceptance: list[Criterion] = Field(min_length=1)
    dod: DefinitionOfDone
    test_strategy: list[str] = Field(default_factory=list)
    error_cases: list[str] = Field(default_factory=list)
    contract_refs: list[ArtifactRef]
    dependencies: list[str]
    migrations: RequirementPlan
    rollback: RequirementPlan
    design_refs: list[str]
    rbac_requirements: list[str]
    mobile_requirements: list[str] = Field(default_factory=list)
    open_questions: list[str]

    @model_validator(mode="after")
    def identifiers_are_unique(self) -> FeatureSpec:
        scenario_ids = [scenario.id for scenario in self.scenarios]
        criterion_ids = [criterion.id for criterion in self.acceptance]
        if len(scenario_ids) != len(set(scenario_ids)):
            raise ValueError("scenario ids must be unique")
        if len(criterion_ids) != len(set(criterion_ids)):
            raise ValueError("criterion ids must be unique")
        return self

    def freezeable(self) -> bool:
        return not self.open_questions and bool(self.test_strategy) and bool(self.error_cases)


class Task(StrictModel):
    id: Slug
    role: Slug
    surface_ids: list[Slug] = Field(min_length=1)
    criterion_ids: list[Slug] = Field(default_factory=list)
    depends_on: list[Slug] = Field(default_factory=list)
    read_paths: list[str] = Field(default_factory=list)
    write_paths: list[str] = Field(min_length=1)
    account_ref: str
    model: str
    effort: str | None = None
    check_ids: list[Slug] = Field(default_factory=list)
    limits: dict[str, int] = Field(default_factory=dict)

    @model_validator(mode="after")
    def safe_paths(self) -> Task:
        for path in self.read_paths + self.write_paths:
            validate_rel_path(path)
        return self


class TaskPlan(StrictModel):
    schema_version: Literal[1] = 1
    spec_ref: ArtifactRef
    profile_ref: ArtifactRef
    base_commit: str = Field(pattern=r"^[a-f0-9]{40,64}$")
    tasks: list[Task] = Field(min_length=1)
    coverage: dict[Slug, list[Slug]]

    @model_validator(mode="after")
    def graph_is_valid(self) -> TaskPlan:
        ids = [task.id for task in self.tasks]
        if len(ids) != len(set(ids)):
            raise ValueError("task ids must be unique")
        known = set(ids)
        if any(not set(task.depends_on) <= known for task in self.tasks):
            raise ValueError("unknown task dependency")
        incoming = {task.id: set(task.depends_on) for task in self.tasks}
        ready = [task_id for task_id, deps in incoming.items() if not deps]
        visited: set[str] = set()
        while ready:
            current = ready.pop()
            visited.add(current)
            for task_id, deps in incoming.items():
                deps.discard(current)
                if not deps and task_id not in visited:
                    ready.append(task_id)
        if visited != known:
            raise ValueError("task graph contains a cycle")
        covered = {criterion for values in self.coverage.values() for criterion in values}
        task_criteria = {criterion for task in self.tasks for criterion in task.criterion_ids}
        if covered != task_criteria:
            raise ValueError("coverage and task criteria differ")
        return self


class Stage(StrEnum):
    INTAKE = "intake"
    BRAINSTORM = "brainstorm"
    SPEC = "spec"
    PLAN = "plan"
    BUILD = "build"
    CHECKS = "checks"
    REVIEW = "review"
    FIX = "fix"
    SHIP = "ship"
    DONE = "done"


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_USER = "waiting_user"
    WAITING_AUTH = "waiting_auth"
    WAITING_QUOTA = "waiting_quota"
    PAUSED = "paused"
    BLOCKED = "blocked"
    BLOCKED_UNCERTAIN = "blocked_uncertain"
    FAILED = "failed"
    CANCELLED = "cancelled"
    COMPLETED = "completed"


class RunState(StrictModel):
    id: str
    project_id: str
    feature_id: str
    stage: Stage
    status: RunStatus
    state_version: int = Field(ge=1)
    base_commit: str
    candidate_tree_hash: str | None = None
    fix_cycles: int = Field(default=0, ge=0)
    created_at: datetime
    updated_at: datetime


class EventType(StrEnum):
    START = "start"
    PHASE_SUCCEEDED = "phase_succeeded"
    CHECKS_FAILED = "checks_failed"
    REVIEW_FIX = "review_fix"
    BLOCK = "block"
    WAIT_USER = "wait_user"
    WAIT_AUTH = "wait_auth"
    WAIT_QUOTA = "wait_quota"
    PAUSE = "pause"
    RESUME = "resume"
    CANCEL = "cancel"
    FAIL = "fail"
    EFFECT_UNCERTAIN = "effect_uncertain"


class WorkflowEvent(StrictModel):
    type: EventType
    facts: dict[str, Any] = Field(default_factory=dict)


class Intent(StrictModel):
    kind: Literal["dispatch", "run_checks", "request", "reconcile_effect", "stop_workers"]
    payload: dict[str, Any] = Field(default_factory=dict)


_NEXT_STAGE = {
    Stage.INTAKE: Stage.BRAINSTORM,
    Stage.BRAINSTORM: Stage.SPEC,
    Stage.SPEC: Stage.PLAN,
    Stage.PLAN: Stage.BUILD,
    Stage.BUILD: Stage.CHECKS,
    Stage.CHECKS: Stage.REVIEW,
    Stage.REVIEW: Stage.SHIP,
    Stage.FIX: Stage.CHECKS,
    Stage.SHIP: Stage.DONE,
}


def reduce_run(
    state: RunState, event: WorkflowEvent, now: datetime
) -> tuple[RunState, list[Intent]]:
    """Pure workflow transition. It never reads clocks, files, SDKs, Git, or storage."""
    update: dict[str, Any] = {"state_version": state.state_version + 1, "updated_at": now}
    intents: list[Intent] = []
    if event.type == EventType.START and state.status == RunStatus.QUEUED:
        update["status"] = RunStatus.RUNNING
        intents.append(Intent(kind="dispatch", payload={"stage": state.stage.value}))
    elif event.type == EventType.PHASE_SUCCEEDED and state.status == RunStatus.RUNNING:
        if not event.facts.get("evidence_complete", False):
            raise ValueError("phase success requires complete evidence")
        next_stage = _NEXT_STAGE.get(state.stage)
        if next_stage is None:
            raise ValueError("no next stage")
        update["stage"] = next_stage
        if next_stage == Stage.DONE:
            update["status"] = RunStatus.COMPLETED
        elif next_stage == Stage.CHECKS:
            intents.append(Intent(kind="run_checks"))
        else:
            intents.append(Intent(kind="dispatch", payload={"stage": next_stage.value}))
    elif event.type in {EventType.CHECKS_FAILED, EventType.REVIEW_FIX}:
        update.update(stage=Stage.FIX, status=RunStatus.RUNNING, fix_cycles=state.fix_cycles + 1)
        intents.append(Intent(kind="dispatch", payload={"stage": "fix"}))
    elif event.type == EventType.WAIT_USER:
        update["status"] = RunStatus.WAITING_USER
        intents.append(Intent(kind="request", payload=event.facts))
    elif event.type == EventType.WAIT_AUTH:
        update["status"] = RunStatus.WAITING_AUTH
    elif event.type == EventType.WAIT_QUOTA:
        update["status"] = RunStatus.WAITING_QUOTA
    elif event.type == EventType.PAUSE:
        update["status"] = RunStatus.PAUSED
        intents.append(Intent(kind="stop_workers", payload={"graceful": True}))
    elif event.type == EventType.RESUME and state.status in {
        RunStatus.PAUSED,
        RunStatus.WAITING_USER,
        RunStatus.WAITING_AUTH,
        RunStatus.WAITING_QUOTA,
    }:
        update["status"] = RunStatus.RUNNING
        intents.append(Intent(kind="dispatch", payload={"stage": state.stage.value}))
    elif event.type == EventType.CANCEL:
        update["status"] = RunStatus.CANCELLED
        intents.append(Intent(kind="stop_workers", payload={"graceful": False}))
    elif event.type == EventType.EFFECT_UNCERTAIN:
        update["status"] = RunStatus.BLOCKED_UNCERTAIN
        intents.append(Intent(kind="reconcile_effect", payload=event.facts))
    elif event.type == EventType.BLOCK:
        update["status"] = RunStatus.BLOCKED
    elif event.type == EventType.FAIL:
        update["status"] = RunStatus.FAILED
    else:
        raise ValueError(f"invalid transition: {state.status}/{state.stage} + {event.type}")
    return state.model_copy(update=update), intents


def slugify(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:80]
    return value or "project"
