from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator

from cohorte.adapters.git import path_is_owned
from cohorte.application.vertical import VerticalResult, VerticalRunner, WorkflowRuntime
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import (
    ArtifactRef,
    Criterion,
    DefinitionOfDone,
    FeatureSpec,
    ProjectProfile,
    RequirementPlan,
    Scenario,
    Slug,
    SpecStatus,
    StrictModel,
    Surface,
    validate_rel_path,
)
from cohorte.execution.checks import CheckRunner


class RegressionMode(StrEnum):
    AUTOMATIC = "automatic"
    MANUAL = "manual"


class PatchSpec(StrictModel):
    schema_version: Literal[1] = 1
    patch_id: Slug
    revision: int = Field(default=1, ge=1)
    status: Literal["frozen"] = "frozen"
    title: str = Field(min_length=1, max_length=200)
    source_ref: ArtifactRef
    reproduction: str = Field(min_length=1, max_length=65536)
    observed_behavior: str = Field(min_length=1, max_length=65536)
    expected_behavior: str = Field(min_length=1, max_length=65536)
    surfaces: list[Slug] = Field(min_length=1)
    write_paths: list[str] = Field(min_length=1)
    regression_mode: RegressionMode
    regression_check_ids: list[Slug] = Field(default_factory=list)
    in_scope: list[str] = Field(min_length=1)
    out_of_scope: list[str]
    rollback: str = Field(min_length=1)
    open_questions: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def frozen_patch_is_executable(self) -> PatchSpec:
        for path in self.write_paths:
            validate_rel_path(path)
        if self.open_questions:
            raise ValueError("frozen patch cannot contain open questions")
        if self.regression_mode == RegressionMode.AUTOMATIC and not self.regression_check_ids:
            raise ValueError("automatic patch requires a regression check")
        if self.regression_mode == RegressionMode.MANUAL and self.regression_check_ids:
            raise ValueError("manual patch cannot claim automatic regression checks")
        return self


@dataclass(frozen=True, slots=True)
class PatchResult:
    patch_id: str
    reproduction_checks: list[dict[str, object]]
    reproduction_observed: bool
    candidate: VerticalResult


def patch_profile(profile: ProjectProfile, patch: PatchSpec) -> ProjectProfile:
    surfaces = {surface.id: surface for surface in profile.surfaces}
    missing = set(patch.surfaces) - set(surfaces)
    if missing:
        raise ValueError(f"unknown patch surfaces: {', '.join(sorted(missing))}")
    check_ids = {check.id for check in profile.checks}
    missing_checks = set(patch.regression_check_ids) - check_ids
    if missing_checks:
        raise ValueError(f"unknown regression checks: {', '.join(sorted(missing_checks))}")
    narrowed: list[Surface] = []
    assigned: set[str] = set()
    for surface_id in patch.surfaces:
        surface = surfaces[surface_id]
        owned = [path for path in patch.write_paths if path_is_owned(path, surface.paths)]
        if owned:
            assigned.update(owned)
            narrowed.append(
                surface.model_copy(
                    update={
                        "paths": owned,
                        "depends_on": [
                            dependency
                            for dependency in surface.depends_on
                            if dependency in patch.surfaces
                        ],
                        "check_ids": [],
                    }
                )
            )
    unowned = sorted(set(patch.write_paths) - assigned)
    if unowned:
        raise CohorteError(
            ErrorCode.OWNERSHIP_VIOLATION,
            f"patch paths are not owned by selected surfaces: {', '.join(unowned)}",
            "patch was not started",
            remediation="select the owning surface or narrow the patch paths",
        )
    return profile.model_copy(update={"surfaces": narrowed})


def patch_feature_spec(patch: PatchSpec) -> FeatureSpec:
    verification: Literal["automatic", "manual"] = (
        "automatic" if patch.regression_mode == RegressionMode.AUTOMATIC else "manual"
    )
    return FeatureSpec(
        schema_version=1,
        feature_id=patch.patch_id,
        revision=patch.revision,
        status=SpecStatus.FROZEN,
        title=patch.title,
        brief_ref=patch.source_ref,
        problem=patch.observed_behavior,
        in_scope=patch.in_scope,
        out_of_scope=patch.out_of_scope,
        surfaces=patch.surfaces,
        scenarios=[
            Scenario(
                id="bug-reproduction",
                given=patch.reproduction,
                when="the affected behavior is exercised",
                then=patch.expected_behavior,
            )
        ],
        acceptance=[
            Criterion(
                id="regression-fixed",
                statement=patch.expected_behavior,
                verification=verification,
                check_ids=patch.regression_check_ids,
                surface_ids=patch.surfaces,
                evidence_required=["red-before-fix", "green-after-fix"],
            )
        ],
        dod=DefinitionOfDone(
            required_checks=patch.regression_check_ids,
            review_required=True,
            manual_validations=(
                ["Confirm the reproduction no longer exhibits the observed behavior"]
                if patch.regression_mode == RegressionMode.MANUAL
                else []
            ),
        ),
        contract_refs=[patch.source_ref],
        dependencies=[],
        migrations=RequirementPlan(required=False, plan="No migration for the bounded patch."),
        rollback=RequirementPlan(required=True, plan=patch.rollback),
        design_refs=[],
        rbac_requirements=[],
        open_questions=[],
    )


class PatchRunner:
    def __init__(self, runtime: WorkflowRuntime) -> None:
        self.runtime = runtime

    def run(
        self,
        repository: Path,
        worktree_parent: Path,
        profile: ProjectProfile,
        patch: PatchSpec,
        run_id: str,
        *,
        observe: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> PatchResult:
        if patch.regression_mode != RegressionMode.AUTOMATIC:
            raise CohorteError(
                ErrorCode.REPRODUCTION_MISSING,
                "manual patch reproduction has no accepted human evidence",
                "automated patch execution was not started",
                remediation="record a candidate-bound manual reproduction decision or add a failing check",
            )
        bounded_profile = patch_profile(profile, patch)
        definitions = {definition.id: definition for definition in bounded_profile.checks}
        reproduction = [
            CheckRunner(repository).run(definitions[check_id])
            for check_id in patch.regression_check_ids
        ]
        not_red = [check.check_id for check in reproduction if check.status != "failed"]
        if not_red:
            raise CohorteError(
                ErrorCode.REPRODUCTION_MISSING,
                f"regression checks did not demonstrate the bug: {', '.join(not_red)}",
                "patch implementation was not started",
                remediation="add or correct a regression check that fails for the observed behavior",
                details={"checks": [asdict(check) for check in reproduction]},
            )
        candidate: VerticalResult = VerticalRunner(self.runtime).run(
            repository,
            worktree_parent,
            bounded_profile,
            patch_feature_spec(patch),
            run_id,
            observe=observe,
        )
        return PatchResult(
            patch_id=patch.patch_id,
            reproduction_checks=[asdict(check) for check in reproduction],
            reproduction_observed=True,
            candidate=candidate,
        )
