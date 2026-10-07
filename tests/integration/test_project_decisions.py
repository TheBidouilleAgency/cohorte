from __future__ import annotations

from pathlib import Path

import pytest
from test_preparation import PanelRuntime

from cohorte.application.decisions import add_live_decision, live_decisions
from cohorte.application.preparation import BrainstormRunner
from cohorte.domain.models import ArtifactRef


def test_v2_live_decisions_are_loaded_and_new_decisions_are_retained(tmp_path: Path) -> None:
    (tmp_path / "specs").mkdir()
    journal = tmp_path / "specs" / "_decisions.md"
    journal.write_text(
        "# Decisions\n\n## Live\n\n- 2026-01-01 · auth · Keep local sessions — because privacy · login\n\n"
        "## Historical\n\n- Keep all audit notes\n\n## Superseded\n\n- Old remote sessions\n",
        encoding="utf-8",
    )
    entry = add_live_decision(
        tmp_path,
        area="export",
        decision="Store exports locally",
        reason="privacy",
        feature_id="safe-export",
    )
    assert live_decisions(tmp_path) == [
        "2026-01-01 · auth · Keep local sessions — because privacy · login",
        entry,
    ]
    assert "Old remote sessions" not in live_decisions(tmp_path)
    assert journal.read_text(encoding="utf-8").count(entry) == 1
    assert journal.read_text(encoding="utf-8").index(entry) < journal.read_text(
        encoding="utf-8"
    ).index("## Historical")


def test_panel_uses_standing_decisions_and_does_not_promote_a_question_to_decision(
    tmp_path: Path,
) -> None:
    (tmp_path / "specs").mkdir()
    add_live_decision(
        tmp_path,
        area="export",
        decision="Store exports locally",
        reason="privacy",
        feature_id="first-feature",
    )
    runtime = PanelRuntime()
    runner = BrainstormRunner(runtime)
    first = runner.run(
        tmp_path, "safe-export", "Add safe export", "project", [], live_decisions(tmp_path)
    )
    assert "Store exports locally" in runtime.prompts[0]
    second = runner.run(
        tmp_path,
        "safe-export",
        "Add safe export",
        "project",
        [],
        live_decisions(tmp_path),
        user_message="What would UX change about the recommendation?",
        previous_brief=first,
        previous_brief_ref=ArtifactRef(id="brief:safe-export", revision=1, sha256="a" * 64),
    )
    assert second.user_messages == ["What would UX change about the recommendation?"]
    assert second.decisions == []
    assert "do not treat it as an approved decision" in runtime.prompts[-2]

    replacement = "2026-10-08 · export · Allow encrypted remote exports — because approved storage · next-feature"
    (tmp_path / "specs" / "_decisions.md").write_text(
        f"## Live\n\n- {replacement}\n\n## Superseded\n\n- old local rule\n",
        encoding="utf-8",
    )
    refreshed = runner.run(
        tmp_path,
        "safe-export",
        "Add safe export",
        "project",
        [],
        live_decisions(tmp_path),
        user_message="Does this change the design?",
        previous_brief=second,
        previous_brief_ref=ArtifactRef(id="brief:safe-export", revision=2, sha256="b" * 64),
    )
    assert refreshed.prior_decisions == [replacement]


def test_decision_journal_refuses_symlink(tmp_path: Path) -> None:
    target = tmp_path / "outside.md"
    target.write_text("## Live\n")
    (tmp_path / "specs").mkdir()
    (tmp_path / "specs" / "_decisions.md").symlink_to(target)
    with pytest.raises(ValueError, match="symlink"):
        add_live_decision(
            tmp_path,
            area="auth",
            decision="Keep local sessions",
            reason="privacy",
            feature_id="login",
        )
