"""Project-scoped Obsidian mirror for durable Cohorte milestones."""

from __future__ import annotations

import json
import warnings
from typing import Any

from cohorte.application.kanban import KanbanCard, apply_projection, plan_projection
from cohorte.domain.errors import CohorteError
from cohorte.domain.models import KanbanConfig, RunState, RunStatus, Stage
from cohorte.persistence.sqlite import Database


def save_idea_seed(database: Database, feature_id: str, *, source_id: str, title: str) -> None:
    database.put_artifact(
        "kanban-idea-seed",
        json.dumps({"source_id": source_id, "title": title}, ensure_ascii=False).encode(),
        artifact_id=f"kanban-seed:{feature_id}",
    )


def _seed(database: Database, feature_id: str) -> dict[str, str] | None:
    try:
        stored = database.latest_artifact(f"kanban-seed:{feature_id}")
    except KeyError:
        return None
    document = json.loads(stored["content"])
    return {"source_id": str(document["source_id"]), "title": str(document["title"])}


def sync_feature(
    database: Database,
    feature_id: str,
    stage: str,
    *,
    title: str | None = None,
    run_id: str | None = None,
    pr_number: int | None = None,
) -> dict[str, Any]:
    """Mirror one milestone after it is durable; a board failure never reverses it."""
    feature = database.get_feature(feature_id)
    project = database.get_project(feature["project_id"])
    document = project.get("profile") or {}
    kanban_document = document.get("integrations", {}).get("kanban", {})
    if not kanban_document.get("enabled"):
        return {"status": "skipped", "stage": stage}
    try:
        config = KanbanConfig.model_validate_json(json.dumps(kanban_document))
        if config.read_only:
            return {"status": "skipped", "stage": stage}
        seed = _seed(database, feature_id)
        card_title = title or (seed["title"] if seed else feature["title"])
        plan = plan_projection(
            config,
            KanbanCard(
                feature_id=feature_id,
                title=card_title,
                state=stage,
                run_id=run_id,
                source_id=seed["source_id"] if seed else None,
                pr_number=pr_number,
            ),
        )
        result = apply_projection(config, plan)
        payload: dict[str, Any] = {
            "status": result.status,
            "stage": stage,
            "board_path": result.board_path,
            "sha256": result.sha256,
            "backup_path": result.backup_path,
        }
        event = "kanban.synced"
    except (CohorteError, OSError, UnicodeError, ValueError) as error:
        payload = {"status": "error", "stage": stage, "message": str(error)}
        event = "kanban.sync_failed"
        warnings.warn(
            f"Obsidian Kanban: {error}; run cohorte kanban-sync {feature_id} to retry",
            stacklevel=2,
        )
    database.append_event(
        event,
        payload,
        project_id=feature["project_id"],
        run_id=run_id,
    )
    return payload


def stage_for_run(state: RunState) -> str | None:
    if state.status == RunStatus.FAILED:
        return "fix"
    if state.stage in {Stage.PLAN, Stage.BUILD, Stage.CHECKS}:
        return "building"
    if state.stage == Stage.REVIEW:
        return "review"
    if state.stage == Stage.FIX:
        return "fix"
    if state.stage == Stage.SHIP:
        return "ship"
    if state.stage == Stage.DONE and state.status == RunStatus.COMPLETED:
        return "shipped"
    return None


def stage_for_feature(
    database: Database, feature_id: str
) -> tuple[str | None, str | None, int | None]:
    """Derive the board stage from durable Cohorte state for reconciliation."""
    feature = database.get_feature(feature_id)
    for run in database.list_runs(feature["project_id"]):
        if run.feature_id != feature_id:
            continue
        stage = stage_for_run(run)
        pr_number = None
        if stage == "shipped":
            try:
                delivery = database.latest_event(run.id, "delivery.confirmed")["data"]
                identifier = str(delivery["pr_id"])
                if identifier.isdigit():
                    pr_number = int(identifier)
            except (KeyError, TypeError, ValueError):
                pass
        return stage, run.id, pr_number
    if feature["status"] == "frozen":
        return "ready", None, None
    for artifact_id, stage in (
        (f"draft:{feature_id}", "spec"),
        (f"brief:{feature_id}", "brainstorm"),
    ):
        try:
            database.latest_artifact(artifact_id)
        except KeyError:
            continue
        return stage, None, None
    return None, None, None


def sync_run(
    database: Database, state: RunState, *, pr_number: int | None = None
) -> dict[str, Any]:
    stage = stage_for_run(state)
    if stage is None:
        return {"status": "skipped", "stage": None}
    try:
        return sync_feature(
            database,
            state.feature_id,
            stage,
            run_id=state.id,
            pr_number=pr_number,
        )
    except KeyError:
        return {"status": "skipped", "stage": stage}
