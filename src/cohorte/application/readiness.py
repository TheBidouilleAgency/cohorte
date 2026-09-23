from __future__ import annotations

from dataclasses import dataclass

from cohorte.domain.auth import AccountStatus, require_subscription
from cohorte.domain.errors import CohorteError
from cohorte.domain.models import FeatureSpec, ProjectProfile, SpecStatus, TaskPlan


@dataclass(frozen=True, slots=True)
class ReadinessReport:
    ready: bool
    gaps: tuple[str, ...]


def assess_readiness(
    profile: ProjectProfile,
    spec: FeatureSpec,
    plan: TaskPlan,
    account_statuses: dict[str, AccountStatus],
) -> ReadinessReport:
    gaps: list[str] = []
    if spec.status != SpecStatus.FROZEN:
        gaps.append("spec is not frozen")
    if spec.open_questions:
        gaps.append("spec has open questions")
    surfaces = {surface.id for surface in profile.surfaces}
    missing_surfaces = set(spec.surfaces) - surfaces
    if missing_surfaces:
        gaps.append(f"profile does not own surfaces: {', '.join(sorted(missing_surfaces))}")
    criteria = {criterion.id for criterion in spec.acceptance}
    covered = {criterion for values in plan.coverage.values() for criterion in values}
    if criteria != covered:
        gaps.append("plan does not cover every acceptance criterion exactly")
    for task in plan.tasks:
        status = account_statuses.get(task.account_ref)
        if status is None:
            gaps.append(f"task {task.id} has no account status")
            continue
        try:
            require_subscription(status)
        except CohorteError as error:
            gaps.append(f"task {task.id}: {error.code.value}")
    return ReadinessReport(ready=not gaps, gaps=tuple(gaps))
