from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from cohorte.application import incoming_review as incoming
from cohorte.application.incoming_review import IncomingMetadata, review_incoming
from cohorte.application.vertical import AgentReview, ReviewFinding
from cohorte.cli import main as cli
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import AgentDefaults, ProjectProfile, Provider, Surface, VcsConfig
from cohorte.persistence.sqlite import Database


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()


def incoming_repository(tmp_path: Path, ref: str) -> tuple[Path, str]:
    remote = tmp_path / "remote.git"
    remote.mkdir()
    git(remote, "init", "--bare")
    repository = tmp_path / "repository"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "test@example.invalid")
    git(repository, "config", "user.name", "Test")
    (repository / "src").mkdir()
    (repository / "src/app.py").write_text("def value():\n    return 1\n")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "base")
    git(repository, "remote", "add", "origin", str(remote))
    git(repository, "push", "origin", "main")
    git(repository, "checkout", "-b", "feature")
    (repository / "src/app.py").write_text("def value():\n    return 2\n")
    git(repository, "commit", "-am", "change value")
    head = git(repository, "rev-parse", "HEAD")
    git(repository, "push", "origin", f"HEAD:{ref}")
    git(repository, "checkout", "main")
    return repository, head


def profile(host: str) -> ProjectProfile:
    return ProjectProfile(
        project_id="incoming-demo",
        name="Incoming demo",
        language="en",
        vcs=VcsConfig(host=host),  # type: ignore[arg-type]
        surfaces=[Surface(id="python", label="Python", paths=["src"], role_profile="backend")],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )


@pytest.mark.parametrize(
    ("host", "ref"),
    [("github", "refs/pull/7/head"), ("gitlab", "refs/merge-requests/7/head")],
)
def test_incoming_review_uses_exact_detached_checkout(tmp_path: Path, host: str, ref: str) -> None:
    repository, head = incoming_repository(tmp_path, ref)
    source_head = git(repository, "rev-parse", "HEAD")

    class Runtime:
        def review(self, workspace: Path, prompt: str) -> AgentReview:
            assert git(workspace, "rev-parse", "HEAD") == head
            assert "return 2" in (workspace / "src/app.py").read_text()
            assert "return 2" in prompt
            assert 'Required surfaces: ["python"]' in prompt
            return AgentReview(
                verdict=ReviewVerdict.READY,
                covered_surfaces=["python"],
                findings=[ReviewFinding(severity="low", path="src/app.py", message="Check naming")],
            )

    report = review_incoming(
        repository,
        tmp_path / "worktrees",
        profile(host),
        IncomingMetadata(host=host, number=7, title="Change value", base_branch="main"),
        Runtime(),
    )
    assert report.head_sha == head
    assert report.changed_files == ["src/app.py"]
    assert report.source_unchanged is True
    assert git(repository, "rev-parse", "HEAD") == source_head
    assert (repository / "src/app.py").read_text() == "def value():\n    return 1\n"


def test_incoming_review_rejects_agent_mutation(tmp_path: Path) -> None:
    repository, _head = incoming_repository(tmp_path, "refs/pull/7/head")

    class MutatingRuntime:
        def review(self, workspace: Path, prompt: str) -> AgentReview:
            (workspace / "src/app.py").write_text("changed by reviewer\n")
            return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=["python"])

    with pytest.raises(CohorteError) as caught:
        review_incoming(
            repository,
            tmp_path / "worktrees",
            profile("github"),
            IncomingMetadata(host="github", number=7, title="Change value", base_branch="main"),
            MutatingRuntime(),
        )
    assert caught.value.code == ErrorCode.AUDIT_MUTATION


