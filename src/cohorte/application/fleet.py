from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

from pydantic import Field, model_validator

from cohorte.adapters.git import GitRepository, path_is_owned
from cohorte.application.multisurface import MultiSurfaceResult, MultiSurfaceRunner
from cohorte.application.vertical import (
    AgentReview,
    VerticalResult,
    VerticalRunner,
    WorkflowRuntime,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import FeatureSpec, ProjectProfile, Slug, StrictModel
from cohorte.execution.checks import CheckExecution
from cohorte.execution.scheduler import paths_overlap


class FeatureOverlap(StrictModel):
    left_feature: Slug
    right_feature: Slug
    paths: list[str] = Field(min_length=1)


class FleetPlan(StrictModel):
    fleet_id: Slug
    base_commit: str = Field(pattern=r"^[a-f0-9]{40,64}$")
    feature_ids: list[Slug] = Field(min_length=1)
    dependencies: dict[Slug, list[Slug]]
    overlaps: list[FeatureOverlap]
    waves: list[list[Slug]] = Field(min_length=1)

    @model_validator(mode="after")
    def covers_features_once(self) -> FleetPlan:
        scheduled = [feature_id for wave in self.waves for feature_id in wave]
        if sorted(scheduled) != sorted(self.feature_ids) or len(scheduled) != len(set(scheduled)):
            raise ValueError("fleet waves must schedule every feature exactly once")
        return self


@dataclass(frozen=True, slots=True)
class FleetFeatureResult:
    feature_id: str
    run_id: str
    branch: str
    worktree: str
    base_commit: str
    source_commits: list[str]
    integration_head: str
    changed_files: list[str]


@dataclass(frozen=True, slots=True)
class FleetResult:
    fleet_id: str
    worktree: str
    branch: str
    base_commit: str
    candidate_tree_hash: str
    changed_files: list[str]
    plan: dict[str, object]
    features: list[dict[str, object]]
    revalidations: list[dict[str, object]]
    checks: list[dict[str, object]]
    review: dict[str, object]
    fix_cycles: int
    ready_to_ship: bool
    max_feature_parallelism: int


def _feature_paths(profile: ProjectProfile, spec: FeatureSpec) -> list[str]:
    surfaces = {surface.id: surface for surface in profile.surfaces}
    missing = set(spec.surfaces) - set(surfaces)
    if missing:
        raise ValueError(f"unknown surfaces for {spec.feature_id}: {', '.join(sorted(missing))}")
    return sorted({path for surface_id in spec.surfaces for path in surfaces[surface_id].paths})


def _topological_waves(
    feature_ids: list[str], dependencies: dict[str, set[str]], limit: int
) -> list[list[str]]:
    completed: set[str] = set()
    waves: list[list[str]] = []
    while len(completed) != len(feature_ids):
        ready = sorted(
            feature_id
            for feature_id in feature_ids
            if feature_id not in completed and dependencies[feature_id] <= completed
        )
        if not ready:
            raise ValueError("fleet dependency graph contains a cycle")
        wave = ready[:limit]
        waves.append(wave)
        completed.update(wave)
    return waves


def plan_fleet(
    profile: ProjectProfile,
    specs: list[FeatureSpec],
    fleet_id: str,
    base_commit: str,
) -> FleetPlan:
    if re.fullmatch(r"[a-z0-9-]{1,80}", fleet_id) is None:
        raise ValueError("fleet_id must contain only lowercase letters, digits, and hyphens")
    feature_ids = [spec.feature_id for spec in specs]
    if len(feature_ids) != len(set(feature_ids)):
        raise ValueError("fleet feature ids must be unique")
    known = set(feature_ids)
    dependencies = {
        spec.feature_id: {dependency for dependency in spec.dependencies if dependency in known}
        for spec in specs
    }
    _topological_waves(feature_ids, dependencies, max(1, len(feature_ids)))
    paths = {spec.feature_id: _feature_paths(profile, spec) for spec in specs}
    overlaps: list[FeatureOverlap] = []
    for index, left in enumerate(sorted(feature_ids)):
        for right in sorted(feature_ids)[index + 1 :]:
            shared = sorted(
                {
                    left_path
                    for left_path in paths[left]
                    for right_path in paths[right]
                    if paths_overlap(left_path, right_path)
                }
                | {
                    right_path
                    for left_path in paths[left]
                    for right_path in paths[right]
                    if paths_overlap(left_path, right_path)
                }
            )
            if not shared:
                continue
            overlaps.append(FeatureOverlap(left_feature=left, right_feature=right, paths=shared))
            preliminary = _topological_waves(feature_ids, dependencies, max(1, len(feature_ids)))
            order = [item for wave in preliminary for item in wave]
            if order.index(left) < order.index(right):
                dependencies[right].add(left)
            else:
                dependencies[left].add(right)
    limit = min(profile.policy.max_parallel_global, profile.policy.max_parallel_per_account)
    waves = _topological_waves(feature_ids, dependencies, limit)
    return FleetPlan(
        fleet_id=fleet_id,
        base_commit=base_commit,
        feature_ids=feature_ids,
        dependencies={key: sorted(value) for key, value in dependencies.items()},
        overlaps=overlaps,
        waves=waves,
    )


class FleetRunner:
    def __init__(self, runtime: WorkflowRuntime) -> None:
        self.runtime = runtime

    def run(
        self,
        repository: Path,
        worktree_parent: Path,
        profile: ProjectProfile,
        specs: list[FeatureSpec],
        fleet_id: str,
    ) -> FleetResult:
        source = GitRepository(repository)
        plan = plan_fleet(profile, specs, fleet_id, source.head)
        worktree_parent = worktree_parent.resolve()
        worktree_parent.mkdir(parents=True, exist_ok=True)
        branch = f"cohorte-fleet/{fleet_id}"
        candidate = source.create_worktree(
            worktree_parent / f"fleet-{fleet_id}", branch, plan.base_commit
        )
        specs_by_id = {spec.feature_id: spec for spec in specs}
        feature_results: list[FleetFeatureResult] = []
        revalidations: list[dict[str, object]] = []
        max_parallelism = 0
        bounded_policy = profile.policy.model_copy(
            update={"max_parallel_global": 1, "max_parallel_per_account": 1}
        )
        bounded_profile = profile.model_copy(update={"policy": bounded_policy})

        for wave in plan.waves:
            max_parallelism = max(max_parallelism, len(wave))
            wave_base = candidate.head
            with ThreadPoolExecutor(max_workers=len(wave)) as executor:
                futures = [
                    executor.submit(
                        self._run_feature,
                        candidate.root,
                        worktree_parent / "features",
                        bounded_profile,
                        specs_by_id[feature_id],
                        f"{fleet_id}-{feature_id}"[:80],
                    )
                    for feature_id in wave
                ]
                built = [future.result() for future in futures]
            for feature_id, result in zip(wave, built, strict=True):
                if result.base_commit != wave_base:
                    raise CohorteError(
                        ErrorCode.SPEC_STALE,
                        f"feature {feature_id} started from an unexpected base",
                        "fleet integration was stopped",
                        remediation="replan the fleet from the current integration head",
                    )
                feature_repo = GitRepository(Path(result.worktree))
                if feature_repo.is_dirty():
                    feature_repo.commit_all(
                        f"feat({feature_id}): finalize fleet candidate", fleet_id
                    )
                commits = feature_repo.commits_since(wave_base)
                if not commits:
                    raise CohorteError(
                        ErrorCode.OUTPUT_INVALID,
                        f"feature {feature_id} produced no commit",
                        "fleet integration was stopped",
                        remediation="inspect the feature candidate and retry",
                    )
                try:
                    for commit in commits:
                        candidate.cherry_pick(commit)
                except RuntimeError as error:
                    raise CohorteError(
                        ErrorCode.MERGE_CONFLICT,
                        f"feature {feature_id} conflicted during fleet integration",
                        "later features were not started",
                        remediation="add an explicit dependency or resolve the overlap and replan",
                        details={"feature_id": feature_id, "error": str(error)},
                    ) from error
                checks = self._checks_for_spec(candidate.root, profile, specs_by_id[feature_id])
                VerticalRunner._require_check_environment(checks)
                failed_check_ids = [check.check_id for check in checks if check.status != "passed"]
                if failed_check_ids:
                    raise CohorteError(
                        ErrorCode.CHECK_FAILED,
                        f"feature {feature_id} failed after fleet integration: "
                        f"{', '.join(failed_check_ids)}",
                        "later features were not started",
                        remediation="fix the integrated candidate and replan from its verified base",
                    )
                revalidations.append(
                    {
                        "feature_id": feature_id,
                        "base_before_wave": wave_base,
                        "integration_head": candidate.head,
                        "candidate_tree_hash": candidate.snapshot_digest(),
                        "checks": [asdict(check) for check in checks],
                    }
                )
                feature_results.append(
                    FleetFeatureResult(
                        feature_id=feature_id,
                        run_id=f"{fleet_id}-{feature_id}"[:80],
                        branch=result.branch,
                        worktree=result.worktree,
                        base_commit=result.base_commit,
                        source_commits=commits,
                        integration_head=candidate.head,
                        changed_files=result.changed_files,
                    )
                )

        fix_cycles = 0
        while True:
            checks = self._all_checks(candidate.root, profile, specs)
            VerticalRunner._require_check_environment(checks)
            review = self._review(candidate, profile, specs, plan.base_commit)
            blocking = VerticalRunner._blocking_findings(profile, review)
            required_surfaces = {surface for spec in specs for surface in spec.surfaces}
            uncovered = sorted(required_surfaces - set(review.covered_surfaces))
            if uncovered:
                raise CohorteError(
                    ErrorCode.REVIEW_INCOMPLETE,
                    f"fleet review did not cover surfaces: {', '.join(uncovered)}",
                    "fleet delivery is blocked",
                    remediation="rerun the fleet integration review for every touched surface",
                )
            failed_checks = [check for check in checks if check.status != "passed"]
            ready = not failed_checks and review.verdict == ReviewVerdict.READY and not blocking
            if ready:
                break
            if fix_cycles >= profile.policy.max_fix_cycles:
                raise CohorteError(
                    ErrorCode.REVIEW_INCOMPLETE,
                    "fleet candidate did not become ready within the fix-cycle limit",
                    "fleet delivery is blocked",
                    remediation="inspect global checks and fleet review evidence",
                )
            fix_cycles += 1
            before_fix = candidate.snapshot_digest()
            self.runtime.fix(
                candidate.root,
                "Fix the fleet integration candidate without committing or pushing.\n"
                f"Failed checks: {json.dumps([asdict(item) for item in failed_checks])}\n"
                f"Findings: {json.dumps([item.model_dump() for item in blocking])}",
            )
            owned = sorted({path for spec in specs for path in _feature_paths(profile, spec)})
            violations = [
                path
                for path in candidate.changed_files(plan.base_commit)
                if not path_is_owned(path, owned)
            ]
            if violations:
                raise CohorteError(
                    ErrorCode.OWNERSHIP_VIOLATION,
                    f"fleet fix changed unowned files: {', '.join(violations)}",
                    "fleet candidate was rejected",
                    remediation="restore out-of-scope files and retry",
                )
            VerticalRunner._require_fix_progress(before_fix, candidate.snapshot_digest())

        return FleetResult(
            fleet_id=fleet_id,
            worktree=str(candidate.root),
            branch=branch,
            base_commit=plan.base_commit,
            candidate_tree_hash=candidate.snapshot_digest(),
            changed_files=candidate.changed_files(plan.base_commit),
            plan=plan.model_dump(mode="json"),
            features=[asdict(item) for item in feature_results],
            revalidations=revalidations,
            checks=[asdict(item) for item in checks],
            review=review.model_dump(mode="json"),
            fix_cycles=fix_cycles,
            ready_to_ship=True,
            max_feature_parallelism=max_parallelism,
        )

    def _run_feature(
        self,
        repository: Path,
        worktree_parent: Path,
        profile: ProjectProfile,
        spec: FeatureSpec,
        run_id: str,
    ) -> VerticalResult | MultiSurfaceResult:
        if len(spec.surfaces) > 1:
            return MultiSurfaceRunner(self.runtime).run(
                repository, worktree_parent, profile, spec, run_id
            )
        return VerticalRunner(self.runtime).run(repository, worktree_parent, profile, spec, run_id)

    @staticmethod
    def _check_ids(profile: ProjectProfile, spec: FeatureSpec) -> list[str]:
        surfaces = {surface.id: surface for surface in profile.surfaces}
        return sorted(
            {
                *spec.dod.required_checks,
                *(check for criterion in spec.acceptance for check in criterion.check_ids),
                *(
                    check
                    for surface_id in spec.surfaces
                    for check in surfaces[surface_id].check_ids
                ),
            }
        )

    @classmethod
    def _checks_for_spec(
        cls, root: Path, profile: ProjectProfile, spec: FeatureSpec
    ) -> list[CheckExecution]:
        return VerticalRunner._checks(root, profile, cls._check_ids(profile, spec))

    @classmethod
    def _all_checks(
        cls, root: Path, profile: ProjectProfile, specs: list[FeatureSpec]
    ) -> list[CheckExecution]:
        ids = sorted({check for spec in specs for check in cls._check_ids(profile, spec)})
        return VerticalRunner._checks(root, profile, ids)

    def _review(
        self,
        candidate: GitRepository,
        profile: ProjectProfile,
        specs: list[FeatureSpec],
        base_commit: str,
    ) -> AgentReview:
        surfaces = sorted({surface for spec in specs for surface in spec.surfaces})
        prompt = (
            "Independently review the complete fleet candidate. Do not modify files. "
            "Return READY only when every feature and cross-feature interaction is blocker-free.\n"
            f"Base commit: {base_commit}\nSurfaces: {surfaces}\n"
            f"Changed files: {candidate.changed_files(base_commit)}\n"
            f"Specs: {json.dumps([spec.model_dump(mode='json') for spec in specs])}\n"
            f"Profile: {profile.model_dump_json()}\nDiff:\n{candidate.diff(base_commit)}"
        )
        return self.runtime.review(candidate.root, prompt)
