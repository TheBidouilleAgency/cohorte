from __future__ import annotations

import errno
import subprocess
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

from cohorte.application.vertical import VerticalRunner
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import CheckDefinition, RunState, RunStatus, Stage
from cohorte.execution.checks import CheckRunner
from cohorte.persistence.sqlite import Database


@pytest.mark.parametrize(
    ("argv", "subprocess_result", "expected_issue"),
    [
        (["missing-build-tool"], FileNotFoundError(2, "missing"), "dependency_missing"),
        (["docker", "info"], FileNotFoundError(2, "missing"), "container_unavailable"),
        (
            ["network-check"],
            subprocess.CompletedProcess(
                ["network-check"], 7, stdout=b"", stderr=b"Network is unreachable"
            ),
            "network_unavailable",
        ),
        (["write-check"], OSError(errno.ENOSPC, "No space left on device"), "disk_full"),
    ],
)
def test_degraded_environment_is_explicit_and_preserves_run_state(
    tmp_path, argv, subprocess_result, expected_issue
) -> None:
    database = Database(tmp_path / "state.sqlite3")
    database.register_project("project", str(tmp_path), "profile")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="degraded-run",
            project_id="project",
            feature_id="feature",
            stage=Stage.CHECKS,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit="a" * 40,
            created_at=now,
            updated_at=now,
        )
    )
    before = database.get_run("degraded-run")
    definition = CheckDefinition(id="environment", argv=argv, timeout_seconds=10)
    context = (
        patch("cohorte.execution.checks.subprocess.run", side_effect=subprocess_result)
        if isinstance(subprocess_result, OSError)
        else patch("cohorte.execution.checks.subprocess.run", return_value=subprocess_result)
    )

    with context:
        execution = CheckRunner(tmp_path).run(definition)

    assert execution.status == "errored"
    assert execution.error_code == ErrorCode.CHECK_ENVIRONMENT.value
    assert execution.environment_issue == expected_issue
    with pytest.raises(CohorteError) as caught:
        VerticalRunner._require_check_environment([execution])
    assert caught.value.code == ErrorCode.CHECK_ENVIRONMENT
    assert caught.value.retryable is True
    assert database.get_run("degraded-run") == before
    assert database.health()["ok"] is True
    database.close()
