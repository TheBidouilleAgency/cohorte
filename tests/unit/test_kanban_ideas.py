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


def test_wikilinks_load_ticket_context_without_following_its_links(tmp_path: Path) -> None:
    from cohorte.application.kanban import resolve_idea

    project = tmp_path / "Plica"
    tickets = project / "Tickets" / "micro-features"
    tickets.mkdir(parents=True)
    ticket = tickets / "001-monorepo.md"
    ticket.write_text("# Monorepo\nCritères : imports vérifiés.\n[[secret]]", encoding="utf-8")
    (tmp_path / "secret.md").write_text("NOT RECURSIVE", encoding="utf-8")
    board = project / "Tasks.md"
    source = (
        "## Ideas\n- [ ] [[001-monorepo|MF-001]] #mf-001\n"
        "  - Conserver la décision.\n  - [[Plica/Tickets/micro-features/001-monorepo.md#Critères]]\n"
    )
    board.write_text(source, encoding="utf-8")
    config = KanbanConfig(
        enabled=True,
        read_only=True,
        provider="obsidian",
        vault_path=str(tmp_path),
        board_path="Plica/Tasks.md",
    )
    idea = list_ideas(config)[0]
    assert idea.feature_id == "mf-001"
    assert idea.notes[0] == "Conserver la décision."
    context = "\n".join(idea.notes)
    assert "Fiche Obsidian : Plica/Tickets/micro-features/001-monorepo.md" in context
    assert context.count("Critères : imports vérifiés.") == 1
    assert "NOT RECURSIVE" not in context
    ticket.write_text("Critères actualisés", encoding="utf-8")
    assert "Critères actualisés" in "\n".join(resolve_idea(config, idea.source_id).notes)
    assert board.read_text(encoding="utf-8") == source


def test_missing_ambiguous_and_unsafe_links_are_visible(tmp_path: Path) -> None:
    for directory in ("a", "b"):
        (tmp_path / directory).mkdir()
        (tmp_path / directory / "duplicate.md").write_text("DO NOT CHOOSE", encoding="utf-8")
    (tmp_path / ".private.md").write_text("PRIVATE", encoding="utf-8")
    (tmp_path / "board.md").write_text(
        "## Ideas\n- [[duplicate]] [[missing]] [[../outside]] [[.private]] [[image.png]]\n",
        encoding="utf-8",
    )
    config = KanbanConfig(
        enabled=True, provider="obsidian", vault_path=str(tmp_path), board_path="board.md"
    )
    notes = "\n".join(list_ideas(config)[0].notes)
    assert "lien ambigu" in notes
    assert "fiche introuvable" in notes
    assert "chemin non autorisé" in notes
    assert "seules les fiches Markdown" in notes
    assert "PRIVATE" not in notes and "DO NOT CHOOSE" not in notes


def test_relative_note_precedes_duplicate_elsewhere_and_bounds_context(tmp_path: Path) -> None:
    (tmp_path / "project").mkdir()
    (tmp_path / "ticket.md").write_text("WRONG NOTE", encoding="utf-8")
    (tmp_path / "project/ticket.md").write_text("é" * 80_000, encoding="utf-8")
    (tmp_path / "project/board.md").write_text(
        "## Ideas\n- ![[ticket#Section|Label]]\n", encoding="utf-8"
    )
    config = KanbanConfig(
        enabled=True, provider="obsidian", vault_path=str(tmp_path), board_path="project/board.md"
    )
    context = "\n".join(list_ideas(config)[0].notes)
    assert "project/ticket.md" in context
    assert "WRONG NOTE" not in context
    assert "Contexte tronqué" in context
    assert len(context) <= 6000


def test_symlink_notes_are_not_read(tmp_path: Path) -> None:
    import os

    import pytest

    if os.name == "nt":
        pytest.skip("Creating symlinks requires Windows privileges")
    vault = tmp_path / "vault"
    vault.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("OUTSIDE CONTENT", encoding="utf-8")
    (vault / "linked.md").symlink_to(outside)
    (vault / "linked-dir").symlink_to(tmp_path, target_is_directory=True)
    (vault / "board.md").write_text(
        "## Ideas\n- [[linked]] [[linked-dir/outside]]\n", encoding="utf-8"
    )
    config = KanbanConfig(
        enabled=True, provider="obsidian", vault_path=str(vault), board_path="board.md"
    )
    context = "\n".join(list_ideas(config)[0].notes)
    assert "OUTSIDE CONTENT" not in context
    assert context.count("fiche introuvable") == 2


def test_link_and_index_limits_are_explicit(tmp_path: Path, monkeypatch) -> None:
    from cohorte.application import obsidian_links

    for index in range(9):
        (tmp_path / f"note-{index}.md").write_text(f"CONTENT {index}", encoding="utf-8")
    (tmp_path / "board.md").write_text(
        "## Ideas\n- " + " ".join(f"[[note-{index}]]" for index in range(9)) + "\n",
        encoding="utf-8",
    )
    config = KanbanConfig(
        enabled=True, provider="obsidian", vault_path=str(tmp_path), board_path="board.md"
    )
    context = "\n".join(list_ideas(config)[0].notes)
    assert "CONTENT 7" in context and "CONTENT 8" not in context
    assert "8 premiers liens" in context
    monkeypatch.setattr(obsidian_links, "_MAX_ENTRIES", 2)
    context = "\n".join(list_ideas(config)[0].notes)
    assert "index incomplet ou trop volumineux" in context
    assert "CONTENT" not in context
