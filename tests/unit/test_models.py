from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from cohorte.domain.models import (
    AgentDefaults,
    ArtifactRef,
    CheckDefinition,
    Criterion,
    EventType,
    ProjectProfile,
    Provider,
    RunState,
    RunStatus,
    Stage,
    Surface,
    Task,
    TaskPlan,
    VcsConfig,
    WorkflowEvent,
    reduce_run,
)


def profile() -> ProjectProfile:
    return ProjectProfile(
        project_id="project",
        name="Project",
        language="fr",
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="backend",
                label="Backend",
                paths=["src"],
                role_profile="implementer",
                check_ids=["test"],
            )
        ],
        checks=[CheckDefinition(id="test", argv=["pytest"], timeout_seconds=10)],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )


def test_profile_rejects_unknown_check() -> None:
    with pytest.raises(ValidationError, match="unknown check"):
        ProjectProfile(
            project_id="project",
            name="Project",
            language="fr",
            vcs=VcsConfig(),
            surfaces=[
                Surface(
                    id="backend",
                    label="Backend",
                    paths=["src"],
                    role_profile="implementer",
                    check_ids=["missing"],
                )
            ],
            agent_defaults=AgentDefaults(provider=Provider.CODEX),
        )


def test_profile_rejects_path_traversal() -> None:
    with pytest.raises(ValidationError, match="traversal"):
        Surface(id="backend", label="Backend", paths=["../secret"], role_profile="implementer")


def test_profile_rejects_nested_path_ownership() -> None:
    with pytest.raises(ValidationError, match="ambiguous path ownership"):
        ProjectProfile(
            project_id="project",
            name="Project",
            language="fr",
            vcs=VcsConfig(),
            surfaces=[
                Surface(id="root", label="Root", paths=["src"], role_profile="implementer"),
                Surface(
                    id="nested",
                    label="Nested",
                    paths=["src/api"],
                    role_profile="implementer",
                ),
            ],
            agent_defaults=AgentDefaults(provider=Provider.CODEX),
        )


def test_profile_rejects_surface_dependency_cycle() -> None:
    with pytest.raises(ValidationError, match="dependency graph contains a cycle"):
        ProjectProfile(
            project_id="project",
            name="Project",
            language="fr",
            vcs=VcsConfig(),
            surfaces=[
                Surface(
                    id="one",
                    label="One",
                    paths=["one"],
                    depends_on=["two"],
                    role_profile="implementer",
                ),
                Surface(
                    id="two",
                    label="Two",
                    paths=["two"],
                    depends_on=["one"],
                    role_profile="implementer",
                ),
            ],
            agent_defaults=AgentDefaults(provider=Provider.CODEX),
        )


def test_automatic_criterion_requires_check() -> None:
    with pytest.raises(ValidationError, match="requires a check"):
        Criterion(id="ac-1", statement="Works", verification="automatic")


def test_task_plan_rejects_cycle() -> None:
    ref = ArtifactRef(id="x", revision=1, sha256="a" * 64)
    first = Task(
        id="first",
        role="implementer",
        surface_ids=["backend"],
        criterion_ids=["ac-1"],
        depends_on=["second"],
        write_paths=["src"],
        account_ref="a",
        model="m",
    )
    second = Task(
        id="second",
        role="implementer",
        surface_ids=["backend"],
        criterion_ids=["ac-2"],
        depends_on=["first"],
        write_paths=["tests"],
        account_ref="a",
        model="m",
    )
    with pytest.raises(ValidationError, match="cycle"):
        TaskPlan(
            spec_ref=ref,
            profile_ref=ref,
            base_commit="b" * 40,
            tasks=[first, second],
            coverage={"first": ["ac-1"], "second": ["ac-2"]},
        )


def state(stage: Stage = Stage.BUILD, status: RunStatus = RunStatus.RUNNING) -> RunState:
    now = datetime.now(UTC)
    return RunState(
        id="run",
        project_id="project",
        feature_id="feature",
        stage=stage,
        status=status,
        state_version=1,
        base_commit="a" * 40,
        created_at=now,
        updated_at=now,
    )


def test_reducer_requires_evidence() -> None:
    with pytest.raises(ValueError, match="complete evidence"):
        reduce_run(state(), WorkflowEvent(type=EventType.PHASE_SUCCEEDED), datetime.now(UTC))


def test_reducer_advances_to_checks() -> None:
    updated, intents = reduce_run(
        state(),
        WorkflowEvent(type=EventType.PHASE_SUCCEEDED, facts={"evidence_complete": True}),
        datetime.now(UTC),
    )
    assert updated.stage == Stage.CHECKS
    assert intents[0].kind == "run_checks"


def test_uncertain_effect_blocks_and_reconciles() -> None:
    updated, intents = reduce_run(
        state(Stage.SHIP),
        WorkflowEvent(type=EventType.EFFECT_UNCERTAIN, facts={"kind": "pull_request"}),
        datetime.now(UTC),
    )
    assert updated.status == RunStatus.BLOCKED_UNCERTAIN
    assert intents[0].kind == "reconcile_effect"
