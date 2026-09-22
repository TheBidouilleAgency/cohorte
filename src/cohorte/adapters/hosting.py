from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from cohorte.application.delivery import DeliveryStatus, PullRequest


class _CliProvider:
    executable: str
    name: str

    def __init__(self, repository: Path) -> None:
        self.repository = repository.resolve(strict=True)

    def _run(self, *args: str, check: bool = True) -> str:
        result = subprocess.run(
            [self.executable, *args],
            cwd=self.repository,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
        if check and result.returncode != 0:
            raise RuntimeError(
                f"{self.executable} {' '.join(args)} failed: "
                f"{(result.stderr or result.stdout).strip()}"
            )
        return result.stdout.strip()


class GitHubProvider(_CliProvider):
    executable = "gh"
    name = "github"

    def find_pull_request(self, branch: str, head_sha: str) -> PullRequest | None:
        values = json.loads(
            self._run(
                "pr",
                "list",
                "--head",
                branch,
                "--state",
                "open",
                "--limit",
                "20",
                "--json",
                "number,url,headRefOid",
            )
            or "[]"
        )
        for value in values:
            if value.get("headRefOid") == head_sha:
                return PullRequest(id=str(value["number"]), url=value["url"], head_sha=head_sha)
        return None

    def create_pull_request(
        self, branch: str, base: str, head_sha: str, title: str, body: str
    ) -> PullRequest:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md") as document:
            document.write(body)
            document.flush()
            self._run(
                "pr",
                "create",
                "--head",
                branch,
                "--base",
                base,
                "--title",
                title,
                "--body-file",
                document.name,
            )
        result = self.find_pull_request(branch, head_sha)
        if result is None:
            raise RuntimeError("GitHub did not confirm the newly created pull request")
        return result

    def check_status(self, pull_request: PullRequest) -> tuple[DeliveryStatus, list[str]]:
        raw = self._run(
            "pr",
            "checks",
            pull_request.id,
            "--json",
            "name,state,bucket",
            check=False,
        )
        checks: list[dict[str, Any]] = json.loads(raw or "[]")
        if not checks:
            return DeliveryStatus.CI_UNKNOWN, []
        names = [str(item.get("name", "unknown")) for item in checks]
        buckets = {str(item.get("bucket", "pending")).lower() for item in checks}
        if buckets & {"fail", "cancel"}:
            return DeliveryStatus.CI_FAILED, names
        if checks and buckets <= {"pass", "skipping"}:
            return DeliveryStatus.CI_PASSED, names
        return DeliveryStatus.CI_PENDING, names


class GitLabProvider(_CliProvider):
    executable = "glab"
    name = "gitlab"

    def find_pull_request(self, branch: str, head_sha: str) -> PullRequest | None:
        values = json.loads(
            self._run(
                "mr",
                "list",
                "--source-branch",
                branch,
                "--state",
                "opened",
                "--output",
                "json",
            )
            or "[]"
        )
        for value in values:
            sha = value.get("sha") or value.get("diff_refs", {}).get("head_sha")
            if sha == head_sha:
                return PullRequest(
                    id=str(value.get("iid") or value.get("id")),
                    url=str(value.get("web_url") or value.get("url")),
                    head_sha=head_sha,
                )
        return None

    def create_pull_request(
        self, branch: str, base: str, head_sha: str, title: str, body: str
    ) -> PullRequest:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md") as document:
            document.write(body)
            document.flush()
            self._run(
                "mr",
                "create",
                "--source-branch",
                branch,
                "--target-branch",
                base,
                "--title",
                title,
                "--description-file",
                document.name,
                "--yes",
            )
        result = self.find_pull_request(branch, head_sha)
        if result is None:
            raise RuntimeError("GitLab did not confirm the newly created merge request")
        return result

    def check_status(self, pull_request: PullRequest) -> tuple[DeliveryStatus, list[str]]:
        value = json.loads(self._run("mr", "view", pull_request.id, "--output", "json") or "{}")
        pipeline = value.get("head_pipeline") or value.get("pipeline") or {}
        status = str(pipeline.get("status", "unknown")).lower()
        name = str(pipeline.get("name") or pipeline.get("id") or "pipeline")
        if status in {"success", "passed"}:
            return DeliveryStatus.CI_PASSED, [name]
        if status in {"failed", "canceled", "cancelled", "skipped"}:
            return DeliveryStatus.CI_FAILED, [name]
        if not pipeline:
            return DeliveryStatus.CI_UNKNOWN, []
        return DeliveryStatus.CI_PENDING, [name]
