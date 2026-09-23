from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from cohorte.application.maintenance import AuditFinding, AuditReport, AuditSpec
from cohorte.domain.models import RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database


def run_cli(data_dir: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "cohorte.cli.main",
            "--json",
            "--data-dir",
            str(data_dir),
            *args,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def test_profile_can_be_reviewed_edited_and_refreshed(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (project / "src").mkdir()
    data_dir = tmp_path / "data"

    first = run_cli(data_dir, "init", str(project))
    assert first.returncode == 0, first.stderr
    original = json.loads(first.stdout)["data"]
    project_id = original["profile"]["project_id"]

    repeated = run_cli(data_dir, "init", str(project))
    assert json.loads(repeated.stdout)["data"]["existing"] is True
    assert json.loads(repeated.stdout)["data"]["profile_ref"] == original["profile_ref"]

    edited = original["profile"]
    edited["name"] = "Reviewed project"
    source = tmp_path / "reviewed.json"
    source.write_text(json.dumps(edited))
    applied = run_cli(data_dir, "profile", "apply", str(source), "--project-id", project_id)
    assert applied.returncode == 0, applied.stderr
    assert json.loads(applied.stdout)["data"]["profile_ref"]["revision"] == 2

    shown = run_cli(data_dir, "profile", "show", project_id)
    assert json.loads(shown.stdout)["data"]["profile"]["name"] == "Reviewed project"
    stale = run_cli(data_dir, "profile", "apply", str(source), "--project-id", project_id)
    assert stale.returncode != 0

    (project / "package.json").write_text('{"scripts":{"test":"node --test","lint":"eslint ."}}')
    refreshed = run_cli(data_dir, "init", str(project), "--refresh")
    assert refreshed.returncode == 0, refreshed.stderr
    result = json.loads(refreshed.stdout)["data"]
    assert result["profile_ref"]["revision"] == 3
    assert [check["id"] for check in result["profile"]["checks"]] == ["tests", "lint"]


def test_doctor_is_honest_about_provider_support(tmp_path: Path) -> None:
    result = run_cli(tmp_path, "doctor")
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert (
        payload["data"]["support_claim"]
        == "codex-bounded-live-align-local-integrations-migration-darwin-service-windows-ci-pipe"
    )
    assert all(provider["certified"] is False for provider in payload["data"]["providers"])


def test_unavailable_external_context_is_explicit_at_cli_boundary(tmp_path: Path) -> None:
    project = tmp_path / "project"
    data_dir = tmp_path / "data"
    project.mkdir()
    initialized = run_cli(data_dir, "init", str(project))
    assert initialized.returncode == 0, initialized.stderr
    profile = json.loads(initialized.stdout)["data"]["profile"]
    profile["integrations"]["design"] = {
        "enabled": True,
        "provider": "figma",
        "source": "design-id",
    }
    profile["integrations"]["retrieval"] = {
        "provider": "graphify",
        "fallback_to_files": False,
        "roots": ["."],
    }
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(profile))

    output = tmp_path / "snapshot.json"
    design = run_cli(
        data_dir,
        "design-snapshot",
        "--profile",
        str(profile_path),
        "--repo",
        str(project),
        "--output",
        str(output),
    )
    assert design.returncode == 3
    assert json.loads(design.stdout)["error"]["code"] == "DESIGN_UNAVAILABLE"
    assert not output.exists()

    retrieval = run_cli(
        data_dir,
        "retrieve",
        "needle",
        "--profile",
        str(profile_path),
        "--repo",
        str(project),
    )
    assert retrieval.returncode == 3
    assert json.loads(retrieval.stdout)["error"]["code"] == "RETRIEVAL_UNAVAILABLE"


def test_migration_cli_plans_applies_and_rolls_back_v2_metadata(tmp_path: Path) -> None:
    source = tmp_path / "v2"
    (source / "specs").mkdir(parents=True)
    (source / "PIPELINE.md").write_text("# Pipeline\n")
    (source / "specs" / "feature.md").write_text("# Feature\n")
    plan_path = tmp_path / "migration-plan.json"
    data_dir = tmp_path / "data"

    planned = run_cli(data_dir, "migrate", "--from-v2", str(source), "--plan", str(plan_path))
    assert planned.returncode == 0, planned.stderr
    assert plan_path.is_file()
    assert json.loads(planned.stdout)["data"]["plan"]["active_runs_imported"] is False

    applied = run_cli(data_dir, "migrate", "--apply", str(plan_path))
    assert applied.returncode == 0, applied.stderr
    applied_data = json.loads(applied.stdout)["data"]
    assert applied_data["imported_files"] == 2
    assert applied_data["rollback_verified"] is True

    rolled_back = run_cli(data_dir, "migrate", "--rollback", applied_data["backup_path"])
    assert rolled_back.returncode == 0, rolled_back.stderr
    assert Path(json.loads(rolled_back.stdout)["data"]["safety_backup"]).is_file()


def test_intake_and_patch_spec_cli_preserve_source_provenance(tmp_path: Path) -> None:
    project = tmp_path / "project"
    data_dir = tmp_path / "data"
    project.mkdir()
    initialized = run_cli(data_dir, "init", str(project))
    assert initialized.returncode == 0, initialized.stderr
    init_data = json.loads(initialized.stdout)["data"]
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(init_data["profile"]))

    source = "Bug: total is wrong. Steps to reproduce: call total(2, 3); it returns 6."
    intake = run_cli(data_dir, "intake", init_data["profile"]["project_id"], "--text", source)
    assert intake.returncode == 0, intake.stderr
    intake_data = json.loads(intake.stdout)["data"]
    assert intake_data["report"]["triage"] == "patch"
    assert intake_data["report"]["content"] == source
    repeated = run_cli(data_dir, "intake", init_data["profile"]["project_id"], "--text", source)
    assert repeated.returncode == 0, repeated.stderr
    repeated_data = json.loads(repeated.stdout)["data"]
    assert repeated_data["feature_id"] == intake_data["feature_id"]
    assert repeated_data["source_ref"] == intake_data["source_ref"]

    patch_path = tmp_path / "patch.json"
    source_ref = intake_data["source_ref"]
    patch_spec = run_cli(
        data_dir,
        "patch-spec",
        "--source-artifact-id",
        source_ref["id"],
        "--source-revision",
        str(source_ref["revision"]),
        "--profile",
        str(profile_path),
        "--patch-id",
        "fix-total",
        "--title",
        "Fix total",
        "--reproduction",
        "Call total(2, 3)",
        "--observed",
        "Returns 6",
        "--expected",
        "Returns 5",
        "--surface",
        "project",
        "--write-path",
        "calc.py",
        "--manual-regression",
        "--in-scope",
        "Correct total",
        "--rollback",
        "Revert calc.py",
        "--output",
        str(patch_path),
    )
    assert patch_spec.returncode == 0, patch_spec.stderr
    document = json.loads(patch_path.read_text())
    assert document["source_ref"] == source_ref
    assert document["write_paths"] == ["calc.py"]
    assert document["status"] == "frozen"


