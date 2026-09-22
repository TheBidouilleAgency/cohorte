from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

from pydantic import Field

from cohorte.adapters.git import GitRepository, path_is_owned
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import (
    CheckEvidence,
    CheckStatus,
    EvidenceIdentity,
    ReviewEvidence,
    ReviewVerdict,
    require_shippable,
)
from cohorte.domain.models import (
    ArtifactRef,
    FeatureSpec,
    ProjectProfile,
    SpecStatus,
    Stage,
    StrictModel,
    Task,
    TaskPlan,
)
from cohorte.execution.checks import CheckExecution, CheckRunner


class AgentReport(StrictModel):
    summary: str
    changed_files: list[str] = Field(default_factory=list)
    blockers: list[str] = Field(default_factory=list)


class ReviewFinding(StrictModel):
    severity: str
    path: str
    message: str


class AgentReview(StrictModel):
    verdict: ReviewVerdict
    covered_surfaces: list[str]
    findings: list[ReviewFinding] = Field(default_factory=list)


class WorkflowRuntime(Protocol):
    def build(self, workspace: Path, prompt: str) -> AgentReport: ...

    def review(self, workspace: Path, prompt: str) -> AgentReview: ...

    def fix(self, workspace: Path, prompt: str) -> AgentReport: ...


@dataclass(frozen=True, slots=True)
class VerticalResult:
    feature_id: str
    worktree: str
    branch: str
    base_commit: str
    candidate_tree_hash: str
    changed_files: list[str]
    checks: list[dict[str, object]]
    review: dict[str, object]
    fix_cycles: int
    ready_to_ship: bool


def _digest_model(value: StrictModel) -> str:
    body = value.model_dump_json(exclude_none=False)
    return hashlib.sha256(body.encode()).hexdigest()


def _artifact_ref(kind: str, identifier: str, revision: int, digest: str) -> ArtifactRef:
    return ArtifactRef(id=f"{kind}:{identifier}", revision=revision, sha256=digest)


def plan_feature(profile: ProjectProfile, spec: FeatureSpec, base_commit: str) -> TaskPlan:
    if profile.policy.require_frozen_spec and spec.status != SpecStatus.FROZEN:
        raise CohorteError(
            ErrorCode.SPEC_NOT_FROZEN,
            "feature spec is not frozen",
            "build was not started",
            remediation="freeze the spec after resolving its open questions",
        )
    if spec.open_questions:
        raise ValueError("frozen spec still contains open questions")
    known_surfaces = {surface.id: surface for surface in profile.surfaces}
    missing = sorted(set(spec.surfaces) - set(known_surfaces))
    if missing:
        raise ValueError(f"unknown spec surfaces: {', '.join(missing)}")
    criteria = [criterion.id for criterion in spec.acceptance]
    write_paths = sorted({path for sid in spec.surfaces for path in known_surfaces[sid].paths})
    check_ids = sorted(
        {
            *spec.dod.required_checks,
            *(check for criterion in spec.acceptance for check in criterion.check_ids),
        }
    )
    task = Task(
        id=f"build-{spec.feature_id}"[:80],
        role=profile.agent_defaults.role_profile,
        surface_ids=spec.surfaces,
        criterion_ids=criteria,
        read_paths=["."],
        write_paths=write_paths,
        account_ref=profile.agent_defaults.account_ref or "codex-native",
        model=profile.agent_defaults.model or "account-default",
        check_ids=check_ids,
    )
    return TaskPlan(
        spec_ref=_artifact_ref("spec", spec.feature_id, spec.revision, _digest_model(spec)),
        profile_ref=_artifact_ref("profile", profile.project_id, 1, _digest_model(profile)),
        base_commit=base_commit,
        tasks=[task],
        coverage={task.id: criteria},
    )


