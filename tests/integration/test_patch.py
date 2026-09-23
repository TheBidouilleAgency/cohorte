from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from cohorte.application.patch import PatchRunner, PatchSpec, RegressionMode
from cohorte.application.vertical import AgentReport, AgentReview
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import (
    AgentDefaults,
    ArtifactRef,
    CheckDefinition,
    MetadataMode,
    Policy,
    ProjectProfile,
    Provider,
    Surface,
    VcsConfig,
)


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True)
    return result.stdout.strip()


class PatchRuntime:
    def __init__(self) -> None:
        self.builds = 0

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        self.builds += 1
        assert "regression-fixed" in prompt
        (workspace / "calc.py").write_text("def add(left, right):\n    return left + right\n")
        return AgentReport(summary="fixed addition", changed_files=["calc.py"])

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=["core"])

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        raise AssertionError("fix should not run")


def profile() -> ProjectProfile:
    return ProjectProfile(
        project_id="patch-demo",
        name="Patch demo",
        language="en",
        metadata_mode=MetadataMode.LOCAL,
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="core",
                label="Core",
                paths=["calc.py", "test_regression.py"],
                role_profile="implementer",
            )
        ],
        checks=[
            CheckDefinition(
                id="regression",
                argv=["python3", "-m", "unittest", "-v", "test_regression.py"],
                timeout_seconds=10,
            )
        ],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
        policy=Policy(max_fix_cycles=1),
    )


def patch() -> PatchSpec:
    return PatchSpec(
        patch_id="addition-regression",
        title="Fix integer addition",
        source_ref=ArtifactRef(id="source", revision=1, sha256="a" * 64),
        reproduction="Run python3 -m unittest -v test_regression.py.",
        observed_behavior="add(2, 3) returns 6.",
        expected_behavior="add(2, 3) returns 5.",
        surfaces=["core"],
        write_paths=["calc.py"],
        regression_mode=RegressionMode.AUTOMATIC,
        regression_check_ids=["regression"],
        in_scope=["Correct the addition implementation."],
        out_of_scope=["Change the public function signature."],
        rollback="Restore the previous calc.py implementation.",
    )


def repository(tmp_path: Path, *, broken: bool = True) -> Path:
    root = tmp_path / "repository"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    operation = "left * right" if broken else "left + right"
    (root / "calc.py").write_text(f"def add(left, right):\n    return {operation}\n")
    (root / "test_regression.py").write_text(
        "import unittest\nfrom calc import add\n\n"
        "class RegressionTest(unittest.TestCase):\n"
        "    def test_addition(self):\n"
        "        self.assertEqual(add(2, 3), 5)\n"
    )
    git(root, "add", ".")
    git(root, "commit", "-m", "initial")
    return root


def test_patch_requires_red_then_produces_green_candidate(tmp_path: Path) -> None:
    root = repository(tmp_path)
    runtime = PatchRuntime()

    result = PatchRunner(runtime).run(root, tmp_path / "worktrees", profile(), patch(), "patch-run")

    assert result.reproduction_observed is True
    assert result.reproduction_checks[0]["status"] == "failed"
    assert result.candidate.ready_to_ship is True
    assert result.candidate.checks[0]["status"] == "passed"
    assert result.candidate.changed_files == ["calc.py"]
    assert runtime.builds == 1


def test_patch_refuses_to_build_when_regression_is_not_red(tmp_path: Path) -> None:
    root = repository(tmp_path, broken=False)
    runtime = PatchRuntime()

    with pytest.raises(CohorteError) as caught:
        PatchRunner(runtime).run(root, tmp_path / "worktrees", profile(), patch(), "patch-run")

    assert caught.value.code == ErrorCode.REPRODUCTION_MISSING
    assert runtime.builds == 0
