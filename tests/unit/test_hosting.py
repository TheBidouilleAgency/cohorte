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


def test_gitlab_find_merge_request_uses_supported_list_flags(tmp_path) -> None:
    provider = GitLabProvider(tmp_path)
    provider._run = Mock(
        return_value='[{"iid":7,"sha":"'
        + "a" * 40
        + '","web_url":"https://gitlab.com/example/test/-/merge_requests/7"}]'
    )  # type: ignore[method-assign]

    result = provider.find_pull_request("cohorte/test", "a" * 40)

    assert result is not None
    assert result.id == "7"
    provider._run.assert_called_once_with(
        "mr", "list", "--source-branch", "cohorte/test", "--output", "json"
    )
