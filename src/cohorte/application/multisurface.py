from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from cohorte.adapters.git import GitRepository
from cohorte.application.durable import SqliteTaskJournal, TaskAttemptHandle
from cohorte.application.vertical import (
    AgentReview,
    VerticalRunner,
    WorkflowRuntime,
    _artifact_ref,
    _digest_model,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import (
    CheckEvidence,
    CheckStatus,
    ReviewEvidence,
    ReviewVerdict,
    require_shippable,
)
from cohorte.domain.models import FeatureSpec, ProjectProfile, SpecStatus, Stage, Task, TaskPlan
from cohorte.execution.scheduler import schedule_ready


@dataclass(frozen=True, slots=True)
class TaskResult:
    task_id: str
    surface_id: str
    branch: str
    worktree: str
    base_commit: str
    commit: str
    changed_files: list[str]


@dataclass(frozen=True, slots=True)
class MultiSurfaceResult:
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
    tasks: list[dict[str, object]]
    max_scheduled_parallelism: int


def plan_multisurface(profile: ProjectProfile, spec: FeatureSpec, base_commit: str) -> TaskPlan:
    if profile.policy.require_frozen_spec and spec.status != SpecStatus.FROZEN:
        raise CohorteError(
            ErrorCode.SPEC_NOT_FROZEN,
            "feature spec is not frozen",
            "build was not started",
            remediation="freeze the spec after resolving its open questions",
        )
    if spec.open_questions:
        raise ValueError("frozen spec still contains open questions")
    surfaces = {surface.id: surface for surface in profile.surfaces}
    selected = set(spec.surfaces)
    missing = sorted(selected - set(surfaces))
    if missing:
        raise ValueError(f"unknown spec surfaces: {', '.join(missing)}")
    for surface_id in spec.surfaces:
        missing_dependencies = set(surfaces[surface_id].depends_on) - selected
        if missing_dependencies:
            names = ", ".join(sorted(missing_dependencies))
            raise ValueError(f"surface {surface_id} requires omitted surfaces: {names}")

    criteria_by_surface: dict[str, list[str]] = {surface_id: [] for surface_id in spec.surfaces}
    for criterion in spec.acceptance:
        unknown = set(criterion.surface_ids) - selected
        if unknown:
            raise ValueError(
                f"criterion {criterion.id} references unknown surfaces: {', '.join(sorted(unknown))}"
            )
        targets = list(criterion.surface_ids)
        if not targets:
            matches = [
                surface_id
                for surface_id in spec.surfaces
                if set(criterion.check_ids) & set(surfaces[surface_id].check_ids)
            ]
            targets = matches if len(matches) == 1 else list(spec.surfaces)
        for surface_id in targets:
            criteria_by_surface[surface_id].append(criterion.id)

    tasks: list[Task] = []
    coverage: dict[str, list[str]] = {}
    criteria = {criterion.id: criterion for criterion in spec.acceptance}
    for surface_id in spec.surfaces:
        surface = surfaces[surface_id]
        task_id = f"build-{surface_id}"[:80]
        assigned = criteria_by_surface[surface_id]
        check_ids = sorted(
            {
                *surface.check_ids,
                *(
                    check_id
                    for criterion_id in assigned
                    for check_id in criteria[criterion_id].check_ids
                ),
            }
        )
        dependency_paths = sorted(
            {path for dependency in surface.depends_on for path in surfaces[dependency].paths}
        )
        task = Task(
            id=task_id,
            role=surface.role_profile,
            surface_ids=[surface_id],
            criterion_ids=assigned,
            depends_on=[f"build-{dependency}"[:80] for dependency in surface.depends_on],
            read_paths=dependency_paths,
            write_paths=surface.paths,
            account_ref=profile.agent_defaults.account_ref or "codex-native",
            model=profile.agent_defaults.model or "account-default",
            check_ids=check_ids,
        )
        tasks.append(task)
        coverage[task_id] = assigned
    covered = {criterion_id for values in coverage.values() for criterion_id in values}
    expected = {criterion.id for criterion in spec.acceptance}
    if covered != expected:
        raise ValueError("multi-surface plan does not cover every acceptance criterion")
    return TaskPlan(
        spec_ref=_artifact_ref("spec", spec.feature_id, spec.revision, _digest_model(spec)),
        profile_ref=_artifact_ref("profile", profile.project_id, 1, _digest_model(profile)),
        base_commit=base_commit,
        tasks=tasks,
        coverage=coverage,
    )


class MultiSurfaceRunner:
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
        task_journal: SqliteTaskJournal | None = None,
        task_observe: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> MultiSurfaceResult:
        if (
            not run_id
            or len(run_id) > 80
            or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in run_id)
        ):
            raise ValueError("run_id must contain only lowercase letters, digits, and hyphens")
        source = GitRepository(repository)
        plan = plan_multisurface(profile, spec, source.head)
        if len(plan.tasks) < 2:
            raise ValueError("multi-surface runner requires at least two tasks")
        worktree_parent = worktree_parent.resolve()
        worktree_parent.mkdir(parents=True, exist_ok=True)
        branch = f"cohorte/{spec.feature_id}-{run_id}"
        candidate_path = worktree_parent / f"{spec.feature_id}-{run_id}"
        candidate = (
            GitRepository(existing_worktree)
            if existing_worktree is not None
            else source.create_worktree(candidate_path, branch, plan.base_commit)
        )

        completed: set[str] = set()
        task_results: list[TaskResult] = []
        max_parallelism = 0
        tasks_by_id = {task.id: task for task in plan.tasks}
        if task_journal is not None:
            task_journal.prepare(plan.tasks)
            records = task_journal.records()
            for task in plan.tasks:
                record = records[task.id]
                payload = record["payload"]
                status = str(record["status"])
                if status == "running":
                    recovered = self._recover_running_task(run_id, task, record, task_journal)
                    if recovered is not None:
                        payload = recovered
                        status = "completed"
                if status == "completed":
                    integration_commit = candidate.commit_for_task(run_id, task.id)
                    if integration_commit is None:
                        integration_commit = self._integrate(
                            candidate, task, str(payload["commit"])
                        )
                    task_journal.integrated(task.id, integration_commit)
                    status = "integrated"
                    self._task_observe(
                        task_observe,
                        "task.integrated",
                        {
                            "task_id": task.id,
                            "integration_commit": integration_commit,
                            "recovered": True,
                        },
                    )
                if status == "integrated":
                    completed.add(task.id)
                    task_results.append(self._result_from_payload(task, payload))
            wave_sizes: dict[str, int] = {}
            for result in task_results:
                wave_sizes[result.base_commit] = wave_sizes.get(result.base_commit, 0) + 1
            max_parallelism = max([max_parallelism, *wave_sizes.values()])
        elif existing_worktree is not None and resume_stage == Stage.BUILD:
            raise CohorteError(
                ErrorCode.RUNTIME_INCOMPATIBLE,
                "multi-surface build has no completed phase checkpoint",
                "automatic mid-build recovery is not yet safe",
                remediation="start a new run; the existing worktrees remain available for inspection",
            )
        if resume_stage != Stage.BUILD:
            completed = set(tasks_by_id)
        while len(completed) != len(plan.tasks):
            batch = schedule_ready(
                plan.tasks,
                completed,
                [],
                max_parallel_per_account=profile.policy.max_parallel_per_account,
                max_parallel_global=profile.policy.max_parallel_global,
            )
            if not batch:
                raise ValueError("task graph made no scheduling progress")
            max_parallelism = max(max_parallelism, len(batch))
            batch_base = candidate.head
            prepared: list[tuple[Task, GitRepository, str, TaskAttemptHandle | None]] = []
            for task in batch:
                ordinal = task_journal.next_ordinal(task.id) if task_journal is not None else 1
                suffix = f"-a{ordinal}" if task_journal is not None else ""
                task_branch = f"cohorte-task/{run_id}-{task.id}{suffix}"
                task_path = worktree_parent / f"{spec.feature_id}-{run_id}-{task.id}{suffix}"
                task_repo = source.create_worktree(task_path, task_branch, batch_base)
                handle = (
                    task_journal.start(task, ordinal, batch_base, task_branch, str(task_repo.root))
                    if task_journal is not None
                    else None
                )
                prepared.append((task, task_repo, task_branch, handle))

            with ThreadPoolExecutor(max_workers=len(prepared)) as executor:
                futures = [
                    executor.submit(
                        self._build_and_commit,
                        task_repo,
                        task,
                        profile,
                        spec,
                        run_id,
                        batch_base,
                    )
                    for task, task_repo, _, _ in prepared
                ]
                built = [future.result() for future in futures]

            for (task, task_repo, task_branch, handle), (commit, changed) in zip(
                prepared, built, strict=True
            ):
                if task_journal is not None and handle is not None:
                    task_journal.complete(
                        handle,
                        task,
                        batch_base,
                        task_branch,
                        str(task_repo.root),
                        commit,
                        changed,
                    )
                integration_commit = self._integrate(candidate, task, commit)
                if task_journal is not None:
                    task_journal.integrated(task.id, integration_commit)
                result = TaskResult(
                    task_id=task.id,
                    surface_id=task.surface_ids[0],
                    branch=task_branch,
                    worktree=str(task_repo.root),
                    base_commit=batch_base,
                    commit=commit,
                    changed_files=changed,
                )
                task_results.append(result)
                completed.add(task.id)
                self._task_observe(
                    task_observe,
                    "task.integrated",
                    {
                        "task_id": task.id,
                        "integration_commit": integration_commit,
                        "recovered": False,
                    },
                )

        if resume_stage == Stage.BUILD:
            self._observe(
                observe,
                "build",
                candidate,
                plan,
                {"tasks_completed": len(completed), "max_parallelism": max_parallelism},
            )

        check_ids = sorted(
            {
                *spec.dod.required_checks,
                *(check_id for task in tasks_by_id.values() for check_id in task.check_ids),
            }
        )
        fix_cycles = initial_fix_cycles
        while True:
            checks = VerticalRunner._checks(candidate.root, profile, check_ids)
            VerticalRunner._require_check_environment(checks)
            self._observe(
                observe,
                "checks",
                candidate,
                plan,
                {"passed": all(item.status == "passed" for item in checks)},
            )
            failed = [item for item in checks if item.status != "passed"]
            review = self._review_candidate(candidate, profile, spec, plan.base_commit)
            blocking = VerticalRunner._blocking_findings(profile, review)
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
                    "integrated candidate did not become ready within the fix-cycle limit",
                    "delivery is blocked",
                    remediation="inspect global checks and integration review evidence",
                )
            fix_cycles += 1
            before_fix = candidate.snapshot_digest()
            self.runtime.fix(candidate.root, VerticalRunner._fix_prompt(spec, failed, blocking))
            owned = [path for task in plan.tasks for path in task.write_paths]
            VerticalRunner._require_owned(candidate.changed_files(plan.base_commit), owned)
            VerticalRunner._require_fix_progress(before_fix, candidate.snapshot_digest())
            self._observe(observe, "fix", candidate, plan, {"fix_cycles": fix_cycles})

        identity = VerticalRunner._identity(candidate, plan, profile, spec)
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
        return MultiSurfaceResult(
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
            tasks=[asdict(item) for item in task_results],
            max_scheduled_parallelism=max_parallelism,
        )

    def _build_and_commit(
        self,
        task_repo: GitRepository,
        task: Task,
        profile: ProjectProfile,
        spec: FeatureSpec,
        run_id: str,
        base_commit: str,
    ) -> tuple[str, list[str]]:
        self.runtime.build(
            task_repo.root,
            VerticalRunner._build_prompt(profile, spec, task)
            + f"\nExecute only task {task.id}. Criteria: {task.criterion_ids}. "
            + f"Dependency paths are read-only: {task.read_paths}.",
        )
        changed = task_repo.changed_files(base_commit)
        VerticalRunner._require_owned(changed, task.write_paths)
        if not changed:
            raise CohorteError(
                ErrorCode.OUTPUT_INVALID,
                f"task {task.id} produced no change",
                "the task was not integrated",
                remediation="retry the task with a concrete implementation instruction",
            )
        commit = task_repo.commit_task(
            f"feat({task.surface_ids[0]}): implement {spec.feature_id}", run_id, task.id
        )
        return commit, changed

    @staticmethod
    def _integrate(candidate: GitRepository, task: Task, commit: str) -> str:
        try:
            return candidate.cherry_pick(commit)
        except RuntimeError as error:
            raise CohorteError(
                ErrorCode.MERGE_CONFLICT,
                f"task {task.id} conflicted while integrating into the candidate",
                "the candidate was not advanced past the conflicting task",
                remediation="resolve ownership or dependency boundaries and retry the run",
                details={"task_id": task.id, "commit": commit, "error": str(error)},
            ) from error

    @staticmethod
    def _result_from_payload(task: Task, payload: dict[str, Any]) -> TaskResult:
        return TaskResult(
            task_id=task.id,
            surface_id=task.surface_ids[0],
            branch=str(payload["branch"]),
            worktree=str(payload["worktree"]),
            base_commit=str(payload["base_commit"]),
            commit=str(payload["commit"]),
            changed_files=[str(path) for path in payload["changed_files"]],
        )

    @staticmethod
    def _recover_running_task(
        run_id: str,
        task: Task,
        record: dict[str, Any],
        journal: SqliteTaskJournal,
    ) -> dict[str, Any] | None:
        payload = dict(record["payload"])
        worktree = Path(str(payload["worktree"]))
        if not worktree.exists():
            return None
        task_repo = GitRepository(worktree)
        commit = task_repo.commit_for_task(run_id, task.id)
        if commit is None:
            return None
        base_commit = str(payload["base_commit"])
        changed = task_repo.changed_files(base_commit)
        VerticalRunner._require_owned(changed, task.write_paths)
        ordinal = int(payload["ordinal"])
        handle = TaskAttemptHandle(
            task_id=task.id,
            attempt_id=f"{run_id}:{task.id}:{ordinal}",
            ordinal=ordinal,
            generation=int(record["lease_generation"]),
        )
        journal.complete(
            handle,
            task,
            base_commit,
            str(payload["branch"]),
            str(worktree),
            commit,
            changed,
        )
        return {
            **payload,
            "attempt_id": handle.attempt_id,
            "generation": handle.generation,
            "commit": commit,
            "changed_files": changed,
        }

    @staticmethod
    def _task_observe(
        observe: Callable[[str, dict[str, Any]], None] | None,
        event: str,
        data: dict[str, Any],
    ) -> None:
        if observe is not None:
            observe(event, data)

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

    def _review_candidate(
        self,
        candidate: GitRepository,
        profile: ProjectProfile,
        spec: FeatureSpec,
        base_commit: str,
    ) -> AgentReview:
        changed = candidate.changed_files(base_commit)
        diff = candidate.diff(base_commit)
        base_prompt = VerticalRunner._review_prompt(profile, spec, base_commit, changed, diff)
        workers = min(
            len(spec.surfaces),
            profile.policy.max_parallel_global,
            profile.policy.max_parallel_per_account,
        )
        with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
            futures = [
                executor.submit(
                    self.runtime.review,
                    candidate.root,
                    base_prompt
                    + f"\nReview surface {surface_id} specifically and include it in covered_surfaces.",
                )
                for surface_id in spec.surfaces
            ]
            reviews = [future.result() for future in futures]
        integration = self.runtime.review(
            candidate.root,
            base_prompt + "\nReview cross-surface integration and cover every listed surface.",
        )
        reviews.append(integration)
        covered = sorted({surface for item in reviews for surface in item.covered_surfaces})
        findings = [finding for item in reviews for finding in item.findings]
        verdict = ReviewVerdict.READY
        if any(item.verdict == ReviewVerdict.BLOCKED for item in reviews):
            verdict = ReviewVerdict.BLOCKED
        elif any(item.verdict == ReviewVerdict.FIX for item in reviews):
            verdict = ReviewVerdict.FIX
        return AgentReview(verdict=verdict, covered_surfaces=covered, findings=findings)
