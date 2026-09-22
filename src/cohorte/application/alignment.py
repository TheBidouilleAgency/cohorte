from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator

from cohorte.adapters.git import path_is_owned
from cohorte.application.context import DesignAlignmentPlan
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
    validate_rel_path,
)


class AlignmentSelection(StrictModel):
    schema_version: Literal[1] = 1
    alignment_id: Slug
    title: str = Field(min_length=1, max_length=200)
    plan_ref: ArtifactRef
    approval_ref: ArtifactRef
    approved: Literal[True]
    surfaces: list[Slug] = Field(min_length=1)
    write_paths: list[str] = Field(min_length=1)
    check_ids: list[Slug] = Field(min_length=1)
    out_of_scope: list[str]
    rollback: str = Field(min_length=1)

    @model_validator(mode="after")
    def paths_are_safe(self) -> AlignmentSelection:
        for path in self.write_paths:
            validate_rel_path(path)
        return self


def alignment_subject_hash(selection: AlignmentSelection) -> str:
    payload = selection.model_dump(mode="json", exclude={"approval_ref", "approved"})
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def validate_alignment_plan(selection: AlignmentSelection, plan: DesignAlignmentPlan) -> None:
    if plan.status != "changes" or not plan.deltas:
        raise ValueError("alignment requires a design plan with pending changes")
    if not plan.snapshot_path:
        raise ValueError("alignment plan has no target snapshot path")
    if not any(
        path_is_owned(plan.snapshot_path, [path]) or path_is_owned(path, [plan.snapshot_path])
        for path in selection.write_paths
    ):
        raise CohorteError(
            ErrorCode.OWNERSHIP_VIOLATION,
            "design snapshot target is outside alignment write paths",
            "alignment was not started",
            remediation="include the target snapshot in the approved write paths",
        )


def alignment_profile(profile: ProjectProfile, selection: AlignmentSelection) -> ProjectProfile:
    surfaces = {surface.id: surface for surface in profile.surfaces}
    if missing := sorted(set(selection.surfaces) - set(surfaces)):
        raise ValueError(f"unknown alignment surfaces: {', '.join(missing)}")
    known_checks = {check.id for check in profile.checks}
    if missing := sorted(set(selection.check_ids) - known_checks):
        raise ValueError(f"unknown alignment checks: {', '.join(missing)}")
    narrowed = []
    assigned: set[str] = set()
    for surface_id in selection.surfaces:
        surface = surfaces[surface_id]
        owned = [path for path in selection.write_paths if path_is_owned(path, surface.paths)]
        if owned:
            assigned.update(owned)
            narrowed.append(
                surface.model_copy(
                    update={
                        "paths": owned,
                        "depends_on": [
                            dependency
                            for dependency in surface.depends_on
                            if dependency in selection.surfaces
                        ],
                        "check_ids": [],
                    }
                )
            )
    if unowned := sorted(set(selection.write_paths) - assigned):
        raise CohorteError(
            ErrorCode.OWNERSHIP_VIOLATION,
            f"alignment paths are not owned by selected surfaces: {', '.join(unowned)}",
            "alignment was not started",
            remediation="select the owning surfaces or narrow alignment write paths",
        )
    return profile.model_copy(update={"surfaces": narrowed})


def alignment_feature(selection: AlignmentSelection, plan: DesignAlignmentPlan) -> FeatureSpec:
    delta_descriptions = [
        f"{delta.change} {delta.key}: {delta.code_value!r} -> {delta.source_value!r}"
        for delta in plan.deltas
    ]
    return FeatureSpec(
        feature_id=selection.alignment_id,
        revision=1,
        status=SpecStatus.FROZEN,
        title=selection.title,
        brief_ref=selection.plan_ref,
        problem="The committed design-system snapshot differs from the captured design source.",
        in_scope=delta_descriptions,
        out_of_scope=selection.out_of_scope,
        surfaces=selection.surfaces,
        scenarios=[
            Scenario(
                id="design-snapshot-aligned",
                given=f"captured design version {plan.source_version}",
                when="the approved design alignment is applied",
                then="the committed snapshot represents every planned delta",
            )
        ],
        acceptance=[
            Criterion(
                id="design-aligned",
                statement="Apply every approved design delta without unrelated changes",
                verification="automatic",
                check_ids=selection.check_ids,
                surface_ids=selection.surfaces,
                evidence_required=["design plan", "checks", "independent review"],
            )
        ],
        dod=DefinitionOfDone(
            required_checks=selection.check_ids,
            review_required=True,
            manual_validations=[],
        ),
        contract_refs=[selection.plan_ref, selection.approval_ref],
        dependencies=[],
        migrations=RequirementPlan(required=False, plan="No migration."),
        rollback=RequirementPlan(required=True, plan=selection.rollback),
        design_refs=[
            f"artifact:{selection.plan_ref.id}@{selection.plan_ref.revision}:"
            f"{selection.plan_ref.sha256}"
        ],
        rbac_requirements=[],
        open_questions=[],
    )


@dataclass(frozen=True, slots=True)
class AlignmentResult:
    applied_deltas: int
    candidate: VerticalResult


class AlignmentRunner:
    def __init__(self, runtime: WorkflowRuntime) -> None:
        self.runtime = runtime

    def run(
        self,
        repository: Path,
        worktree_parent: Path,
        profile: ProjectProfile,
        selection: AlignmentSelection,
        plan: DesignAlignmentPlan,
        run_id: str,
        *,
        observe: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> AlignmentResult:
        validate_alignment_plan(selection, plan)
        bounded = alignment_profile(profile, selection)
        candidate = VerticalRunner(self.runtime).run(
            repository,
            worktree_parent,
            bounded,
            alignment_feature(selection, plan),
            run_id,
            observe=observe,
        )
        return AlignmentResult(applied_deltas=len(plan.deltas), candidate=candidate)
