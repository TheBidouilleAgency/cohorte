from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from cohorte import __version__
from cohorte.application.discovery import (
    discover_project,
    discovery_report,
    profile_provenance,
    reconcile_profile,
)
from cohorte.application.intake import IntakeSourceType, classify_intake
from cohorte.domain.models import (
    EventType,
    ProjectProfile,
    RunState,
    RunStatus,
    Stage,
    WorkflowEvent,
    reduce_run,
)
from cohorte.persistence.sqlite import Database


class CohorteService:
    def __init__(self, database: Database) -> None:
        self.database = database
        self.started_at = datetime.now(UTC)

    def health(self) -> dict[str, object]:
        return {
            "version": __version__,
            "database": self.database.health(),
            "uptime_seconds": int((datetime.now(UTC) - self.started_at).total_seconds()),
            "compatibility": {"protocol_major": 1, "protocol_minor": 0},
        }

    def init_project(
        self, path: Path, language: str = "fr", *, refresh: bool = False
    ) -> dict[str, object]:
        path = path.resolve(strict=True)
        profile, questions = discover_project(path, language)
        analysis = discovery_report(profile, questions)
        try:
            existing = self.database.get_project(profile.project_id)
        except KeyError:
            existing = None
        if existing is not None:
            if Path(existing["root_path"]).resolve() != path:
                raise ValueError(
                    f"project {profile.project_id} is already registered at another path"
                )
            if not refresh:
                return {
                    "profile": existing["profile"],
                    "profile_ref": existing["profile_ref"],
                    "questions": questions,
                    "provenance": profile_provenance(path),
                    "analysis": analysis,
                    "existing": True,
                }
            current = ProjectProfile.model_validate_json(json.dumps(existing["profile"]))
            profile = reconcile_profile(current, profile)
            analysis = discovery_report(profile, questions)
            artifact = self.database.update_project_profile(
                profile.project_id,
                profile.model_dump_json(indent=2).encode(),
                existing["profile_ref"]["revision"],
            )
            return {
                "profile": profile.model_dump(mode="json"),
                "profile_ref": artifact,
                "questions": questions,
                "provenance": profile_provenance(path),
                "analysis": analysis,
                "refreshed": True,
            }
        document = profile.model_dump_json(indent=2).encode()
        artifact = self.database.put_artifact("project-profile", document)
        self.database.register_project(profile.project_id, str(path.resolve()), artifact["id"])
        return {
            "profile": profile.model_dump(mode="json"),
            "profile_ref": artifact,
            "questions": questions,
            "provenance": profile_provenance(path),
            "analysis": analysis,
        }

    def save_project_profile(
        self, project_id: str, document: dict[str, object], expected_revision: int
    ) -> dict[str, object]:
        project = self.database.get_project(project_id)
        if project["profile_ref"]["revision"] != expected_revision:
            raise ValueError("profile revision changed; reload the profile before editing")
        profile = ProjectProfile.model_validate_json(json.dumps(document))
        if profile.project_id != project_id:
            raise ValueError("profile project_id cannot be changed")
        if profile.revision != expected_revision:
            raise ValueError("profile revision must match the version being edited")
        updated = profile.model_copy(update={"revision": expected_revision + 1})
        content = (
            json.dumps(updated.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n"
        ).encode()
        artifact = self.database.update_project_profile(project_id, content, expected_revision)
        return {"profile": updated.model_dump(mode="json"), "profile_ref": artifact}

    def intake(
        self,
        project_id: str,
        source: str,
        title: str | None = None,
        *,
        source_type: IntakeSourceType = IntakeSourceType.TEXT,
        locator: str = "inline:text",
    ) -> dict[str, object]:
        report = classify_intake(source, source_type, locator, title)
        feature_id = f"intake-{hashlib.sha256(source.encode()).hexdigest()[:12]}"
        try:
            existing = self.database.get_feature(feature_id)
        except KeyError:
            existing = None
        if existing is not None:
            if existing["project_id"] != project_id:
                raise ValueError("intake source is already registered in another project")
            stored = self.database.latest_intake_report(feature_id)
            stored_report = json.loads(stored["content"])
            if stored_report["source_sha256"] != report.source_sha256:
                raise ValueError("intake source ID collision")
            artifact = self.database.put_artifact("intake-source", source.encode(), "text/plain")
            return {
                "feature_id": feature_id,
                "source_ref": artifact,
                "report_ref": {key: stored[key] for key in ("id", "revision", "sha256")},
                "report": stored_report,
            }
        artifact = self.database.put_artifact("intake-source", source.encode(), "text/plain")
        report_artifact = self.database.put_artifact(
            "intake-report",
            report.model_dump_json(indent=2).encode(),
            artifact_id=f"intake:{feature_id}",
        )
        self.database.ensure_feature(feature_id, project_id, report.title, kind=report.triage.value)
        return {
            "feature_id": feature_id,
            "source_ref": artifact,
            "report_ref": report_artifact,
            "report": report.model_dump(mode="json"),
        }

    def start_run(
        self, project_id: str, feature_id: str, base_commit: str, stage: Stage = Stage.PLAN
    ) -> RunState:
        now = datetime.now(UTC)
        state = RunState(
            id=str(uuid4()),
            project_id=project_id,
            feature_id=feature_id,
            stage=stage,
            status=RunStatus.QUEUED,
            state_version=1,
            base_commit=base_commit,
            created_at=now,
            updated_at=now,
        )
        self.database.create_run(state)
        return state

    def transition(
        self, run_id: str, event: WorkflowEvent
    ) -> tuple[RunState, list[dict[str, object]]]:
        current = self.database.get_run(run_id)
        updated, intents = reduce_run(current, event, datetime.now(UTC))
        self.database.update_run(
            updated,
            current.state_version,
            "run.state_changed",
            {
                "from": {"stage": current.stage.value, "status": current.status.value},
                "to": {"stage": updated.stage.value, "status": updated.status.value},
                "cause": event.type.value,
            },
        )
        return updated, [intent.model_dump(mode="json") for intent in intents]

    def pause(self, run_id: str, reason: str = "") -> RunState:
        return self.transition(
            run_id, WorkflowEvent(type=EventType.PAUSE, facts={"reason": reason})
        )[0]

    def resume(self, run_id: str) -> RunState:
        return self.transition(run_id, WorkflowEvent(type=EventType.RESUME))[0]

    def cancel(self, run_id: str, reason: str = "") -> RunState:
        return self.transition(
            run_id, WorkflowEvent(type=EventType.CANCEL, facts={"reason": reason})
        )[0]

    def export_run(self, run_id: str, max_bytes: int = 10 * 1024 * 1024) -> dict[str, object]:
        return self.database.export_run(run_id, max_bytes)


def git_head(path: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )
    if result.returncode != 0:
        raise ValueError("project is not a Git checkout with a commit")
    return result.stdout.strip()
