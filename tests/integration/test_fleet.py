from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

from cohorte.application.fleet import FleetRunner, plan_fleet
from cohorte.application.fleet_control import (
    create_supervised_fleet,
    preview_supervised_fleet,
    supervised_fleet_status,
    sync_supervised_fleet,
)
from cohorte.application.vertical import (
    AgentReport,
    AgentReview,
    ReviewFinding,
    VerticalRunner,
    plan_feature,
)
from cohorte.cli import main as cli
from cohorte.domain.evidence import ReviewVerdict
from cohorte.domain.models import (
    AgentDefaults,
    CheckDefinition,
    Criterion,
    DefinitionOfDone,
    FeatureSpec,
    MetadataMode,
    Policy,
    ProjectProfile,
    Provider,
    RequirementPlan,
    Scenario,
    SpecStatus,
    Surface,
    VcsConfig,
)


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True)
    return result.stdout.strip()


class FleetRuntime:
    def __init__(self, expected_concurrency: int = 1) -> None:
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.start_barrier = (
            threading.Barrier(expected_concurrency) if expected_concurrency > 1 else None
        )

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.start_barrier is not None:
                self.start_barrier.wait(timeout=300)
            time.sleep(0.05)
            if '"feature_id": "api-feature"' in prompt:
                target = workspace / "api.py"
                target.write_text(
                    target.read_text() + "api-feature\n" if target.exists() else "api-feature\n"
                )
                changed = ["api.py"]
            elif '"feature_id": "api-followup"' in prompt:
                target = workspace / "api.py"
                assert target.read_text() == "api-feature\n"
                target.write_text(target.read_text() + "api-followup\n")
                changed = ["api.py"]
            else:
                target = workspace / "web.py"
                target.write_text("web-feature\n")
                changed = ["web.py"]
            return AgentReport(summary="built", changed_files=changed)
        finally:
            with self.lock:
                self.active -= 1

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        if "complete fleet candidate" in prompt:
            covered = ["api", "web"] if (workspace / "web.py").exists() else ["api"]
        elif "api-feature" in prompt or "api-followup" in prompt:
            covered = ["api"]
        else:
            covered = ["web"]
        return AgentReview(verdict=ReviewVerdict.READY, covered_surfaces=covered)

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        raise AssertionError("fix should not run")


