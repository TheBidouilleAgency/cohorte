from __future__ import annotations

import builtins
import json
import subprocess
import sys
from pathlib import Path

import pytest

from cohorte.application.preparation import (
    BrainstormBrief,
    BrainstormContribution,
    BrainstormSynthesis,
    canonical_model_bytes,
)
from cohorte.application.vertical import AgentReport, AgentReview
from cohorte.cli import main as cli
from cohorte.cli.guided_feature import guided_start
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import (
    AgentDefaults,
    CheckDefinition,
    FeatureSpec,
    ProjectProfile,
    Provider,
    Surface,
    VcsConfig,
)
from cohorte.persistence.sqlite import Database


def _setup(tmp_path: Path, *, blocking: bool = False) -> tuple[Path, Path]:
    repository = tmp_path / "repository"
    repository.mkdir()
    (repository / "src").mkdir()
    (repository / "src" / "export.txt").write_text("original\n")
    subprocess.run(["git", "init", "-b", "main"], cwd=repository, check=True, capture_output=True)
    subprocess.run(["git", "add", "."], cwd=repository, check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "initial",
        ],
        cwd=repository,
        check=True,
        capture_output=True,
    )
    data_dir = tmp_path / "data"
    database = Database(data_dir / "cohorte.sqlite3")
    profile = ProjectProfile(
        project_id="project",
        name="Project",
        language="fr",
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="api", label="API", paths=["src"], role_profile="implementer", check_ids=["test"]
            )
        ],
        checks=[
            CheckDefinition(
                id="test", argv=[sys.executable, "-c", "print('ok')"], timeout_seconds=30
            )
        ],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )
    profile_ref = database.put_artifact("project-profile", canonical_model_bytes(profile))
    database.ensure_project("project", str(repository), profile_ref["id"])
    database.ensure_feature("safe-export", "project", "Safe export")
    brief = BrainstormBrief(
        feature_id="safe-export",
        idea="Safe export",
        project_context="",
        prior_decisions=[],
        panel=["product", "architecture", "qa"],
        session_refs=["product", "architecture", "qa", "synthesis"],
        contributions=[
            BrainstormContribution(
                contribution_id=perspective,
                perspective=perspective,
                problem="Partial exports",
                assumptions=[],
                alternatives=[],
                risks=[],
                questions=[],
                disagreements=[],
            )
            for perspective in ("product", "architecture", "qa")
        ],
        synthesis=BrainstormSynthesis(
            contribution_refs=["product", "architecture", "qa"],
            problem="Exports can be partial",
            beneficiaries=["operators"],
            in_scope=["Write an atomic export"],
            out_of_scope=["Cloud upload"],
            options=["atomic file"],
            recommendation="Use an atomic file",
            divergences=[],
            strong_objections=[],
            blocking_questions=["Which format?"] if blocking else [],
            non_blocking_questions=[],
            criterion_leads=["The export is atomic"],
        ),
        user_answers=["Keep data local"],
        decisions=["Keep data local"],
        panel_executed=True,
    )
    database.put_artifact(
        "brainstorm-brief", canonical_model_bytes(brief), artifact_id="brief:safe-export"
    )
    database.close()
    return repository, data_dir


def _answers(*, blocking_answer: str | None = None, approve: str = "oui") -> list[str]:
    return [
        *([blocking_answer] if blocking_answer is not None else []),
        "",
        "",
        "",
        "",
        "",
        "",
        "a completed run",
        "the export starts",
        "one complete file exists",
        "Export is atomic",
        "test",
        "Test interrupted writes",
        "Disk full",
        "",
        "Revert the export",
        approve,
    ]


def test_guided_spec_requires_answer_before_freeze_and_preserves_draft(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repository, data_dir = _setup(tmp_path, blocking=True)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    answers = iter(_answers(blocking_answer=""))
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export"]) == 0
    draft_path = data_dir / "guided" / "project" / "safe-export" / "draft.json"
    draft = FeatureSpec.model_validate_json(draft_path.read_text())
    assert draft.open_questions == ["Which format?"]
    assert not (draft_path.parent / "frozen.json").exists()
    database = Database(data_dir / "cohorte.sqlite3")
    assert database.get_feature("safe-export")["status"] == "draft"
    assert "Questions encore ouvertes" in capsys.readouterr().out
    database.close()


def test_guided_freeze_binds_profile_and_start_refuses_tampered_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, data_dir = _setup(tmp_path)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    answers = iter(_answers())
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))

    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export"]) == 0
    database = Database(data_dir / "cohorte.sqlite3")
    project = database.get_project("project")
    assert database.get_feature("safe-export")["status"] == "frozen"
    location = data_dir / "guided" / "project" / "safe-export"
    spec = FeatureSpec.model_validate_json((location / "frozen.json").read_text())
    assert spec.status.value == "frozen"
    assert spec.brief_ref is not None
    assert database.latest_artifact("ready:safe-export")["content"]

    monkeypatch.setattr(builtins, "input", lambda _prompt: "non")
    with pytest.raises(ValueError, match="cancelled before creating a run"):
        guided_start(database, data_dir, project, "safe-export")
    assert database.list_runs("project") == []

    frozen_bytes = (location / "frozen.json").read_bytes()
    (location / "frozen.json").write_text(json.dumps({"changed": True}))
    with pytest.raises(ValueError, match="changed after freeze"):
        guided_start(database, data_dir, project, "safe-export")
    (location / "frozen.json").write_bytes(frozen_bytes)
    changed_profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
    changed_profile.name = "Changed project"
    database.update_project_profile(
        "project", canonical_model_bytes(changed_profile), project["profile_ref"]["revision"]
    )
    with pytest.raises(ValueError, match="project profile changed after freeze"):
        guided_start(database, data_dir, database.get_project("project"), "safe-export")
    database.close()


class _Runtime:
    def build(self, workspace: Path, prompt: str) -> AgentReport:
        assert "Frozen feature spec" in prompt
        (workspace / "src" / "export.txt").write_text("ready\n")
        return AgentReport(summary="implemented", changed_files=["src/export.txt"])

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        assert "Independently review" in prompt
        return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=["api"])

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        raise AssertionError("unexpected fix")


def test_guided_start_reuses_loop_and_creates_ship_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repository, data_dir = _setup(tmp_path)
    monkeypatch.chdir(repository)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.delenv("EDITOR", raising=False)
    answers = iter(_answers())
    monkeypatch.setattr(builtins, "input", lambda _prompt: next(answers))
    assert cli.run(["--data-dir", str(data_dir), "spec", "safe-export"]) == 0
    capsys.readouterr()

    monkeypatch.setattr(builtins, "input", lambda _prompt: "oui")
    monkeypatch.setattr(cli, "workflow_runtime", lambda *_args, **_kwargs: _Runtime())
    assert cli.run(["--data-dir", str(data_dir), "start", "safe-export"]) == 0
    database = Database(data_dir / "cohorte.sqlite3")
    runs = database.list_runs("project")
    assert len(runs) == 1
    ship_request = database.ship_request_for_run(runs[0].id)
    assert ship_request["status"] == "pending"
    assert (repository / "src" / "export.txt").read_text() == "original\n"
    assert "ship_request_id" in capsys.readouterr().out
    database.close()
