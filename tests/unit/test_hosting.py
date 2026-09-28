import json
from unittest.mock import Mock

import pytest

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


def test_github_reconciles_a_merged_pull_request_by_id(tmp_path) -> None:
    provider = GitHubProvider(tmp_path)
    provider._run = Mock(  # type: ignore[method-assign]
        return_value=json.dumps(
            {
                "number": 79,
                "url": "https://github.com/example/repo/pull/79",
                "headRefOid": "a" * 40,
                "state": "MERGED",
            }
        )
    )

    result = provider.get_pull_request("79")

    assert result is not None
    assert result.head_sha == "a" * 40
    assert result.status == "merged"


@pytest.mark.parametrize(
    ("buckets", "expected"),
    [
        (["pending"], DeliveryStatus.CI_PENDING),
        (["pass", "pending"], DeliveryStatus.CI_PENDING),
        (["pass", "skipping"], DeliveryStatus.CI_PASSED),
        (["pass", "fail"], DeliveryStatus.CI_FAILED),
        (["skipping"], DeliveryStatus.CI_UNKNOWN),
    ],
)
def test_github_reports_only_observed_check_results(tmp_path, buckets, expected) -> None:
    provider = GitHubProvider(tmp_path)
    provider._run = Mock(  # type: ignore[method-assign]
        return_value=json.dumps(
            [{"name": f"check-{index}", "bucket": bucket} for index, bucket in enumerate(buckets)]
        )
    )

    status, checks = provider.check_status(
        PullRequest(id="1", url="https://example.invalid/1", head_sha="a" * 40)
    )

    assert status == expected
    assert checks == [f"check-{index}" for index in range(len(buckets))]


@pytest.mark.parametrize(
    ("runs", "expected"),
    [
        ([{"status": "in_progress", "conclusion": "success"}], DeliveryStatus.CI_PENDING),
        ([{"status": "completed", "conclusion": "success"}], DeliveryStatus.CI_PASSED),
        ([{"status": "completed", "conclusion": "failure"}], DeliveryStatus.CI_FAILED),
        ([{"status": "completed", "conclusion": "skipped"}], DeliveryStatus.CI_UNKNOWN),
        ([], DeliveryStatus.CI_PENDING),
    ],
)
def test_github_waits_for_actions_run_before_reporting_success(tmp_path, runs, expected) -> None:
    provider = GitHubProvider(tmp_path)
    head_sha = "a" * 40
    checks = [
        {"name": "docs", "bucket": "pass", "link": "https://github.com/o/r/actions/runs/12/job/3"}
    ]
    provider._run = Mock(  # type: ignore[method-assign]
        side_effect=[
            json.dumps(checks),
            json.dumps([{**run, "headSha": head_sha} for run in runs]),
        ]
    )

    status, names = provider.check_status(
        PullRequest(id="1", url="https://example.invalid/1", head_sha=head_sha)
    )

    assert status == expected
    assert names == ["docs"]
    assert provider._run.call_count == 2
    provider._run.assert_any_call(
        "run", "list", "--commit", head_sha, "--json", "status,conclusion,headSha", "--limit", "100"
    )


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


def test_gitlab_reconciles_a_merged_request_by_id(tmp_path) -> None:
    provider = GitLabProvider(tmp_path)
    provider._run = Mock(  # type: ignore[method-assign]
        return_value=json.dumps(
            {
                "iid": 7,
                "web_url": "https://gitlab.com/example/test/-/merge_requests/7",
                "diff_refs": {"head_sha": "a" * 40},
                "state": "merged",
            }
        )
    )

    result = provider.get_pull_request("7")

    assert result is not None
    assert result.head_sha == "a" * 40
    assert result.status == "merged"