class GroundedFleetRuntime(FleetRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.integration_reviews = 0
        self.integration_fixes = 0

    def review(self, workspace: Path, prompt: str) -> AgentReview:
        if "complete fleet candidate" in prompt:
            self.integration_reviews += 1
            assert "api.py:1" in prompt
            assert "untrusted leads" in prompt
            if self.integration_reviews == 1:
                return AgentReview(
                    verdict=ReviewVerdict.FIX,
                    covered_surfaces=["api", "web"],
                    findings=[
                        ReviewFinding(
                            severity="high", path="api.py", message="integration marker missing"
                        )
                    ],
                )
        return super().review(workspace, prompt)

    def fix(self, workspace: Path, prompt: str) -> AgentReport:
        self.integration_fixes += 1
        assert "api.py:1" in prompt
        assert "Specs:" in prompt
        assert "integration marker missing" in prompt
        target = workspace / "api.py"
        target.write_text(target.read_text() + "integration-marker\n")
        return AgentReport(summary="fixed fleet integration", changed_files=["api.py"])


def profile() -> ProjectProfile:
    return ProjectProfile(
        schema_version=1,
        project_id="fleet-demo",
        name="Fleet demo",
        language="en",
        metadata_mode=MetadataMode.LOCAL,
        vcs=VcsConfig(),
        surfaces=[
            Surface(
                id="api",
                label="API",
                paths=["api.py"],
                role_profile="implementer",
                check_ids=["api-check"],
            ),
            Surface(
                id="web",
                label="Web",
                paths=["web.py"],
                role_profile="implementer",
                check_ids=["web-check"],
            ),
        ],
        checks=[
            CheckDefinition(
                id="api-check",
                argv=["sh", "-c", "test -f api.py"],
                timeout_seconds=10,
            ),
            CheckDefinition(
                id="web-check",
                argv=["sh", "-c", "test -f web.py"],
                timeout_seconds=10,
            ),
        ],
        agent_defaults=AgentDefaults(provider=Provider.CODEX, account_ref="codex-native"),
        policy=Policy(max_parallel_per_account=2, max_parallel_global=3),
    )


def feature(
    feature_id: str, surface: str, check_id: str, dependencies: list[str] | None = None
) -> FeatureSpec:
    return FeatureSpec(
        schema_version=1,
        feature_id=feature_id,
        revision=1,
        status=SpecStatus.FROZEN,
        title=f"Implement {feature_id}",
        problem=f"{feature_id} is missing.",
        in_scope=[f"Implement {feature_id}."],
        out_of_scope=[],
        surfaces=[surface],
        scenarios=[Scenario(id="works", given="a checkout", when="used", then="it works")],
        acceptance=[
            Criterion(
                id="implemented",
                statement=f"{feature_id} exists",
                verification="automatic",
                check_ids=[check_id],
                surface_ids=[surface],
            )
        ],
        dod=DefinitionOfDone(required_checks=[check_id]),
        contract_refs=[],
        dependencies=dependencies or [],
        migrations=RequirementPlan(required=False, plan="No migration."),
        rollback=RequirementPlan(required=False, plan="Remove the file."),
        design_refs=[],
        rbac_requirements=[],
        open_questions=[],
    )


def repository(tmp_path: Path) -> Path:
    root = tmp_path / "repository"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    (root / "README.md").write_text("fleet\n")
    git(root, "add", ".")
    git(root, "commit", "-m", "initial")
    return root


def test_supervised_fleet_provisions_status_and_syncs_after_merge(tmp_path: Path) -> None:
    root = repository(tmp_path)
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "--bare", str(remote))
    git(root, "remote", "add", "origin", str(remote))
    git(root, "push", "-u", "origin", "main")
    manifest = tmp_path / "state" / "fleet.json"
    specs = [feature("api-feature", "api", "api-check"), feature("web-feature", "web", "web-check")]
    preview = preview_supervised_fleet(root, tmp_path / "worktrees", profile(), specs, "supervised")
    assert preview["prepared"] is False
    assert not manifest.exists()
    assert not (tmp_path / "worktrees").exists()
    planned = create_supervised_fleet(
        root, tmp_path / "worktrees", manifest, profile(), specs, "supervised"
    )
    assert planned["order"] == ["api-feature", "web-feature"]
    assert planned["prepared"] is True
    assert all(Path(item["worktree"]).is_dir() for item in planned["features"].values())
    assert all(row["behind"] == 0 for row in supervised_fleet_status(manifest)["rows"])

    api = Path(planned["features"]["api-feature"]["worktree"])
    (api / "api.py").write_text("ready\n")
    git(api, "add", ".")
    git(api, "commit", "-m", "api feature")
    git(root, "merge", "--ff-only", planned["features"]["api-feature"]["branch"])
    git(root, "push", "origin", "main")
    preview = sync_supervised_fleet(manifest, "api-feature")
    assert preview["outcomes"] == [
        {"feature_id": "web-feature", "status": "rebase-ready", "action": "sync --apply"}
    ]
    applied = sync_supervised_fleet(manifest, "api-feature", apply=True)
    assert applied["outcomes"][0]["status"] == "rebased"
    assert applied["outcomes"][0]["action"] == "rerun review before ship"
    assert supervised_fleet_status(manifest)["rows"][0]["behind"] == 0


def test_supervised_fleet_refuses_dirty_branch_and_unmerged_sync(tmp_path: Path) -> None:
    root = repository(tmp_path)
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "--bare", str(remote))
    git(root, "remote", "add", "origin", str(remote))
    git(root, "push", "-u", "origin", "main")
    manifest = tmp_path / "state" / "fleet.json"
    specs = [feature("api-feature", "api", "api-check"), feature("web-feature", "web", "web-check")]
    planned = create_supervised_fleet(
        root, tmp_path / "worktrees", manifest, profile(), specs, "supervised"
    )
    import pytest

    with pytest.raises(ValueError, match="not merged"):
        sync_supervised_fleet(manifest, "api-feature", apply=True)
    api = Path(planned["features"]["api-feature"]["worktree"])
    (api / "api.py").write_text("ready\n")
    git(api, "add", ".")
    git(api, "commit", "-m", "api feature")
    git(root, "merge", "--ff-only", planned["features"]["api-feature"]["branch"])
    git(root, "push", "origin", "main")
    web = Path(planned["features"]["web-feature"]["worktree"])
    (web / "work.txt").write_text("in progress\n")
    outcome = sync_supervised_fleet(manifest, "api-feature", apply=True)
    assert outcome["outcomes"][0]["status"] == "dirty"
    assert (web / "work.txt").read_text() == "in progress\n"


def test_loop_can_build_in_prepared_fleet_worktree(tmp_path: Path, monkeypatch, capsys) -> None:
    root = repository(tmp_path)
    selected_profile = profile()
    selected_spec = feature("api-feature", "api", "api-check")
    profile_path = tmp_path / "profile.json"
    spec_path = tmp_path / "spec.json"
    profile_path.write_text(selected_profile.model_dump_json())
    spec_path.write_text(selected_spec.model_dump_json())
    manifest = tmp_path / "state" / "fleet.json"
    planned = create_supervised_fleet(
        root,
        tmp_path / "worktrees",
        manifest,
        selected_profile,
        [selected_spec],
        "supervised",
        profile_path=profile_path,
        spec_paths=[spec_path],
    )
    candidate = Path(planned["features"]["api-feature"]["worktree"])
    monkeypatch.setattr(cli, "workflow_runtime", lambda *_args, **_kwargs: FleetRuntime())
    assert (
        cli.run(
            [
                "--json",
                "--data-dir",
                str(tmp_path / "data"),
                "loop",
                str(spec_path),
                "--profile",
                str(profile_path),
                "--repo",
                str(root),
                "--worktrees",
                str(tmp_path / "worktrees"),
                "--existing-worktree",
                str(candidate),
                "--run-id",
                "supervised-api-feature",
                "--live",
            ]
        )
        == 0
    )
    output = json.loads(capsys.readouterr().out)
    assert output["ok"] is True
    assert (candidate / "api.py").read_text() == "api-feature\n"
    assert output["data"]["worktree"] == str(candidate)


