from __future__ import annotations

import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest

from cohorte.adapters.git import GitRepository
from cohorte.application.delivery import (
    DeliveryStatus,
    PullRequest,
    ShipRunner,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import ProjectProfile, RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database


def project_profile() -> ProjectProfile:
    path = Path(__file__).parents[2] / "examples" / "g1" / "profile.json"
    return ProjectProfile.model_validate_json(path.read_text())


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True)
    return result.stdout.strip()


class FakeProvider:
    name = "fake-github"

    def __init__(self) -> None:
        self.requests: dict[str, PullRequest] = {}
        self.created = 0

    def find_pull_request(self, branch: str, head_sha: str) -> PullRequest | None:
        item = self.requests.get(branch)
        return item if item is not None and item.head_sha == head_sha else None

    def create_pull_request(
        self, branch: str, base: str, head_sha: str, title: str, body: str
    ) -> PullRequest:
        self.created += 1
        item = PullRequest(
            id=str(self.created),
            url=f"https://example.invalid/pr/{self.created}",
            head_sha=head_sha,
        )
        self.requests[branch] = item
        return item

    def check_status(self, pull_request: PullRequest) -> tuple[DeliveryStatus, list[str]]:
        return DeliveryStatus.CI_PENDING, ["tests"]


def prepared_delivery(
    tmp_path: Path, *, approved: bool = True
) -> tuple[Database, Path, RunState, str]:
    repository = tmp_path / "repository"
    remote = tmp_path / "remote.git"
    worktree = tmp_path / "worktree"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    (repository / "README.md").write_text("base\n")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "initial")
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    git(repository, "remote", "add", "origin", str(remote))
    git(repository, "push", "-u", "origin", "main")
    source = GitRepository(repository)
    candidate = source.create_worktree(worktree, "cohorte/demo-run")
    (worktree / "feature.txt").write_text("candidate\n")
    candidate_hash = candidate.snapshot_digest()

    database = Database(tmp_path / "state.sqlite3")
    database.register_project("demo", str(repository), "profile")
    now = datetime.now(UTC)
    state = RunState(
        id="demo-run",
        project_id="demo",
        feature_id="feature",
        stage=Stage.SHIP,
        status=RunStatus.WAITING_USER,
        state_version=1,
        base_commit=source.head,
        candidate_tree_hash=candidate_hash,
        created_at=now,
        updated_at=now,
    )
    database.create_run(state)
    request = database.create_request(
        state.id,
        "ship",
        {"branch": "cohorte/demo-run", "worktree": str(worktree)},
        candidate_hash,
    )
    if approved:
        database.respond_request(request, "approve-demo-run", {"approved": True}, candidate_hash)
    return database, worktree, state, "cohorte/demo-run"


def test_ship_commits_pushes_and_confirms_pull_request(tmp_path: Path) -> None:
    database, worktree, state, branch = prepared_delivery(tmp_path)
    provider = FakeProvider()

    result = ShipRunner(database, provider).run(
        state, project_profile(), worktree, branch, "Add feature", "Validated candidate."
    )

    assert result.status == DeliveryStatus.CI_PENDING
    assert GitRepository(worktree).remote_head("origin", branch) == result.head_sha
    assert GitRepository(worktree).commit_for_run(state.id) == result.head_sha
    assert provider.created == 1
    database.close()


def test_ship_requires_current_explicit_authorization(tmp_path: Path) -> None:
    database, worktree, state, branch = prepared_delivery(tmp_path, approved=False)

    with pytest.raises(CohorteError) as caught:
        ShipRunner(database, FakeProvider()).run(
            state, project_profile(), worktree, branch, "Add feature", "Validated candidate."
        )

    assert caught.value.code == ErrorCode.PERMISSION_DENIED
    assert database.connection.execute("SELECT COUNT(*) FROM effects").fetchone()[0] == 0
    database.close()


def test_ship_rejects_candidate_changed_after_review(tmp_path: Path) -> None:
    database, worktree, state, branch = prepared_delivery(tmp_path)
    (worktree / "feature.txt").write_text("changed after review\n")

    with pytest.raises(CohorteError) as caught:
        ShipRunner(database, FakeProvider()).run(
            state, project_profile(), worktree, branch, "Add feature", "Validated candidate."
        )

    assert caught.value.code == ErrorCode.SPEC_STALE
    assert database.connection.execute("SELECT COUNT(*) FROM effects").fetchone()[0] == 0
    database.close()


def test_ship_recovers_pr_created_before_ack_without_duplicate(tmp_path: Path) -> None:
    database, worktree, state, branch = prepared_delivery(tmp_path)
    provider = FakeProvider()

    def crash_after_pr(kind: str, _external_id: str) -> None:
        if kind == "pull_request":
            raise SystemExit("crash after provider accepted PR")

    with pytest.raises(SystemExit, match="crash after provider"):
        ShipRunner(database, provider, crash_after_pr).run(
            state, project_profile(), worktree, branch, "Add feature", "Validated candidate."
        )

    result = ShipRunner(database, provider).run(
        state, project_profile(), worktree, branch, "Add feature", "Validated candidate."
    )

    assert result.pr_id == "1"
    assert provider.created == 1
    effects = database.connection.execute(
        "SELECT kind,status FROM effects WHERE run_id=? ORDER BY kind", (state.id,)
    ).fetchall()
    assert {(row["kind"], row["status"]) for row in effects} == {
        ("commit", "completed"),
        ("push", "completed"),
        ("pull_request", "completed"),
    }
    database.close()
