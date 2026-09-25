from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from cohorte.application.maintenance import (
    AuditFinding,
    AuditReport,
    AuditRunner,
    AuditSpec,
    RefactorRunner,
    RefactorSelection,
    propose_retro,
    ratify_retro,
)
from cohorte.application.vertical import AgentReport, AgentReview, ReviewFinding
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import (
    AgentDefaults,
    ArtifactRef,
    CheckDefinition,
    CheckScope,
    MetadataMode,
    ProjectProfile,
    Provider,
    Surface,
    VcsConfig,
)


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def repository(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "test@example.invalid")
    git(root, "config", "user.name", "Test")
    (root / "calc.py").write_text("def total(a: int, b: int) -> int:\n    return a + b\n")
    (root / "test_calc.py").write_text(
        "import unittest\nfrom calc import total\n\n"
        "class T(unittest.TestCase):\n"
        "    def test_total(self): self.assertEqual(total(2, 3), 5)\n"
    )
    git(root, "add", ".")
    git(root, "commit", "-m", "base")
    return root


def profile() -> ProjectProfile:
    return ProjectProfile(
        project_id="maintenance-demo",
        name="Maintenance demo",
        language="en",
        metadata_mode=MetadataMode.LOCAL,
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="python",
                label="Python",
                paths=["calc.py", "test_calc.py"],
                role_profile="implementer",
                check_ids=["unit"],
            )
        ],
        checks=[
            CheckDefinition(
                id="unit",
                argv=["python3", "-m", "unittest", "-v", "test_calc.py"],
                timeout_seconds=30,
                scope=CheckScope.CRITERION,
            )
        ],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )


class MaintenanceRuntime:
    mutate_audit = False

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        assert "approved-refactor" in prompt
        path = workspace / "calc.py"
        path.write_text(
            "def total(a: int, b: int) -> int:\n    result = a + b\n    return result\n"
        )
        return AgentReport(summary="refactored", changed_files=["calc.py"])

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        if "Audit this bounded domain" in prompt:
            if self.mutate_audit:
                (workspace / "calc.py").write_text("# mutated\n")
            return AgentReview(
                verdict=ReviewVerdict.FIX,
                covered_surfaces=["python"],
                findings=[
                    ReviewFinding(
                        severity="medium",
                        path="calc.py",
                        message="Duplicate calculation logic needs a named intermediate",
                    )
                ],
            )
        return AgentReview(
            verdict=ReviewVerdict.READY,
            covered_surfaces=["python"],
            findings=[],
        )

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        raise AssertionError("fix should not run")


def audit_spec(identifier: str = "audit-python") -> AuditSpec:
    return AuditSpec(
        audit_id=identifier,
        title="Audit Python",
        surface_ids=["python"],
        paths=["calc.py"],
        concerns=["maintainability"],
    )


def ref() -> ArtifactRef:
    return ArtifactRef(id="artifact", revision=1, sha256="a" * 64)


def test_audit_is_read_only_and_produces_prioritized_backlog(tmp_path: Path) -> None:
    root = repository(tmp_path)
    report = AuditRunner(MaintenanceRuntime()).run(root, profile(), audit_spec())
    assert report.source_unchanged is True
    assert report.source_tree_hash == report.final_tree_hash
    assert report.findings[0].priority == 3
    assert report.findings[0].path == "calc.py"
    assert git(root, "status", "--short") == ""


def test_audit_accepts_a_surface_directory_without_reading_generated_files(tmp_path: Path) -> None:
    root = repository(tmp_path)
    (root / "node_modules").mkdir()
    (root / "node_modules/ignored.py").write_text("secret = 'do not inspect'\n")
    bounded, read_files = AuditRunner._bounded_sources(root, AuditRunner._audit_files(root, ["."]))
    assert "calc.py" in bounded
    assert "ignored.py" not in bounded
    assert "calc.py" in read_files


