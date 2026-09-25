from __future__ import annotations

import builtins
import json
import sys
from pathlib import Path

import pytest

from cohorte.application.preparation import (
    BrainstormContribution,
    BrainstormPerspectiveTurn,
    BrainstormQuestionProposal,
    BrainstormRunner,
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


class FollowupPanelRuntime(PanelRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.round = 0

    def brainstorm_synthesis(self, workspace: Path, prompt: str) -> BrainstormSynthesisTurn:
        turn = super().brainstorm_synthesis(workspace, prompt)
        questions = ["Who is the user?"] if self.round == 0 else []
        self.round += 1
        self.perspectives = []
        proposals = (
            [
                BrainstormQuestionProposal(
                    question="Who is the user?",
                    business_option="Operators",
                    code_option="Scope the export route to operator accounts",
                    caveat="Role permissions need confirmation",
                )
            ]
            if questions
            else []
        )
        return turn.model_copy(
            update={
                "synthesis": turn.synthesis.model_copy(
                    update={"blocking_questions": questions, "question_proposals": proposals}
                )
            }
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

    answers = iter(["Add safe export", ""])
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
    assert "Réponses fournies :" not in readable
    assert "Piste du panel (pas une décision) : Use an atomic bounded export." in readable
    assert "Perspective product" in readable

    assert cli.run(["--json", "--data-dir", str(data), "brief", "show", "add-safe-export"]) == 0
    document = json.loads(capsys.readouterr().out)
    assert document["ok"] is True
    assert document["data"]["brief"]["feature_id"] == "add-safe-export"
    assert document["data"]["brief_ref"]["id"] == "brief:add-safe-export"

    with pytest.raises(SystemExit) as error:
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data),
                "brainstorm",
                "--feature-id",
                "add-safe-export",
                "--idea",
                "Add safe export",
                "--answer",
                "Another observation",
                "--live",
            ]
        )
    assert error.value.code == 3
    assert "brainstorm --continue add-safe-export" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("idea", "first_id", "corrected_id"),
    [
        ("Add safe export", "INVALID_ID", "safe-export"),
        ("!!!", "", "chosen-id"),
    ],
)
def test_guided_brainstorm_reprompts_for_invalid_id_before_panel(
    tmp_path: Path, monkeypatch, capsys, idea: str, first_id: str, corrected_id: str
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    data = tmp_path / "data"
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()
    monkeypatch.chdir(project)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    runtime = PanelRuntime()
    monkeypatch.setattr(cli, "CodexAdapter", lambda *_args, **_kwargs: runtime)

    context_calls: list[object] = []
    from cohorte.application import repository_context

    original_context = repository_context.collect_repository_context
    original_run = BrainstormRunner.run
    runner_calls: list[object] = []

    def observed_run(self: BrainstormRunner, *args: object, **kwargs: object):
        runner_calls.append(args)
        return original_run(self, *args, **kwargs)

    monkeypatch.setattr(BrainstormRunner, "run", observed_run)

    def observed_context(*args: object, **kwargs: object) -> str:
        context_calls.append(args)
        return original_context(*args, **kwargs)

    monkeypatch.setattr(repository_context, "collect_repository_context", observed_context)
    prompts: list[str] = []
    answers = iter([idea, first_id, corrected_id])

    def answer(prompt: str) -> str:
        prompts.append(prompt)
        if len(prompts) == 3:
            output = capsys.readouterr()
            assert "1 à 80 caractères" in output.err
            assert "Le panel" not in output.err
            assert context_calls == []
            assert runner_calls == []
            assert runtime.perspectives == []
            pending = Database(data / "cohorte.sqlite3")
            assert pending.list_features("project") == []
            with pytest.raises(KeyError):
                pending.latest_artifact(f"brief:{first_id}")
            pending.close()
        return next(answers)

    monkeypatch.setattr(builtins, "input", answer)

    assert cli.run(["--data-dir", str(data), "brainstorm"]) == 0
    assert "Le panel" in capsys.readouterr().err
    assert prompts[0] == "Quelle idée veux-tu explorer ?: "
    assert len(prompts) == 3
    assert all(prompt.startswith("Identifiant [") for prompt in prompts[1:])
    assert len(context_calls) == 1
    assert len(runner_calls) == 1
    stored = Database(data / "cohorte.sqlite3")
    brief = json.loads(stored.latest_artifact(f"brief:{corrected_id}")["content"])
    assert brief["feature_id"] == corrected_id
    assert brief["idea"] == idea
    assert [item["id"] for item in stored.list_features("project")] == [corrected_id]
    stored.close()


def test_guided_brainstorm_can_answer_panel_questions_and_continue_later(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    data = tmp_path / "data"
    data.mkdir()
    database = Database(data / "cohorte.sqlite3")
    CohorteService(database).init_project(project)
    database.close()
    monkeypatch.chdir(project)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    runtime = FollowupPanelRuntime()
    monkeypatch.setattr(cli, "CodexAdapter", lambda *_args, **_kwargs: runtime)
    answers = iter(
        [
            "Add safe export",
            "",
            "o",
            "tu proposes quoi?",
            "p",
            "",
        ]
    )
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert cli.run(["--data-dir", str(data), "brainstorm"]) == 0
    output = capsys.readouterr().out
    assert "révision 1" in output
    assert "révision 2" in output
    assert "Piste produit : Operators" in output
    stored = Database(data / "cohorte.sqlite3")
    latest = stored.latest_artifact("brief:add-safe-export")
    assert latest["revision"] == 2
    document = json.loads(latest["content"])
    assert document["previous_brief_ref"]["revision"] == 1
    assert "Who is the user? Operators" in document["user_answers"]
    assert not any("tu proposes quoi" in item for item in document["user_answers"])
    stored.close()

    answers = iter(["A second observation", ""])
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))
    assert cli.run(["--data-dir", str(data), "brainstorm", "--continue", "add-safe-export"]) == 0
    latest = Database(data / "cohorte.sqlite3")
    third = latest.latest_artifact("brief:add-safe-export")
    assert third["revision"] == 3
    assert json.loads(third["content"])["previous_brief_ref"]["revision"] == 2
    latest.close()
    capsys.readouterr()

    monkeypatch.setattr(builtins, "input", lambda _prompt: "")
    assert cli.run(["--data-dir", str(data), "brainstorm", "--continue", "add-safe-export"]) == 0
    assert "brief inchangé" in capsys.readouterr().out
    unchanged = Database(data / "cohorte.sqlite3")
    assert unchanged.latest_artifact("brief:add-safe-export")["revision"] == 3
    unchanged.close()

    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(data),
                "brainstorm",
                "--continue",
                "add-safe-export",
                "--answer",
                "Keep a copy for audit",
                "--live",
            ]
        )
        == 0
    )
    result = json.loads(capsys.readouterr().out)
    assert result["data"]["brief_ref"]["revision"] == 4
    assert result["data"]["brief"]["previous_brief_ref"]["revision"] == 3


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
