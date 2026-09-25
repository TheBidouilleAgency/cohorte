"""Supervised multi-feature flight plan, separate from the headless fleet runner."""

from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cohorte.adapters.git import GitRepository
from cohorte.application.fleet import FleetPlan, plan_fleet
from cohorte.domain.models import FeatureSpec, ProjectProfile, RunState, RunStatus, SpecStatus


def _write_manifest(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


def _load_manifest(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text())
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise ValueError("invalid fleet manifest")
    return document


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip())
    return result.stdout.strip()


def preview_supervised_fleet(
    repository: Path,
    worktree_parent: Path,
    profile: ProjectProfile,
    specs: list[FeatureSpec],
    fleet_id: str,
    *,
    profile_path: Path | None = None,
    spec_paths: list[Path] | None = None,
) -> dict[str, Any]:
    if any(spec.status != SpecStatus.FROZEN for spec in specs):
        raise ValueError("every fleet spec must be frozen")
    if spec_paths is not None and len(spec_paths) != len(specs):
        raise ValueError("one spec path is required per feature")
    source = GitRepository(repository)
    plan: FleetPlan = plan_fleet(profile, specs, fleet_id, source.head)
    if source.is_dirty():
        raise ValueError("repository must be clean before provisioning fleet worktrees")
    worktree_parent = worktree_parent.resolve()
    paths = [worktree_parent / f"{fleet_id}-{feature_id}" for feature_id in plan.feature_ids]
    if any(path.exists() for path in paths):
        raise ValueError("a fleet worktree destination already exists")
    features: dict[str, dict[str, Any]] = {}
    for feature_id, destination in zip(plan.feature_ids, paths, strict=True):
        branch = f"cohorte/{fleet_id}/{feature_id}"
        features[feature_id] = {
            "worktree": str(destination),
            "branch": branch,
            "depends_on": plan.dependencies[feature_id],
            "spec_revision": next(spec.revision for spec in specs if spec.feature_id == feature_id),
            "spec_path": (
                str(
                    spec_paths[
                        next(
                            index
                            for index, spec in enumerate(specs)
                            if spec.feature_id == feature_id
                        )
                    ].resolve()
                )
                if spec_paths is not None
                else None
            ),
        }
    return {
        "schema_version": 1,
        "fleet_id": fleet_id,
        "project_id": profile.project_id,
        "repository": str(source.root),
        "profile_path": str(profile_path.resolve()) if profile_path is not None else None,
        "worktree_parent": str(worktree_parent),
        "remote": profile.vcs.remote,
        "default_branch": profile.vcs.default_branch,
        "base_commit": plan.base_commit,
        "created_at": datetime.now(UTC).isoformat(),
        "order": [feature_id for wave in plan.waves for feature_id in wave],
        "waves": plan.waves,
        "overlaps": [overlap.model_dump(mode="json") for overlap in plan.overlaps],
        "features": features,
        "merged": [],
        "prepared": False,
    }


def create_supervised_fleet(
    repository: Path,
    worktree_parent: Path,
    manifest_path: Path,
    profile: ProjectProfile,
    specs: list[FeatureSpec],
    fleet_id: str,
    *,
    profile_path: Path | None = None,
    spec_paths: list[Path] | None = None,
) -> dict[str, Any]:
    if manifest_path.exists():
        raise ValueError("fleet already exists; inspect its status instead of replacing it")
    document = preview_supervised_fleet(
        repository,
        worktree_parent,
        profile,
        specs,
        fleet_id,
        profile_path=profile_path,
        spec_paths=spec_paths,
    )
    source = GitRepository(repository)
    worktree_parent = worktree_parent.resolve()
    worktree_parent.mkdir(parents=True, exist_ok=True)
    for feature_id in document["order"]:
        item = document["features"][feature_id]
        source.create_worktree(Path(item["worktree"]), item["branch"], document["base_commit"])
    document["prepared"] = True
    _write_manifest(manifest_path, document)
    return document


