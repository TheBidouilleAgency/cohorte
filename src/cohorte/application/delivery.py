from __future__ import annotations

from collections.abc import Callable
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from cohorte.adapters.git import GitRepository
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import ProjectProfile, RunState, RunStatus, Stage, StrictModel
from cohorte.persistence.sqlite import Database


class DeliveryStatus(StrEnum):
    PREPARED = "prepared"
    PUSHED = "pushed"
    PR_OPEN = "pr_open"
    CI_PENDING = "ci_pending"
    CI_PASSED = "ci_passed"
    CI_FAILED = "ci_failed"
    CI_UNKNOWN = "ci_unknown"


class PullRequest(StrictModel):
    id: str
    url: str
    head_sha: str
    status: str = "open"


class DeliveryResult(StrictModel):
    run_id: str
    provider: str
    branch: str
    base: str
    head_sha: str
    pr_id: str
    url: str
    status: DeliveryStatus
    required_checks: list[str]


class DeliveryProvider(Protocol):
    name: str

    def find_pull_request(self, branch: str, head_sha: str) -> PullRequest | None: ...

    def create_pull_request(
        self, branch: str, base: str, head_sha: str, title: str, body: str
    ) -> PullRequest: ...

    def check_status(self, pull_request: PullRequest) -> tuple[DeliveryStatus, list[str]]: ...


class ShipRunner:
    def __init__(
        self,
        database: Database,
        provider: DeliveryProvider,
        after_external_effect: Callable[[str, str], None] | None = None,
    ) -> None:
        self.database = database
        self.provider = provider
        self.after_external_effect = after_external_effect

    def run(
        self,
        state: RunState,
        profile: ProjectProfile,
        worktree: Path,
        branch: str,
        title: str,
        body: str,
    ) -> DeliveryResult:
        if state.stage != Stage.SHIP or state.status != RunStatus.WAITING_USER:
            raise ValueError("run is not waiting for ship authorization")
        request = self.database.ship_request_for_run(state.id)
        approval = self.database.approval_for_request(request["id"])
        if (
            request["status"] != "answered"
            or request["subject_hash"] != state.candidate_tree_hash
            or approval is None
            or approval["subject_hash"] != state.candidate_tree_hash
            or approval["answer"].get("approved") is not True
        ):
            raise CohorteError(
                ErrorCode.PERMISSION_DENIED,
                "ship authorization is missing, denied, or stale",
                "no delivery effect was executed",
                remediation="approve the current candidate ship request",
            )
        repository = GitRepository(worktree)
        if repository.snapshot_digest() != state.candidate_tree_hash:
            raise CohorteError(
                ErrorCode.SPEC_STALE,
                "worktree content changed after review",
                "delivery is blocked",
                remediation="rerun checks and independent review",
            )
        remote = profile.vcs.remote
        remote_base = repository.remote_head(remote, profile.vcs.default_branch)
        if remote_base != state.base_commit:
            raise CohorteError(
                ErrorCode.MERGE_CONFLICT,
                "remote base changed or could not be verified",
                "delivery is blocked before commit",
                remediation="synchronize the base and rerun validation",
                details={"expected": state.base_commit, "actual": remote_base},
            )

        commit_sha = self._effect(
            state.id,
            "commit",
            {"candidate": state.candidate_tree_hash, "message": title},
            lambda: repository.commit_for_run(state.id),
            lambda: repository.commit_all(title, state.id),
        )
        pushed_sha = self._effect(
            state.id,
            "push",
            {"remote": remote, "branch": branch, "head_sha": commit_sha},
            lambda: commit_sha if repository.remote_head(remote, branch) == commit_sha else None,
            lambda: repository.push_branch(remote, branch),
        )
        if pushed_sha != commit_sha:
            raise CohorteError(
                ErrorCode.EFFECT_UNCERTAIN,
                "pushed commit does not match the prepared commit",
                "delivery reconciliation is required",
                remediation="inspect the remote branch before retrying",
            )

        pull_request: PullRequest | None = None

        def reconcile_pr() -> str | None:
            nonlocal pull_request
            pull_request = self.provider.find_pull_request(branch, commit_sha)
            return pull_request.id if pull_request is not None else None

        def create_pr() -> str:
            nonlocal pull_request
            pull_request = self.provider.create_pull_request(
                branch, profile.vcs.default_branch, commit_sha, title, body
            )
            return pull_request.id

        pr_id = self._effect(
            state.id,
            "pull_request",
            {"branch": branch, "base": profile.vcs.default_branch, "head_sha": commit_sha},
            reconcile_pr,
            create_pr,
        )
        if pull_request is None:
            pull_request = self.provider.find_pull_request(branch, commit_sha)
        if pull_request is None or pull_request.id != pr_id or pull_request.status != "open":
            raise CohorteError(
                ErrorCode.EFFECT_UNCERTAIN,
                "pull request could not be confirmed open",
                "ship is not complete",
                remediation="reconcile the provider by branch and head commit",
            )
        status, checks = self.provider.check_status(pull_request)
        return DeliveryResult(
            run_id=state.id,
            provider=self.provider.name,
            branch=branch,
            base=profile.vcs.default_branch,
            head_sha=commit_sha,
            pr_id=pull_request.id,
            url=pull_request.url,
            status=status,
            required_checks=checks,
        )

    def refresh(self, delivery: DeliveryResult) -> DeliveryResult:
        pull_request = self.provider.find_pull_request(delivery.branch, delivery.head_sha)
        if pull_request is None or pull_request.id != delivery.pr_id:
            raise CohorteError(
                ErrorCode.EFFECT_UNCERTAIN,
                "the recorded pull request could not be reconciled",
                "CI status is unknown",
                remediation="inspect the provider using the recorded branch and head commit",
            )
        status, checks = self.provider.check_status(pull_request)
        return delivery.model_copy(update={"status": status, "required_checks": checks})

    def _effect(
        self,
        run_id: str,
        kind: str,
        payload: dict[str, str],
        reconcile: Callable[[], str | None],
        execute: Callable[[], str],
    ) -> str:
        effect = self.database.begin_effect(run_id, kind, f"{run_id}:{kind}", payload)
        if effect["status"] == "completed":
            return str(effect["external_id"])
        external_id = reconcile()
        if external_id is None:
            external_id = execute()
            if self.after_external_effect is not None:
                self.after_external_effect(kind, external_id)
        self.database.complete_effect(effect["id"], external_id)
        return external_id
