from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

from cohorte.application.client_wrappers import (
    _render_legacy,
    apply_wrappers,
    installed_wrappers,
    wrapper_plan,
)


def test_wrappers_are_previewed_then_created_without_another_workflow(tmp_path: Path) -> None:
    runtimes = ["claude", "codex", "cursor", "gemini", "opencode"]
    preview = wrapper_plan(tmp_path, runtimes)
    assert [item["status"] for item in preview] == ["create"] * 5
    assert list(tmp_path.iterdir()) == []

    applied = apply_wrappers(tmp_path, runtimes)
    assert [item["status"] for item in applied] == ["current"] * 5
    assert [item["sha256"] for item in applied] == [item["sha256"] for item in preview]
    for item in applied:
        content = (tmp_path / item["path"]).read_text()
        assert "the installed `cohorte` CLI" in content
        assert "wrapper, not another execution provider" in content
    gemini = tomllib.loads((tmp_path / ".gemini/commands/cohorte.toml").read_text())
    assert "{{args}}" in gemini["prompt"]
    assert apply_wrappers(tmp_path, runtimes) == applied


def test_wrappers_refuse_conflict_atomically_and_symlink_escape(tmp_path: Path) -> None:
    cursor = tmp_path / ".cursor/commands/cohorte.md"
    cursor.parent.mkdir(parents=True)
    cursor.write_text("user content")
    with pytest.raises(ValueError, match="no file was changed"):
        apply_wrappers(tmp_path, ["claude", "cursor"])
    assert cursor.read_text() == "user content"
    assert not (tmp_path / ".claude").exists()

    outside = tmp_path.parent / "outside-wrapper"
    outside.mkdir(exist_ok=True)
    (tmp_path / ".opencode").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        wrapper_plan(tmp_path, ["opencode"])


def test_wrappers_upgrade_exact_generated_content_but_preserve_user_edits(tmp_path: Path) -> None:
    old = tmp_path / ".claude/commands/cohorte.md"
    old.parent.mkdir(parents=True)
    old.write_text(_render_legacy("claude"))
    assert installed_wrappers(tmp_path) == ["claude"]
    assert wrapper_plan(tmp_path, ["claude"])[0]["status"] == "update"
    assert apply_wrappers(tmp_path, ["claude"])[0]["status"] == "current"
    assert "Managed by Cohorte" in old.read_text()

    old.write_text(old.read_text() + "My project-specific instruction\n")
    assert wrapper_plan(tmp_path, ["claude"])[0]["status"] == "conflict"
    with pytest.raises(ValueError, match="no file was changed"):
        apply_wrappers(tmp_path, ["claude"])
    assert "My project-specific instruction" in old.read_text()
