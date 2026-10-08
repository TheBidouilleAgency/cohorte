from __future__ import annotations

import json
from pathlib import Path

import pytest

from cohorte.application.kanban import KanbanCard, apply_projection, list_ideas, plan_projection
from cohorte.application.kanban_mirror import save_idea_seed, sync_feature
from cohorte.domain.models import KanbanConfig
from cohorte.persistence.sqlite import Database

BOARD = """---
kanban-plugin: board
---

## Ideas

- [ ] Une idée
  - Décision ancienne

- [ ] Autre idée

## Brainstorm

## Spec

## Ready to build

## Building

## Review

## Fix

## Ship

## Shipped

%% kanban:settings
{\"kanban-plugin\":\"board\"}
%%
"""


def _setup(tmp_path: Path) -> tuple[Database, Path, KanbanConfig]:
    board = tmp_path / "Tasks.md"
    board.write_text(BOARD, encoding="utf-8")
    config = KanbanConfig(
        enabled=True, provider="obsidian", vault_path=str(tmp_path), board_path="Tasks.md"
    )
    database = Database(tmp_path / "state.sqlite3")
    profile = database.put_artifact(
        "project-profile",
        json.dumps({"integrations": {"kanban": config.model_dump()}}).encode(),
    )
    database.register_project("project", str(tmp_path), profile["id"])
    database.create_feature("une-idee", "project", "Une idée")
    return database, board, config


def test_selected_idea_moves_through_v2_columns_preserving_board(tmp_path: Path) -> None:
    database, board, config = _setup(tmp_path)
    selected = list_ideas(config)[0]
    save_idea_seed(database, "une-idee", source_id=selected.source_id, title=selected.title)

    for stage, column in (
        ("brainstorm", "Brainstorm"),
        ("spec", "Spec"),
        ("ready", "Ready to build"),
        ("building", "Building"),
        ("review", "Review"),
        ("fix", "Fix"),
        ("ship", "Ship"),
        ("shipped", "Shipped"),
    ):
        result = sync_feature(
            database, "une-idee", stage, pr_number=42 if stage == "shipped" else None
        )
        assert result["status"] == "applied"
        content = board.read_text(encoding="utf-8")
        assert content.count("#une-idee") == 1
        assert content.index(f"## {column}\n") < content.index("#une-idee")
        assert "  - Décision ancienne" in content
        assert "- [ ] Autre idée" in content
        assert content.startswith("---\nkanban-plugin: board\n---\n")
        assert content.endswith('%% kanban:settings\n{"kanban-plugin":"board"}\n%%\n')
    assert "PR #42" in board.read_text(encoding="utf-8")
    assert sync_feature(database, "une-idee", "shipped", pr_number=42)["status"] == "unchanged"
    assert len(list((tmp_path / ".cohorte-backups").glob("*.md"))) == 8


def test_changed_board_recovers_unique_selected_idea(tmp_path: Path) -> None:
    database, board, config = _setup(tmp_path)
    selected = list_ideas(config)[0]
    save_idea_seed(database, "une-idee", source_id=selected.source_id, title=selected.title)
    board.write_text(
        BOARD.replace("## Ideas\n", "## Ideas\n\n- [ ] Nouvelle carte\n"), encoding="utf-8"
    )
    assert sync_feature(database, "une-idee", "brainstorm")["status"] == "applied"
    assert board.read_text(encoding="utf-8").count("#une-idee") == 1


def test_ambiguous_idea_and_missing_column_fail_without_losing_feature(tmp_path: Path) -> None:
    database, board, config = _setup(tmp_path)
    selected = list_ideas(config)[0]
    save_idea_seed(database, "une-idee", source_id=selected.source_id, title=selected.title)
    board.write_text(BOARD.replace("- [ ] Autre idée", "- [ ] Une idée"), encoding="utf-8")
    with pytest.warns(UserWarning, match="Obsidian Kanban"):
        result = sync_feature(database, "une-idee", "brainstorm")
    assert result["status"] == "error"
    assert database.get_feature("une-idee")["title"] == "Une idée"
    assert not (tmp_path / ".cohorte-backups").exists()

    board.write_text(BOARD.replace("## Spec\n", ""), encoding="utf-8")
    with pytest.raises(ValueError, match="column"):
        plan_projection(config, KanbanCard(feature_id="une-idee", title="Une idée", state="spec"))
    assert board.read_text(encoding="utf-8").count("#une-idee") == 0


def test_duplicate_tagged_cards_collapse_to_one(tmp_path: Path) -> None:
    _, board, config = _setup(tmp_path)
    board.write_text(
        BOARD.replace("- [ ] Une idée", "- [ ] Une idée #une-idee").replace(
            "## Spec\n", "## Spec\n\n- [ ] Copie #une-idee\n"
        ),
        encoding="utf-8",
    )
    card = KanbanCard(feature_id="une-idee", title="Une idée", state="review")
    apply_projection(config, plan_projection(config, card))
    content = board.read_text(encoding="utf-8")
    assert content.count("#une-idee") == 1
    assert "Décision ancienne" in content
