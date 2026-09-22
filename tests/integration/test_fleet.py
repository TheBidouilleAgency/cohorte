from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

from cohorte.application.fleet import FleetRunner, plan_fleet
from cohorte.application.vertical import AgentReport, AgentReview
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
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def build(self, workspace: Path, prompt: str) -> AgentReport:
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
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


def test_fleet_parallelizes_disjoint_features_and_revalidates_each(tmp_path: Path) -> None:
    root = repository(tmp_path)
    runtime = FleetRuntime()
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
