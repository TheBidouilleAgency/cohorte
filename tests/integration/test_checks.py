from __future__ import annotations

import sys

import pytest

from cohorte.domain.models import CheckDefinition
from cohorte.execution.checks import CheckRunner


def test_check_runner_uses_argv_and_reports_failure(tmp_path) -> None:
    definition = CheckDefinition(
        id="fails", argv=[sys.executable, "-c", "raise SystemExit(7)"], timeout_seconds=10
    )
    result = CheckRunner(tmp_path).run(definition)
    assert result.status == "failed"
    assert result.exit_code == 7


def test_check_runner_rejects_escaping_cwd(tmp_path) -> None:
    definition = CheckDefinition(
        id="bad", argv=[sys.executable, "--version"], cwd=".", timeout_seconds=10
    )
    object.__setattr__(definition, "cwd", "../")
    with pytest.raises(ValueError, match="escapes"):
        CheckRunner(tmp_path).run(definition)
