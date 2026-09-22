from unittest.mock import Mock

from cohorte.adapters.hosting import GitHubProvider, GitLabProvider
from cohorte.application.delivery import DeliveryStatus, PullRequest


def test_github_reports_unknown_when_repository_has_no_checks(tmp_path) -> None:
    provider = GitHubProvider(tmp_path)
    provider._run = Mock(return_value="[]")  # type: ignore[method-assign]

    status, checks = provider.check_status(
        PullRequest(id="1", url="https://example.invalid/1", head_sha="a" * 40)
    )

    assert status == DeliveryStatus.CI_UNKNOWN
    assert checks == []


def test_gitlab_reports_unknown_when_merge_request_has_no_pipeline(tmp_path) -> None:
    provider = GitLabProvider(tmp_path)
    provider._run = Mock(return_value="{}")  # type: ignore[method-assign]

    status, checks = provider.check_status(
        PullRequest(id="1", url="https://example.invalid/1", head_sha="a" * 40)
    )

    assert status == DeliveryStatus.CI_UNKNOWN
    assert checks == []
