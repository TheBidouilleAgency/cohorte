from __future__ import annotations

import json
from pathlib import Path

from cohorte.application.maintenance import (
    AuditFinding,
    AuditReport,
    AuditSpec,
    RefactorSelection,
    refactor_subject_hash,
)
from cohorte.cli import main as cli
from cohorte.domain.models import (
    AgentDefaults,
    CheckDefinition,
    ProjectProfile,
    Provider,
    Surface,
    VcsConfig,
)
from cohorte.persistence.sqlite import Database


def test_refactor_plan_previews_then_persists_exact_user_selection(tmp_path: Path, capsys) -> None:
    root = tmp_path / "project"
    root.mkdir()
    (root / "calc.py").write_text("def total(a, b): return a + b\n")
    profile = ProjectProfile(
        project_id="project",
        name="Project",
        language="fr",
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="python",
                label="Python",
                paths=["calc.py"],
                role_profile="implementer",
                check_ids=["unit"],
            )
        ],
        checks=[CheckDefinition(id="unit", argv=["python", "-m", "unittest"], timeout_seconds=30)],
        agent_defaults=AgentDefaults(provider=Provider.CODEX),
    )
    report = AuditReport(
        audit_id="audit-refactor",
        base_commit="a" * 40,
        source_tree_hash="b" * 64,
        final_tree_hash="b" * 64,
        scope=AuditSpec(
            audit_id="audit-refactor",
            title="Audit",
            surface_ids=["python"],
            paths=["calc.py"],
            concerns=["complexity"],
        ),
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
    )
    profile_path = tmp_path / "profile.json"
    report_path = tmp_path / "audit.json"
    profile_path.write_text(profile.model_dump_json())
    report_path.write_text(report.model_dump_json(indent=2) + "\n")
    data = tmp_path / "data"
    database = Database(data / "cohorte.sqlite3")
    database.put_artifact("audit-report", report.model_dump_json(indent=2).encode())
    database.close()
    arguments = [
        "--json",
        "--data-dir",
        str(data),
        "refactor-plan",
        str(report_path),
        "--profile",
        str(profile_path),
        "--repo",
        str(root),
        "--finding",
        "finding-123",
        "--invariant",
        "total(2, 3) remains 5",
        "--rollback",
        "Revert candidate commit",
    ]

    assert cli.run(arguments) == 0
    preview = json.loads(capsys.readouterr().out)["data"]
    assert preview["approved"] is False
    assert preview["output"] is None
    database = Database(data / "cohorte.sqlite3")
    assert database.list_requests() == []
    database.close()

    assert cli.run([*arguments, "--approve"]) == 0
    applied = json.loads(capsys.readouterr().out)["data"]
    selection = RefactorSelection.model_validate_json(Path(applied["output"]).read_text())
    assert selection.approved is True
    assert selection.approval_ref is not None
    assert selection.approval_ref.sha256 == refactor_subject_hash(selection)
    database = Database(data / "cohorte.sqlite3")
    assert database.get_request(applied["request_id"])["status"] == "answered"
    database.close()
