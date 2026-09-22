from __future__ import annotations

import hashlib
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from cohorte import __version__
from cohorte.application.discovery import discover_project, profile_provenance
from cohorte.application.intake import IntakeSourceType, classify_intake
from cohorte.domain.models import EventType, RunState, RunStatus, Stage, WorkflowEvent, reduce_run
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

    def init_project(self, path: Path, language: str = "fr") -> dict[str, object]:
        profile, questions = discover_project(path, language)
        document = profile.model_dump_json(indent=2).encode()
        artifact = self.database.put_artifact("project-profile", document)
        self.database.register_project(profile.project_id, str(path.resolve()), artifact["id"])
        return {
            "profile": profile.model_dump(mode="json"),
            "profile_ref": artifact,
            "questions": questions,
            "provenance": profile_provenance(path),
        }

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
        artifact = self.database.put_artifact("intake-source", source.encode(), "text/plain")
        report_artifact = self.database.put_artifact(
            "intake-report", report.model_dump_json(indent=2).encode()
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