def test_retro_rule_is_applied_only_after_request_approval(tmp_path: Path) -> None:
    project = tmp_path / "project"
    data_dir = tmp_path / "data"
    project.mkdir()
    initialized = run_cli(data_dir, "init", str(project))
    init_data = json.loads(initialized.stdout)["data"]
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(init_data["profile"]))
    finding = AuditFinding(
        id="finding-repeat",
        fingerprint="b" * 64,
        severity="medium",
        category="maintainability",
        path="calc.py",
        explanation="Repeated pattern",
        impact="Maintenance risk",
        recommendation="Adopt a convention",
        priority=3,
    )
    scope = AuditSpec(
        audit_id="audit-one",
        title="Audit",
        surface_ids=["project"],
        paths=["calc.py"],
        concerns=["maintainability"],
    )
    report_paths = []
    for index in (1, 2):
        report = AuditReport(
            audit_id=f"audit-{index}",
            base_commit="a" * 40,
            source_tree_hash="c" * 64,
            final_tree_hash="c" * 64,
            scope=scope,
            covered_surfaces=["project"],
            findings=[finding],
            source_unchanged=True,
        )
        path = tmp_path / f"audit-{index}.json"
        path.write_text(report.model_dump_json())
        report_paths.append(path)
    proposal_path = tmp_path / "proposal.json"
    proposed = run_cli(
        data_dir,
        "retro",
        *(str(path) for path in report_paths),
        "--proposal-id",
        "consistent-calculation",
        "--rule",
        "Use one calculation convention.",
        "--output",
        str(proposal_path),
    )
    assert proposed.returncode == 0, proposed.stderr
    request_id = json.loads(proposed.stdout)["data"]["ratification_request_id"]
    output_path = tmp_path / "profile-ratified.json"
    missing = run_cli(
        data_dir,
        "retro-apply",
        str(proposal_path),
        "--profile",
        str(profile_path),
        "--decision-id",
        "missing",
        "--output",
        str(output_path),
    )
    assert missing.returncode != 0
    assert not output_path.exists()
    approved = run_cli(data_dir, "approve", request_id)
    decision_id = json.loads(approved.stdout)["data"]["decision_id"]
    applied = run_cli(
        data_dir,
        "retro-apply",
        str(proposal_path),
        "--profile",
        str(profile_path),
        "--decision-id",
        decision_id,
        "--output",
        str(output_path),
    )
    assert applied.returncode == 0, applied.stderr
    updated = json.loads(output_path.read_text())
    assert updated["revision"] == 2
    assert updated["conventions"] == ["Use one calculation convention."]


def test_export_cli_writes_a_redacted_run_atomically(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    database = Database(data_dir / "cohorte.sqlite3")
    database.register_project("project", str(tmp_path / "project"), "profile")
    now = datetime.now(UTC)
    database.create_run(
        RunState(
            id="export-run",
            project_id="project",
            feature_id="feature",
            stage=Stage.PLAN,
            status=RunStatus.RUNNING,
            state_version=1,
            base_commit="a" * 40,
            created_at=now,
            updated_at=now,
        )
    )
    secret = "sk-fake-cli-secret"
    database.append_event(
        "agent.output", {"message": f"ANTHROPIC_API_KEY={secret}"}, run_id="export-run"
    )
    database.close()
    destination = tmp_path / "exports" / "run.json"

    result = run_cli(
        data_dir,
        "export",
        "export-run",
        "--output",
        str(destination),
        "--max-bytes",
        "4096",
    )

    assert result.returncode == 0, result.stderr
    exported = destination.read_text()
    assert secret not in exported
    assert "[REDACTED]" in exported
    assert not destination.with_name(f".{destination.name}.cohorte.tmp").exists()
