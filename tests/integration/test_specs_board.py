from __future__ import annotations

import json
from pathlib import Path

from cohorte.application.service import CohorteService
from cohorte.cli import main as cli
from cohorte.persistence.sqlite import Database


def test_specs_board_shows_ready_features_and_next_action(tmp_path: Path, capsys) -> None:
    root = tmp_path / "project"
    root.mkdir()
    (root / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    data = tmp_path / "data"
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(root)
    database.ensure_feature("welcome", "project", "Welcome users")
    database.set_feature_status("welcome", "frozen")
    database.put_artifact("feature-ready", b"{}", artifact_id="ready:welcome")
    database.close()

    assert cli.run(["--json", "--data-dir", str(data), "specs", "--project-id", "project"]) == 0
    data_result = json.loads(capsys.readouterr().out)["data"]
    assert data_result["features"][0]["status"] == "frozen"
    assert data_result["features"][0]["ready_ref"]["id"] == "ready:welcome"

    assert cli.run(["--data-dir", str(data), "specs", "--project-id", "project"]) == 0
    assert "cohorte start welcome" in capsys.readouterr().out
