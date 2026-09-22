from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from cohorte.application.migration import (
    V2MigrationPlan,
    apply_v2_migration,
    plan_v2_migration,
    rollback_database,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.persistence.sqlite import Database


def v2_fixture(root: Path) -> None:
    (root / "specs").mkdir(parents=True)
    (root / ".cohorte" / "decisions").mkdir(parents=True)
    (root / "PIPELINE.md").write_text("# V2 pipeline\n")
    (root / "cohorte.config.yaml").write_text(
        "project: example\nchecks:\n  test: 'pytest && echo imported-as-data'\n"
    )
    (root / "specs" / "feature.md").write_text("# Frozen feature\n")
    (root / ".cohorte" / "decisions" / "one.md").write_text("# Decision\n")
    (root / ".cohorte" / "project.yaml").write_text("api_token: never-import\n")
    (root / ".env").write_text("SECRET=never-import\n")


def test_v2_plan_is_bounded_and_marks_history_non_certified(tmp_path: Path) -> None:
    source = tmp_path / "v2"
    source.mkdir()
    v2_fixture(source)

    plan = plan_v2_migration(source)

    assert [item.path for item in plan.files] == [
        ".cohorte/decisions/one.md",
        "PIPELINE.md",
        "cohorte.config.yaml",
        "specs/feature.md",
    ]
    assert all(item.historical and not item.certified for item in plan.files)
    assert all(item.requires_revalidation for item in plan.files if item.kind == "spec")
    assert plan.active_runs_imported is False
    assert plan.excluded == [".cohorte/project.yaml", ".env"]
    assert any("shell-like value" in warning for warning in plan.warnings)
    assert any("credential-like keys" in warning for warning in plan.warnings)
    assert len(plan.mappings) == 6
    assert any(mapping.disposition == "exclude" for mapping in plan.mappings)
    assert any("active run" in loss for loss in plan.losses)


def test_v2_plan_refuses_symlinks_even_when_they_point_inside_source(tmp_path: Path) -> None:
    source = tmp_path / "v2"
    (source / "specs").mkdir(parents=True)
    target = source / "real.md"
    target.write_text("# real\n")
    (source / "specs" / "linked.md").symlink_to(target)

    with pytest.raises(ValueError, match="refuses symlink"):
        plan_v2_migration(source)


def test_v2_plan_excludes_secret_keys_in_markdown_frontmatter(tmp_path: Path) -> None:
    source = tmp_path / "v2"
    (source / "specs").mkdir(parents=True)
    (source / "specs" / "unsafe.md").write_bytes(
        b"---\r\napi_key: never-import\r\n---\r\n# Historical spec\r\n"
    )

    plan = plan_v2_migration(source)

    assert plan.files == []
    assert plan.excluded == ["specs/unsafe.md"]
    assert plan.mappings[0].disposition == "exclude"


def test_v2_apply_rechecks_source_backs_up_and_rolls_back(tmp_path: Path) -> None:
    source = tmp_path / "v2"
    source.mkdir()
    v2_fixture(source)
    plan = plan_v2_migration(source)
    database = Database(tmp_path / "data" / "cohorte.sqlite3")

    result = apply_v2_migration(database, plan, tmp_path / "backups")

    assert result.imported_files == 4
    assert result.rollback_verified is True
    assert Path(result.backup_path).is_file()
    assert database.connection.execute("SELECT COUNT(*) FROM imports").fetchone()[0] == 1
    payload = json.loads(
        database.connection.execute("SELECT payload_json FROM imports").fetchone()[0]
    )
    assert payload["active_runs_imported"] is False
    assert database.connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0

    safety = rollback_database(database, Path(result.backup_path))
    assert safety.is_file()
    restored = Database(tmp_path / "data" / "cohorte.sqlite3")
    try:
        assert restored.health()["ok"] is True
        assert restored.connection.execute("SELECT COUNT(*) FROM imports").fetchone()[0] == 0
    finally:
        restored.close()


def test_v2_apply_rejects_source_changed_after_plan(tmp_path: Path) -> None:
    source = tmp_path / "v2"
    source.mkdir()
    v2_fixture(source)
    plan = plan_v2_migration(source)
    (source / "specs" / "feature.md").write_text("# changed\n")
    database = Database(tmp_path / "state.sqlite3")
    try:
        with pytest.raises(ValueError, match="changed after planning"):
            apply_v2_migration(database, plan, tmp_path / "backups")
        assert database.connection.execute("SELECT COUNT(*) FROM imports").fetchone()[0] == 0
    finally:
        database.close()


def test_schema_v1_upgrade_is_backed_up_and_preserves_data(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    connection = sqlite3.connect(path)
    connection.executescript(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"
        "INSERT INTO schema_migrations VALUES(1, '2026-09-21T00:00:00+00:00');"
        "CREATE TABLE sentinel(value TEXT NOT NULL);"
        "INSERT INTO sentinel VALUES('preserved');"
        "PRAGMA user_version=1;"
    )
    connection.close()
    config = tmp_path / "project.yaml"
    config.write_text("preserve: exactly\n")

    database = Database(path)
    try:
        assert database.health()["schema_version"] == 2
        assert (
            database.connection.execute("SELECT value FROM sentinel").fetchone()[0] == "preserved"
        )
        assert (
            database.connection.execute(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=2"
            ).fetchone()[0]
            == 1
        )
        assert (
            database.connection.execute(
                "SELECT name FROM sqlite_master WHERE name='imports'"
            ).fetchone()[0]
            == "imports"
        )
        assert config.read_text() == "preserve: exactly\n"
    finally:
        database.close()
    assert len(list(tmp_path.glob("state.sqlite3.pre-v2-*.bak"))) == 1


def test_older_binary_refuses_future_schema(tmp_path: Path) -> None:
    path = tmp_path / "future.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA user_version=999")
    connection.close()

    with pytest.raises(CohorteError) as caught:
        Database(path)
    assert caught.value.code == ErrorCode.RUNTIME_INCOMPATIBLE


def test_plan_schema_round_trip(tmp_path: Path) -> None:
    source = tmp_path / "v2"
    source.mkdir()
    v2_fixture(source)
    plan = plan_v2_migration(source)
    assert V2MigrationPlan.model_validate_json(plan.model_dump_json()) == plan
