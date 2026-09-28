from cohorte.application.delivery import DeliveryResult, DeliveryStatus
from cohorte.cli.delivery_view import print_delivery_result


def delivery(status: DeliveryStatus, checks: list[str]) -> DeliveryResult:
    return DeliveryResult(
        run_id="example-run",
        provider="github",
        branch="cohorte/example-run",
        base="main",
        head_sha="a" * 40,
        pr_id="12",
        url="https://example.invalid/pr/12",
        status=status,
        required_checks=checks,
    )


def test_unknown_ci_gives_a_follow_up_without_claiming_success(capsys) -> None:
    print_delivery_result(delivery(DeliveryStatus.CI_UNKNOWN, []))

    output = capsys.readouterr().out
    assert "https://example.invalid/pr/12" in output
    assert "CI : aucun check visible" in output
    assert "Suivre : cohorte delivery-status example-run --live --watch" in output
    assert "réussis" not in output


def test_observed_ci_result_is_readable(capsys) -> None:
    print_delivery_result(delivery(DeliveryStatus.CI_PASSED, ["tests", "docs"]))

    output = capsys.readouterr().out
    assert "CI : checks visibles réussis" in output
    assert "Checks visibles : tests, docs" in output
    assert "Suivre :" not in output