def test_active_design_rbac_and_mobile_constraints_must_be_in_spec(tmp_path: Path) -> None:
    import pytest

    selected_profile = profile()
    document = selected_profile.model_dump(mode="json")
    document["surfaces"][1]["role_profile"] = "frontend"
    document["surfaces"][1]["uses_design"] = True
    document["integrations"]["design"] = {
        "enabled": True,
        "provider": "file",
        "source": "design.json",
        "snapshot_path": "snapshot.json",
    }
    document["integrations"]["rbac"] = {"enabled": True}
    document["integrations"]["mobile"] = {"enabled": True}
    selected_profile = ProjectProfile.model_validate_json(json.dumps(document))
    selected_spec = feature("web-feature", "web", "web-check")
    with pytest.raises(ValueError, match="design, rbac, mobile"):
        plan_feature(selected_profile, selected_spec, "a" * 40)
    selected_spec = selected_spec.model_copy(
        update={
            "design_refs": ["file:design.json", "Use the declared tokens"],
            "rbac_requirements": ["Only admins may edit"],
            "mobile_requirements": ["Works at 375px width"],
        }
    )
    assert plan_feature(selected_profile, selected_spec, "a" * 40).tasks
    task = plan_feature(selected_profile, selected_spec, "a" * 40).tasks[0]
    build_prompt = VerticalRunner._build_prompt(tmp_path, selected_profile, selected_spec, task)
    assert "Target product copy language: en" in build_prompt
    review_prompt = VerticalRunner._review_prompt(
        tmp_path, selected_profile, selected_spec, "a" * 40, ["web.py"], ""
    )
    assert (
        "Active project constraints to verify against spec and diff: ['design', 'mobile', 'rbac']"
        in review_prompt
    )
    assert "target language en" in review_prompt


def test_fleet_parallelizes_disjoint_features_and_revalidates_each(tmp_path: Path) -> None:
    root = repository(tmp_path)
    runtime = FleetRuntime(expected_concurrency=2)
    specs = [feature("api-feature", "api", "api-check"), feature("web-feature", "web", "web-check")]

    result = FleetRunner(runtime).run(root, tmp_path / "worktrees", profile(), specs, "fleet-one")

    assert result.ready_to_ship is True
    assert result.max_feature_parallelism == 2
    assert runtime.max_active == 2
    assert result.plan["waves"] == [["api-feature", "web-feature"]]
    assert result.plan["overlaps"] == []
    assert [item["feature_id"] for item in result.revalidations] == [
        "api-feature",
        "web-feature",
    ]
    assert (Path(result.worktree) / "api.py").read_text() == "api-feature\n"
    assert (Path(result.worktree) / "web.py").read_text() == "web-feature\n"


def test_fleet_integration_review_and_fix_receive_current_repository_context(
    tmp_path: Path,
) -> None:
    root = repository(tmp_path)
    runtime = GroundedFleetRuntime()
    specs = [feature("api-feature", "api", "api-check"), feature("web-feature", "web", "web-check")]

    result = FleetRunner(runtime).run(
        root, tmp_path / "worktrees", profile(), specs, "fleet-context"
    )

    assert result.ready_to_ship is True
    assert runtime.integration_reviews == 2
    assert runtime.integration_fixes == 1


def test_fleet_serializes_overlapping_features_on_updated_base(tmp_path: Path) -> None:
    root = repository(tmp_path)
    runtime = FleetRuntime()
    specs = [
        feature("api-feature", "api", "api-check"),
        feature("api-followup", "api", "api-check"),
    ]
    plan = plan_fleet(profile(), specs, "fleet-overlap", git(root, "rev-parse", "HEAD"))

    assert plan.waves == [["api-feature"], ["api-followup"]]
    assert plan.dependencies["api-followup"] == ["api-feature"]
    assert len(plan.overlaps) == 1

    result = FleetRunner(runtime).run(
        root, tmp_path / "worktrees", profile(), specs, "fleet-overlap"
    )

    assert result.max_feature_parallelism == 1
    assert result.features[1]["base_commit"] == result.features[0]["integration_head"]
    assert (Path(result.worktree) / "api.py").read_text() == "api-feature\napi-followup\n"
