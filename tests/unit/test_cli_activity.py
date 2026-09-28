from __future__ import annotations

import time

import pytest

from cohorte.cli.activity import Activity


def test_activity_reports_work_and_stops_before_next_prompt(capsys) -> None:
    with Activity("Analyse", interval_seconds=0.01):
        time.sleep(0.05)
    output = capsys.readouterr().err
    assert "Analyse…" in output
    assert "Analyse · toujours en cours" in output
    assert "Analyse · terminé" in output

    # Nothing is emitted after leaving the blocking operation's boundary.
    time.sleep(0.03)
    assert capsys.readouterr().err == ""


def test_activity_keeps_json_mode_clean_and_reports_failure(capsys) -> None:
    with Activity("Analyse", enabled=False):
        pass
    assert capsys.readouterr().err == ""

    with pytest.raises(ValueError), Activity("Analyse"):
        raise ValueError("failed")
    assert "Analyse · interrompu" in capsys.readouterr().err
