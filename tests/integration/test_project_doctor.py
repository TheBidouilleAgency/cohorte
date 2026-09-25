from __future__ import annotations

import json
from pathlib import Path

from cohorte.application.discovery import discover_project
from cohorte.application.project_doctor import inspect_project
from cohorte.application.service import CohorteService
from cohorte.cli import main as cli
from cohorte.persistence.sqlite import Database


def test_doctor_names_missing_surface_with_a_concrete_fix(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (tmp_path / "src").mkdir()
    profile, _ = discover_project(tmp_path)
    (tmp_path / "src").rmdir()

    report = inspect_project(tmp_path, profile)

    assert report["ok"] is False
    finding = next(item for item in report["findings"] if item["code"] == "SURFACE_PATH_MISSING")
    assert "cohorte init . --refresh" in finding["fix"]


def test_doctor_human_output_gives_one_action_per_finding(capsys) -> None:
    cli._emit_doctor_result(
        {
            "version": "1.0.0",
            "database": {"ok": True},
            "providers": [
                {"provider": "codex", "connection_state": "connected", "runtime_version": "1"}
            ],
            "project": {
                "project_id": "demo",
                "surfaces": 1,
                "checks": 1,
                "ok": False,
                "findings": [
                    {
                        "code": "SURFACE_PATH_MISSING",
                        "message": "src is missing",
                        "fix": "Run cohorte init . --refresh",
                    }
                ],
            },
        },
        False,
    )
    output = capsys.readouterr().out
    assert "Projet demo · 1 surfaces · 1 checks · à corriger" in output
    assert "Action : Run cohorte init . --refresh" in output


def test_update_pipeline_previews_then_preserves_choices_on_apply(tmp_path: Path, capsys) -> None:
    root = tmp_path / "project"
    root.mkdir()
    (root / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (root / "src").mkdir()
    data = tmp_path / "data"
    database = Database(data / "cohorte.sqlite3")
    service = CohorteService(database)
    initial = service.init_project(root)
    document = initial["profile"]
    document["brainstorm_panel"] = ["product", "architecture", "qa", "security"]
    service.save_project_profile("project", document, initial["profile_ref"]["revision"])
    (root / "src-tauri").mkdir()
    (root / "src-tauri/Cargo.toml").write_text("[package]\nname='app'\n")
    database.close()

    assert cli.run(["--json", "--data-dir", str(data), "update-pipeline", "--repo", str(root)]) == 0
    preview = json.loads(capsys.readouterr().out)["data"]
    assert preview["applied"] is False
    assert "surfaces" in preview["changed_fields"]
    assert any(item["id"] == "rust" for item in preview["profile"]["surfaces"])
    database = Database(data / "cohorte.sqlite3")
    before = database.get_project("project")["profile"]
    assert all(item["id"] != "rust" for item in before["surfaces"])
    database.close()

    assert (
        cli.run(
            ["--json", "--data-dir", str(data), "update-pipeline", "--repo", str(root), "--apply"]
        )
        == 0
    )
    applied = json.loads(capsys.readouterr().out)["data"]
    assert applied["applied"] is True
    assert applied["profile"]["brainstorm_panel"] == document["brainstorm_panel"]
    assert any(item["id"] == "rust" for item in applied["profile"]["surfaces"])
