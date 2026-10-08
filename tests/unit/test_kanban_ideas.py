from pathlib import Path

from cohorte.application.kanban import KanbanCard, apply_projection, list_ideas, plan_projection
from cohorte.domain.models import KanbanConfig


def test_ideas_include_subnotes_and_only_idea_column(tmp_path: Path) -> None:
    board = tmp_path / "board.md"
    board.write_text(
        "## Idea\n- [ ] Export CSV #export-csv\n  - Pour les clients\n  - Garder le format V2\n"
        "- [ ] Tableau de bord\n## Brainstorm\n- [ ] Ne pas proposer\n",
        encoding="utf-8",
    )
    config = KanbanConfig(
        enabled=True, provider="obsidian", vault_path=str(tmp_path), board_path="board.md"
    )

    ideas = list_ideas(config)

    assert [(idea.title, idea.feature_id, idea.notes) for idea in ideas] == [
        ("Export CSV #export-csv", "export-csv", ["Pour les clients", "Garder le format V2"]),
        ("Tableau de bord", None, []),
    ]
    assert board.read_text(encoding="utf-8").startswith("## Idea")


def test_configured_ideas_heading_overrides_defaults(tmp_path: Path) -> None:
    (tmp_path / "board.md").write_text(
        "## Ideas\n- Ignorée\n## Propositions\n- Choisie\n", encoding="utf-8"
    )
    config = KanbanConfig(
        enabled=True,
        provider="obsidian",
        vault_path=str(tmp_path),
        board_path="board.md",
        columns={"ideas": "Propositions"},
    )
    assert [idea.title for idea in list_ideas(config)] == ["Choisie"]


def test_disabled_kanban_has_no_ideas() -> None:
    assert list_ideas(KanbanConfig()) == []


def test_read_only_ideas_do_not_project_into_board(tmp_path: Path) -> None:
    board = tmp_path / "board.md"
    board.write_text("## Ideas\n- [ ] Choisie\n## Backlog\n")
    config = KanbanConfig(
        enabled=True,
        read_only=True,
        provider="obsidian",
        vault_path=str(tmp_path),
        board_path="board.md",
    )
    assert [idea.title for idea in list_ideas(config)] == ["Choisie"]
    assert (
        plan_projection(
            config, KanbanCard(feature_id="choisie", title="Choisie", state="draft")
        ).status
        == "skipped"
    )
    ready = plan_projection(
        config.model_copy(update={"read_only": False}),
        KanbanCard(feature_id="choisie", title="Choisie", state="draft"),
    )
    assert apply_projection(config, ready).status == "skipped"
    assert board.read_text() == "## Ideas\n- [ ] Choisie\n## Backlog\n"
