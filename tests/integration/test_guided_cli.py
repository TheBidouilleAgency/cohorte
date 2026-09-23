from __future__ import annotations

import builtins
import json
import sys
from pathlib import Path

import pytest

from cohorte.application.preparation import (
    BrainstormContribution,
    BrainstormPerspectiveTurn,
    BrainstormSynthesis,
    BrainstormSynthesisTurn,
)
from cohorte.application.service import CohorteService
from cohorte.cli import main as cli
from cohorte.persistence.sqlite import Database


class PanelRuntime:
    def __init__(self) -> None:
        self.perspectives: list[str] = []

    def brainstorm_perspective(
        self, workspace: Path, prompt: str, perspective: str
    ) -> BrainstormPerspectiveTurn:
        assert '"user_answers":' in prompt
        self.perspectives.append(perspective)
        return BrainstormPerspectiveTurn(
            session_ref=f"session-{perspective}",
            contribution=BrainstormContribution(
                contribution_id=perspective,
                perspective=perspective,
                problem="Unsafe export",
                assumptions=[],
                alternatives=[],
                risks=[],
                questions=[],
                disagreements=[],
            ),
        )

    def brainstorm_synthesis(self, workspace: Path, prompt: str) -> BrainstormSynthesisTurn:
        assert '"user_answers":' in prompt
        return BrainstormSynthesisTurn(
            session_ref="session-synthesis",
            synthesis=BrainstormSynthesis(
                contribution_refs=self.perspectives,
                problem="Unsafe export",
                beneficiaries=[],
                in_scope=[],
                out_of_scope=[],
                options=[],
                recommendation="Use an atomic bounded export.",
                divergences=[],
                strong_objections=[],
                blocking_questions=[],
                non_blocking_questions=[],
                criterion_leads=[],
            ),
        )


def test_guided_brainstorm_from_project_directory(tmp_path: Path, monkeypatch, capsys) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()

    answers = iter(["Add safe export", "", "Operators", "Export is unsafe", "Atomic output", ""])
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(cli, "CodexAdapter", lambda *_args, **_kwargs: PanelRuntime())
    monkeypatch.chdir(project)

    assert cli.run(["--data-dir", str(data), "brainstorm"]) == 0
    printed = capsys.readouterr()
    assert "Piste : Use an atomic bounded export." in printed.out
    stored = Database(data / "cohorte.sqlite3")
    feature = stored.list_features("project")
    assert len(feature) == 1
    assert feature[0]["id"] == "add-safe-export"
    stored.close()

    assert cli.run(["--data-dir", str(data), "brief", "show", "add-safe-export"]) == 0
    readable = capsys.readouterr().out
    assert "Brief add-safe-export · révision 1" in readable
    assert "Réponses fournies :" in readable
    assert "Piste du panel (pas une décision) : Use an atomic bounded export." in readable
    assert "Perspective product" in readable

    assert cli.run(["--json", "--data-dir", str(data), "brief", "show", "add-safe-export"]) == 0
    document = json.loads(capsys.readouterr().out)
    assert document["ok"] is True
    assert document["data"]["brief"]["feature_id"] == "add-safe-export"
    assert document["data"]["brief_ref"]["id"] == "brief:add-safe-export"


def test_brief_show_is_scoped_to_current_project(tmp_path: Path, monkeypatch, capsys) -> None:
    project = tmp_path / "project"
    other = tmp_path / "other"
    project.mkdir()
    other.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    CohorteService(database).init_project(other)
    database.ensure_feature("other-feature", "other", "Other feature")
    database.close()
    monkeypatch.chdir(project)

    with pytest.raises(SystemExit) as error:
        cli.run(["--json", "--data-dir", str(data), "brief", "show", "other-feature"])
    assert error.value.code == 3
    result = json.loads(capsys.readouterr().out)
    assert result["error"]["message"] == "unknown feature in this project: other-feature"
