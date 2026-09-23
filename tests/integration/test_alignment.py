from __future__ import annotations

import json
import subprocess
from pathlib import Path

from cohorte.application.alignment import (
    AlignmentRunner,
    AlignmentSelection,
    validate_alignment_plan,
)
from cohorte.application.context import (
    FileDesignPort,
    capture_design,
    plan_design_alignment,
)
from cohorte.application.vertical import AgentReport, AgentReview
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import (
    AgentDefaults,
    ArtifactRef,
    CheckDefinition,
    CheckScope,
    DesignConfig,
    MetadataMode,
    ProjectProfile,
    Provider,
    Surface,
    VcsConfig,
)


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def ref(identifier: str) -> ArtifactRef:
    return ArtifactRef(id=identifier, revision=1, sha256="a" * 64)


class AlignmentRuntime:
    def build(self, workspace: Path, prompt: str) -> AgentReport:
        assert "color-primary" in prompt
        (workspace / "design-snapshot.json").write_text(
            json.dumps(
                {
                    "version": "v2",
                    "tokens": {"color-primary": "#3366ff", "space-md": "16px"},
                }
            )
        )
        return AgentReport(summary="aligned", changed_files=["design-snapshot.json"])

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        return AgentReview(
            verdict=ReviewVerdict.READY,
            covered_surfaces=["design"],
            findings=[],
        )

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        raise AssertionError("fix should not run")


def test_alignment_plan_then_bounded_build_and_review(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    source = {
        "version": "v2",
        "tokens": {"color-primary": "#3366ff", "space-md": "16px"},
    }
    (root / "design-source.json").write_text(json.dumps(source))
    (root / "design-snapshot.json").write_text(
        json.dumps({"version": "v1", "tokens": {"color-primary": "#000000"}})
    )
    (root / "test_design.py").write_text(
        "import json, unittest\n"
        "class T(unittest.TestCase):\n"
        " def test_tokens(self):\n"
        "  d=json.load(open('design-snapshot.json'))\n"
        "  self.assertEqual(d['tokens']['color-primary'], '#3366ff')\n"
        "  self.assertEqual(d['tokens']['space-md'], '16px')\n"
    )
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "test@example.invalid")
    git(root, "config", "user.name", "Test")
    git(root, "add", ".")
    git(root, "commit", "-m", "base")
    config = DesignConfig(
        enabled=True,
        provider="file",
        source="design-source.json",
        snapshot_path="design-snapshot.json",
    )
    capture = capture_design(config, FileDesignPort(root))
    plan = plan_design_alignment(root, config, capture)
    assert plan.status == "changes"
    assert {delta.key for delta in plan.deltas} == {
        "tokens.color-primary",
        "tokens.space-md",
        "version",
    }
    selection = AlignmentSelection(
        alignment_id="align-design",
        title="Align design snapshot",
        plan_ref=ref("plan"),
        approval_ref=ref("approval"),
        approved=True,
        surfaces=["design"],
        write_paths=["design-snapshot.json"],
        check_ids=["design-check"],
        out_of_scope=["Change runtime code"],
        rollback="Revert design-snapshot.json",
    )
    validate_alignment_plan(selection, plan)
    profile = ProjectProfile(
        project_id="align-demo",
        name="Align demo",
        language="en",
        metadata_mode=MetadataMode.LOCAL,
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="design",
                label="Design",
                paths=["design-snapshot.json", "test_design.py"],
                role_profile="implementer",
                check_ids=["design-check"],
                uses_design=True,
            )
        ],
        checks=[
            CheckDefinition(
                id="design-check",
                argv=["python3", "-m", "unittest", "-v", "test_design.py"],
                timeout_seconds=30,
                scope=CheckScope.CRITERION,
            )
        ],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
        integrations={
            "design": config.model_dump(),
            "retrieval": {"provider": "none"},
        },
    )
    result = AlignmentRunner(AlignmentRuntime()).run(
        root,
        tmp_path / "worktrees",
        profile,
        selection,
        plan,
        "align-run",
    )
    assert result.applied_deltas == 3
    assert result.candidate.changed_files == ["design-snapshot.json"]
    assert result.candidate.ready_to_ship is True