def test_incoming_review_chunks_large_diff_without_losing_blocking_findings(tmp_path: Path) -> None:
    repository, _head = incoming_repository(tmp_path, "refs/pull/7/head")
    git(repository, "checkout", "feature")
    for index in range(101):
        (repository / "src" / f"module_{index:03}.py").write_text(f"VALUE = {index}\n")
    (repository / "src" / "large.py").write_text(
        "".join(f"VALUE_{index:04} = '{index:04}-{'x' * 80}'\n" for index in range(1400))
    )
    git(repository, "add", "src")
    git(repository, "commit", "-m", "large change")
    git(repository, "push", "origin", "HEAD:refs/pull/7/head")
    git(repository, "checkout", "main")

    class Runtime:
        def __init__(self) -> None:
            self.segments = 0
            self.integration = 0

        def review(self, workspace: Path, prompt: str) -> AgentReview:
            assert (workspace / "src/large.py").is_file()
            if "Integrate the segment reviews" in prompt:
                self.integration += 1
                return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=["python"])
            self.segments += 1
            return AgentReview(
                verdict=ReviewVerdict.BLOCKED if self.segments == 1 else ReviewVerdict.READY,
                covered_surfaces=["python"],
                findings=[ReviewFinding(severity="high", path="src/large.py", message="Issue")]
                if self.segments == 1
                else [],
            )

    runtime = Runtime()
    report = review_incoming(
        repository,
        tmp_path / "worktrees",
        profile("github"),
        IncomingMetadata(host="github", number=7, title="Large change", base_branch="main"),
        runtime,
    )
    assert report.review_chunks > 1
    assert runtime.segments == report.review_chunks
    assert runtime.integration == 1
    assert len(report.changed_files) == 103
    assert report.review.verdict == ReviewVerdict.BLOCKED
    assert report.review.findings[0].message == "Issue"
    assert report.source_unchanged is True


def test_diff_chunks_preserve_unicode_and_every_character() -> None:
    content = "diff --git a/src/a b/src/a\n" + "é" * 20 + "\n"
    chunks = incoming._diff_chunks(content, max_bytes=10)
    assert "".join(chunks) == content
    assert all(len(chunk.encode()) <= 10 for chunk in chunks)


def test_incoming_review_cli_stores_report_without_forge_comment(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    repository, _head = incoming_repository(tmp_path, "refs/pull/7/head")
    data = tmp_path / "data"
    data.mkdir()
    db = Database(data / "cohorte.sqlite3")
    project_profile = profile("github")
    artifact = db.put_artifact("project-profile", project_profile.model_dump_json().encode())
    db.register_project(project_profile.project_id, str(repository), artifact["id"])
    db.close()
    monkeypatch.chdir(repository)

    class Runtime:
        def review(self, workspace: Path, prompt: str) -> AgentReview:
            return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=["python"])

    monkeypatch.setattr(cli, "workflow_runtime", lambda _repo, _profile: Runtime())
    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data),
                "incoming-review",
                "7",
                "--title",
                "Change value",
                "--live",
            ]
        )
        == 0
    )
    payload = json.loads(capsys.readouterr().out)["data"]
    assert payload["report"]["source_unchanged"] is True
    db = Database(data / "cohorte.sqlite3")
    assert db.latest_artifact("incoming-review:incoming-demo:github:7")["revision"] == 1
    db.close()


@pytest.mark.parametrize(
    ("host", "response", "expected_head"),
    [
        (
            "github",
            {
                "title": "Fix API",
                "body": "Avoid duplicate writes",
                "baseRefName": "main",
                "baseRefOid": "a" * 40,
                "headRefOid": "b" * 40,
                "url": "https://github.com/example/repo/pull/7",
            },
            "b" * 40,
        ),
        (
            "gitlab",
            {
                "title": "Fix API",
                "description": "Avoid duplicate writes",
                "target_branch": "main",
                "sha": "c" * 40,
                "web_url": "https://gitlab.com/example/repo/-/merge_requests/7",
            },
            "c" * 40,
        ),
    ],
)
def test_lookup_reads_host_metadata_without_publishing(
    tmp_path: Path, monkeypatch, host: str, response: dict[str, str], expected_head: str
) -> None:
    seen: list[list[str]] = []

    def fake_command(_repository: Path, argv: list[str]) -> dict[str, str]:
        seen.append(argv)
        return response

    monkeypatch.setattr(incoming, "_run_metadata_command", fake_command)
    metadata = incoming.lookup_incoming_metadata(tmp_path, profile(host), 7)
    assert metadata.expected_head == expected_head
    assert metadata.title == "Fix API"
    assert seen[0][:2] == (["gh", "pr"] if host == "github" else ["glab", "mr"])
