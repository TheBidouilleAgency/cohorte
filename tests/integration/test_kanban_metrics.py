from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from cohorte.application.kanban import (
    KanbanCard,
    apply_projection,
    plan_projection,
)
from cohorte.application.metrics import metrics_report
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import KanbanConfig, RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database


def kanban_config(vault: Path) -> KanbanConfig:
    return KanbanConfig(
        enabled=True,
        provider="obsidian",
        vault_path=str(vault),
        board_path="Project/Board.md",
        columns={
            "draft": "Backlog",
            "running": "In Progress",
            "waiting_user": "Review",
            "completed": "Done",
            "failed": "Blocked",
        },
    )


def test_kanban_projection_is_idempotent_backed_up_and_bounded(
    tmp_path: Path,
) -> None:
    vault = tmp_path / "vault"
    board = vault / "Project" / "Board.md"
    untouched = vault / "Private.md"
    board.parent.mkdir(parents=True)
    board.write_text("# Board\n\n## Backlog\n\n## In Progress\n\n## Done\n")
    untouched.write_text("do not scan or change")
    config = kanban_config(vault)
    card = KanbanCard(
        feature_id="feature-one",
        title="Feature One",
        state="running",
        run_id="run-one",
    )
    first = apply_projection(config, plan_projection(config, card))
    assert first.status == "applied"
    assert first.backup_path is not None
    assert "·" in board.read_text(encoding="utf-8")
    assert board.read_text().count("cohorte:feature:feature-one") == 2
    assert untouched.read_text() == "do not scan or change"
    second = apply_projection(config, plan_projection(config, card))
    assert second.status == "unchanged"
    assert board.read_text().count("cohorte:feature:feature-one") == 2


def test_kanban_detects_concurrent_board_write(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    board = vault / "Project" / "Board.md"
    board.parent.mkdir(parents=True)
    board.write_text("# Board\n\n## Backlog\n")
    config = kanban_config(vault)
    plan = plan_projection(
        config,
        KanbanCard(feature_id="feature-one", title="Feature One", state="draft"),
    )
    board.write_text("# changed concurrently\n")
    with pytest.raises(CohorteError) as caught:
        apply_projection(config, plan)
    assert caught.value.code == ErrorCode.VERSION_CONFLICT
    assert not (vault / ".cohorte-backups").exists()


def test_metrics_keep_missing_provider_usage_unavailable(tmp_path: Path) -> None:
    database = Database(tmp_path / "cohorte.sqlite3")
    profile = database.put_artifact("project-profile", b"{}")
    database.register_project("project", str(tmp_path), profile["id"])
    database.create_feature("feature", "project", "Feature")
    start = datetime(2026, 9, 22, 10, tzinfo=UTC)
    state = RunState(
        id="run-one",
        project_id="project",
        feature_id="feature",
        stage=Stage.DONE,
        status=RunStatus.COMPLETED,
        state_version=1,
        base_commit="a" * 40,
        fix_cycles=2,
        created_at=start,
        updated_at=start + timedelta(seconds=12),
    )
    database.create_run(state)
    database.append_event(
        "agent.usage",
        {
            "input_tokens": 120,
            "output_tokens": 30,
            "provider": "codex",
            "phase": "build",
        },
        project_id="project",
        run_id="run-one",
    )
    database.append_event(
        "phase.build.completed",
        {"candidate": "abc"},
        project_id="project",
        run_id="run-one",
    )
    report = metrics_report(
        database,
        project_id="project",
        since=start - timedelta(seconds=1),
        until=start + timedelta(days=1),
    )
    values = {value.name: value for value in report.values}
    assert report.outcomes == {"completed": 1}
    assert values["runs"].value == 1
    assert values["mean_run_duration"].value == 12
    assert values["fix_cycles"].value == 2
    assert values["input_tokens"].value == 120
    assert values["cache_tokens"].value is None
    assert values["cache_tokens"].availability == "unavailable"
    assert values["estimated_cost"].value is None

    by_run = metrics_report(
        database,
        project_id="project",
        since=start - timedelta(seconds=1),
        until=start + timedelta(days=1),
        group_by="run",
    )
    assert [group.key for group in by_run.groups] == ["run-one"]
    assert by_run.groups[0].outcomes == {"completed": 1}

    by_provider = metrics_report(
        database,
        project_id="project",
        since=start - timedelta(seconds=1),
        until=start + timedelta(days=1),
        group_by="provider",
    )
    assert [group.key for group in by_provider.groups] == ["codex"]
    provider_values = {value.name: value.value for value in by_provider.groups[0].values}
    assert provider_values["input_tokens"] == 120

    by_phase = metrics_report(
        database,
        project_id="project",
        since=start - timedelta(seconds=1),
        until=start + timedelta(days=1),
        group_by="phase",
    )
    assert [group.key for group in by_phase.groups] == ["build"]
    phase_values = {value.name: value.value for value in by_phase.groups[0].values}
    assert phase_values["events"] == 2