def supervised_fleet_status(
    manifest_path: Path,
    *,
    fetch: bool = True,
    runs: list[RunState] | None = None,
    run_evidence: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    manifest = _load_manifest(manifest_path)
    remote = manifest["remote"]
    default_branch = manifest["default_branch"]
    rows: list[dict[str, Any]] = []
    latest_runs = {
        feature_id: max(
            (run for run in runs or [] if run.feature_id == feature_id),
            key=lambda run: run.updated_at,
            default=None,
        )
        for feature_id in manifest["order"]
    }
    for feature_id in manifest["order"]:
        item = manifest["features"][feature_id]
        worktree = Path(item["worktree"])
        if not worktree.is_dir():
            rows.append({"feature_id": feature_id, "state": "missing", "next": "restore worktree"})
            continue
        repo = GitRepository(worktree)
        if _git(worktree, "branch", "--show-current") != item["branch"]:
            rows.append(
                {"feature_id": feature_id, "state": "branch-mismatch", "next": "inspect worktree"}
            )
            continue
        try:
            if fetch:
                repo.fetch_ref(remote, f"refs/heads/{default_branch}")
            target = f"refs/remotes/{remote}/{default_branch}"
            upstream = _git(worktree, "rev-parse", target)
            ahead = int(_git(worktree, "rev-list", "--count", f"{upstream}..HEAD"))
            behind = int(_git(worktree, "rev-list", "--count", f"HEAD..{upstream}"))
        except RuntimeError as error:
            rows.append(
                {
                    "feature_id": feature_id,
                    "state": "upstream-unavailable",
                    "next": "retry fetch",
                    "error": str(error),
                }
            )
            continue
        dirty = repo.is_dirty()
        depends_on = item["depends_on"]
        pending = [dependency for dependency in depends_on if dependency not in manifest["merged"]]
        current_run = latest_runs[feature_id]
        if pending:
            next_action = f"wait for {', '.join(pending)}"
        elif current_run is not None and current_run.status not in {
            RunStatus.COMPLETED,
            RunStatus.FAILED,
            RunStatus.CANCELLED,
        }:
            next_action = f"continue run {current_run.id}"
        elif behind:
            next_action = "sync required"
        else:
            next_action = "continue feature session"
        rows.append(
            {
                "feature_id": feature_id,
                "state": "dirty" if dirty else "clean",
                "worktree": str(worktree),
                "branch": item["branch"],
                "head": repo.head,
                "ahead": ahead,
                "behind": behind,
                "depends_on": depends_on,
                "run": (
                    {
                        "id": current_run.id,
                        "stage": current_run.stage.value,
                        "status": current_run.status.value,
                        "evidence": (run_evidence or {}).get(current_run.id, {}),
                    }
                    if current_run is not None
                    else None
                ),
                "next": next_action,
            }
        )
    return {"fleet_id": manifest["fleet_id"], "order": manifest["order"], "rows": rows}


def sync_supervised_fleet(
    manifest_path: Path,
    merged_feature: str,
    *,
    apply: bool = False,
    active_features: set[str] | None = None,
) -> dict[str, Any]:
    manifest = _load_manifest(manifest_path)
    if merged_feature not in manifest["order"]:
        raise ValueError("merged feature is not in the active fleet")
    source = GitRepository(Path(manifest["repository"]))
    remote = manifest["remote"]
    default_branch = manifest["default_branch"]
    upstream = source.fetch_ref(remote, f"refs/heads/{default_branch}")
    merged_branch = manifest["features"][merged_feature]["branch"]
    merged_head = _git(source.root, "rev-parse", f"refs/heads/{merged_branch}")
    if (
        merged_head == manifest["base_commit"]
        or _git(source.root, "merge-base", merged_head, upstream) != merged_head
    ):
        raise ValueError("feature branch is not merged in the fetched default branch")
    manifest["merged"].append(merged_feature)
    manifest["order"].remove(merged_feature)
    outcomes: list[dict[str, Any]] = []
    for feature_id in manifest["order"]:
        item = manifest["features"][feature_id]
        worktree = Path(item["worktree"])
        if not worktree.is_dir():
            outcomes.append({"feature_id": feature_id, "status": "missing-worktree"})
            continue
        repo = GitRepository(worktree)
        if _git(worktree, "branch", "--show-current") != item["branch"]:
            outcomes.append({"feature_id": feature_id, "status": "branch-mismatch"})
            continue
        if active_features and feature_id in active_features:
            outcomes.append(
                {
                    "feature_id": feature_id,
                    "status": "active-run",
                    "action": "rebase in owning session",
                }
            )
            continue
        if repo.is_dirty():
            outcomes.append(
                {"feature_id": feature_id, "status": "dirty", "action": "rebase in owning session"}
            )
            continue
        behind = int(_git(worktree, "rev-list", "--count", f"HEAD..{upstream}"))
        if not behind:
            outcomes.append({"feature_id": feature_id, "status": "current"})
            continue
        if not apply:
            outcomes.append(
                {"feature_id": feature_id, "status": "rebase-ready", "action": "sync --apply"}
            )
            continue
        try:
            _git(worktree, "rebase", upstream)
        except RuntimeError as error:
            _git(worktree, "rebase", "--abort")
            outcomes.append({"feature_id": feature_id, "status": "conflict", "error": str(error)})
            continue
        outcomes.append(
            {
                "feature_id": feature_id,
                "status": "rebased",
                "head": repo.head,
                "action": "rerun review before ship",
            }
        )
    if apply:
        _write_manifest(manifest_path, manifest)
    return {
        "fleet_id": manifest["fleet_id"],
        "merged_feature": merged_feature,
        "outcomes": outcomes,
    }