def test_audit_reports_unread_files_instead_of_claiming_full_coverage(tmp_path: Path) -> None:
    root = repository(tmp_path)
    for index in range(15):
        (root / f"module_{index:02}.py").write_text(f"VALUE = {index}\n")
    full_profile = profile().model_copy(
        update={"surfaces": [profile().surfaces[0].model_copy(update={"paths": ["."]})]}
    )
    spec = audit_spec().model_copy(update={"paths": ["."]})
    report = AuditRunner(MaintenanceRuntime()).run(root, full_profile, spec)
    assert report.coverage is not None
    assert report.coverage.discovered_files == 17
    assert len(report.coverage.model_read_files) == 12
    assert report.coverage.static_analyzed_files == 17
    assert report.coverage.complete_model_read is False


def test_audit_rejects_any_source_mutation(tmp_path: Path) -> None:
    root = repository(tmp_path)
    runtime = MaintenanceRuntime()
    runtime.mutate_audit = True
    with pytest.raises(CohorteError) as caught:
        AuditRunner(runtime).run(root, profile(), audit_spec())
    assert caught.value.code == ErrorCode.AUDIT_MUTATION


def test_audit_detects_structurally_identical_python_branches(tmp_path: Path) -> None:
    root = repository(tmp_path)
    (root / "calc.py").write_text(
        "def total(a, b):\n"
        "    if a >= 0:\n"
        "        result = a + b\n"
        "    else:\n"
        "        result = a + b\n"
        "    return result\n"
    )
    report = AuditRunner(MaintenanceRuntime()).run(root, profile(), audit_spec())
    assert any(
        finding.explanation == "Conditional branches are structurally identical"
        for finding in report.findings
    )


def test_refactor_requires_green_baseline_and_stays_in_approved_paths(
    tmp_path: Path,
) -> None:
    root = repository(tmp_path)
    selection = RefactorSelection(
        refactor_id="refactor-total",
        title="Refactor total",
        backlog_ref=ref(),
        approval_ref=ref().model_copy(update={"id": "approval"}),
        approved=True,
        selected_finding_ids=["finding-123"],
        invariants=["total(2, 3) remains 5"],
        surfaces=["python"],
        write_paths=["calc.py"],
        check_ids=["unit"],
        out_of_scope=["Change public behavior"],
        rollback="Revert calc.py",
    )
    result = RefactorRunner(MaintenanceRuntime()).run(
        root,
        tmp_path / "worktrees",
        profile(),
        selection,
        AuditReport(
            audit_id="audit-refactor",
            base_commit="a" * 40,
            source_tree_hash="b" * 64,
            final_tree_hash="b" * 64,
            scope=audit_spec(),
            covered_surfaces=["python"],
            findings=[
                AuditFinding(
                    id="finding-123",
                    fingerprint="c" * 64,
                    severity="medium",
                    category="maintainability",
                    path="calc.py",
                    explanation="Simplify",
                    impact="Complexity",
                    recommendation="Refactor",
                    priority=3,
                )
            ],
            source_unchanged=True,
        ),
        "refactor-run",
    )
    assert result.baseline_checks[0]["status"] == "passed"
    assert result.candidate.changed_files == ["calc.py"]
    assert result.candidate.ready_to_ship is True


def test_retro_cannot_change_profile_before_explicit_ratification(
    tmp_path: Path,
) -> None:
    root = repository(tmp_path)
    runner = AuditRunner(MaintenanceRuntime())
    reports = [
        runner.run(root, profile(), audit_spec("audit-one")),
        runner.run(root, profile(), audit_spec("audit-two")),
    ]
    proposal = propose_retro(
        "require-named-intermediate",
        "Use a named intermediate for duplicated calculations.",
        reports,
    )
    original = profile()
    with pytest.raises(CohorteError) as caught:
        ratify_retro(original, proposal, None)
    assert caught.value.code == ErrorCode.APPROVAL_REQUIRED
    assert original.conventions == []
    ratified = ratify_retro(original, proposal, ref())
    assert ratified.profile_after.revision == 2
    assert ratified.profile_after.conventions == [proposal.rule]