class VerticalRunner:
    def __init__(self, runtime: WorkflowRuntime) -> None:
        self.runtime = runtime

    def run(
        self,
        repository: Path,
        worktree_parent: Path,
        profile: ProjectProfile,
        spec: FeatureSpec,
        run_id: str,
        *,
        existing_worktree: Path | None = None,
        resume_stage: Stage = Stage.BUILD,
        initial_fix_cycles: int = 0,
        observe: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> VerticalResult:
        if re.fullmatch(r"[a-z0-9-]{1,80}", run_id) is None:
            raise ValueError("run_id must contain only lowercase letters, digits, and hyphens")
        source = GitRepository(repository)
        plan = plan_feature(profile, spec, source.head)
        branch = f"cohorte/{spec.feature_id}-{run_id}"
        worktree_path = worktree_parent.resolve() / f"{spec.feature_id}-{run_id}"
        candidate = (
            GitRepository(existing_worktree)
            if existing_worktree is not None
            else source.create_worktree(worktree_path, branch)
        )
        task = plan.tasks[0]
        if resume_stage == Stage.BUILD:
            self.runtime.build(candidate.root, self._build_prompt(profile, spec, task))
            self._require_owned(candidate.changed_files(plan.base_commit), task.write_paths)
            self._observe(observe, "build", candidate, plan, {})

        fix_cycles = initial_fix_cycles
        while True:
            checks = self._checks(candidate.root, profile, task.check_ids)
            self._observe(
                observe,
                "checks",
                candidate,
                plan,
                {"passed": all(item.status == "passed" for item in checks)},
            )
            self._require_check_environment(checks)
            failed = [item for item in checks if item.status != "passed"]
            review = self.runtime.review(
                candidate.root,
                self._review_prompt(
                    profile,
                    spec,
                    plan.base_commit,
                    candidate.changed_files(plan.base_commit),
                    candidate.diff(plan.base_commit),
                ),
            )
            blocking = self._blocking_findings(profile, review)
            uncovered = sorted(set(spec.surfaces) - set(review.covered_surfaces))
            if uncovered:
                raise CohorteError(
                    ErrorCode.REVIEW_INCOMPLETE,
                    f"review did not cover surfaces: {', '.join(uncovered)}",
                    "delivery is blocked",
                    remediation="rerun independent review for every required surface",
                )
            ready = not failed and review.verdict == ReviewVerdict.READY and not blocking
            self._observe(
                observe,
                "review",
                candidate,
                plan,
                {"ready": ready, "verdict": review.verdict.value},
            )
            if ready:
                break
            if fix_cycles >= profile.policy.max_fix_cycles:
                raise CohorteError(
                    ErrorCode.REVIEW_INCOMPLETE,
                    "candidate did not become ready within the fix-cycle limit",
                    "delivery is blocked",
                    remediation="inspect check and review evidence, then start a new run",
                )
            fix_cycles += 1
            before_fix = candidate.snapshot_digest()
            actionable = review.findings if review.verdict != ReviewVerdict.READY else blocking
            self.runtime.fix(
                candidate.root,
                self._fix_prompt(spec, failed, actionable),
            )
            self._require_owned(candidate.changed_files(plan.base_commit), task.write_paths)
            self._require_fix_progress(before_fix, candidate.snapshot_digest())
            self._observe(observe, "fix", candidate, plan, {"fix_cycles": fix_cycles})

        identity = self._identity(candidate, plan, profile, spec)
        definitions = {definition.id: definition for definition in profile.checks}
        check_evidence = [
            CheckEvidence(
                check_id=item.check_id,
                required=definitions[item.check_id].required,
                status=CheckStatus(item.status),
                evidence_digest=identity.digest,
            )
            for item in checks
        ]
        review_evidence = ReviewEvidence(
            verdict=review.verdict,
            evidence_digest=identity.digest,
            covered_surfaces=review.covered_surfaces,
            unreviewed_surfaces=sorted(set(spec.surfaces) - set(review.covered_surfaces)),
            blocking_findings=[finding.message for finding in blocking],
        )
        require_shippable(identity, check_evidence, review_evidence, set(spec.surfaces))
        return VerticalResult(
            feature_id=spec.feature_id,
            worktree=str(candidate.root),
            branch=branch,
            base_commit=plan.base_commit,
            candidate_tree_hash=identity.candidate_tree_hash,
            changed_files=candidate.changed_files(plan.base_commit),
            checks=[asdict(item) for item in checks],
            review=review.model_dump(mode="json"),
            fix_cycles=fix_cycles,
            ready_to_ship=True,
        )

    @staticmethod
    def _observe(
        observe: Callable[[str, dict[str, Any]], None] | None,
        phase: str,
        candidate: GitRepository,
        plan: TaskPlan,
        data: dict[str, Any],
    ) -> None:
        if observe is not None:
            observe(
                phase,
                {
                    **data,
                    "base_commit": plan.base_commit,
                    "candidate_tree_hash": candidate.snapshot_digest(),
                },
            )

    @staticmethod
    def _require_owned(changed: list[str], allowed: list[str]) -> None:
        violations = [path for path in changed if not path_is_owned(path, allowed)]
        if violations:
            raise CohorteError(
                ErrorCode.OWNERSHIP_VIOLATION,
                f"files changed outside task ownership: {', '.join(violations)}",
                "candidate was rejected",
                remediation="restore out-of-scope files and retry",
            )

    @staticmethod
    def _require_fix_progress(before: str, after: str) -> None:
        if before == after:
            raise CohorteError(
                ErrorCode.REVIEW_INCOMPLETE,
                "fix attempt made no candidate change",
                "delivery is blocked because the fix loop stagnated",
                remediation="inspect the failed checks and findings before starting a new run",
            )

    @staticmethod
    def _require_check_environment(checks: list[CheckExecution]) -> None:
        unavailable = [check for check in checks if check.error_code == "CHECK_ENVIRONMENT"]
        if unavailable:
            issues = ", ".join(
                f"{check.check_id}:{check.environment_issue}" for check in unavailable
            )
            raise CohorteError(
                ErrorCode.CHECK_ENVIRONMENT,
                f"checks could not run in the current environment: {issues}",
                "the candidate was preserved and no automatic fix was attempted",
                retryable=True,
                remediation="restore the missing runtime resource and resume the run",
                details={"checks": [asdict(check) for check in unavailable]},
            )

    @staticmethod
    def _checks(root: Path, profile: ProjectProfile, ids: list[str]) -> list[CheckExecution]:
        definitions = {definition.id: definition for definition in profile.checks}
        missing = sorted(set(ids) - set(definitions))
        if missing:
            raise ValueError(f"unknown task checks: {', '.join(missing)}")
        runner = CheckRunner(root)
        return [runner.run(definitions[check_id]) for check_id in ids]

    @staticmethod
    def _blocking_findings(profile: ProjectProfile, review: AgentReview) -> list[ReviewFinding]:
        severities = set(profile.policy.review_blocking_severities)
        return [finding for finding in review.findings if finding.severity in severities]

    @staticmethod
    def _identity(
        repo: GitRepository,
        plan: TaskPlan,
        profile: ProjectProfile,
        spec: FeatureSpec,
    ) -> EvidenceIdentity:
        check_json = json.dumps(
            [check.model_dump(mode="json") for check in profile.checks], sort_keys=True
        )
        return EvidenceIdentity(
            base_commit=plan.base_commit,
            candidate_tree_hash=repo.snapshot_digest(),
            spec_hash=_digest_model(spec),
            profile_hash=_digest_model(profile),
            check_config_hash=hashlib.sha256(check_json.encode()).hexdigest(),
        )

    @staticmethod
    def _build_prompt(profile: ProjectProfile, spec: FeatureSpec, task: Task) -> str:
        return (
            "Implement the frozen feature in this isolated worktree. Do not commit or push. "
            f"Only modify these owned paths: {task.write_paths}.\n"
            f"Project profile:\n{profile.model_dump_json(indent=2)}\n"
            f"Frozen feature spec:\n{spec.model_dump_json(indent=2)}"
        )

    @staticmethod
    def _review_prompt(
        profile: ProjectProfile,
        spec: FeatureSpec,
        base_commit: str,
        changed_files: list[str],
        diff: str,
    ) -> str:
        return (
            "Independently review the candidate against the frozen spec. Do not modify files. "
            "Use critical/high/medium/low severities and return READY only with no blocking finding.\n"
            f"Base commit: {base_commit}\nSurfaces: {spec.surfaces}\n"
            f"Changed files to inspect in the worktree: {changed_files}\n"
            f"Spec:\n{spec.model_dump_json(indent=2)}\nProfile:\n"
            f"{profile.model_dump_json(indent=2)}\nDiff:\n{diff}"
        )

    @staticmethod
    def _fix_prompt(
        spec: FeatureSpec,
        failed: list[CheckExecution],
        findings: list[ReviewFinding],
    ) -> str:
        return (
            "Fix only the reported failures in the current worktree. Do not commit or push.\n"
            f"Feature: {spec.feature_id}\n"
            f"Failed checks: {json.dumps([asdict(item) for item in failed], default=str)}\n"
            f"Blocking review findings: {json.dumps([item.model_dump() for item in findings])}"
        )
