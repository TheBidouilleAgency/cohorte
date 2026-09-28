"""Human-facing, read-only views over the durable run journal."""

from __future__ import annotations

import re
import shlex
import sqlite3
import sys
import threading
import time
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import Any

from cohorte.domain.models import RunState
from cohorte.domain.redaction import redact
from cohorte.persistence.sqlite import Database

_STAGES = {
    "build": "Construction",
    "checks": "Vérifications",
    "review": "Revue",
    "fix": "Corrections",
    "ship": "Livraison à approuver",
    "done": "Terminé",
}
_STATUSES = {
    "queued": "en attente",
    "running": "en cours",
    "waiting_user": "en attente de votre décision",
    "waiting_auth": "authentification requise",
    "waiting_quota": "quota atteint",
    "paused": "en pause",
    "blocked": "bloqué",
    "blocked_uncertain": "bloqué, effet incertain",
    "failed": "en échec",
    "cancelled": "annulé",
    "completed": "terminé",
}
_EVENTS = {
    "run.created": "Run créé",
    "run.resumed": "Run repris",
    "run.failed": "Run en échec",
    "run.blocked": "Run bloqué",
    "run.waiting_auth": "Authentification requise",
    "run.waiting_quota": "Quota atteint",
    "run.suspended": "Run suspendu",
    "run.effect_uncertain": "Effet incertain",
    "phase.build.completed": "Construction terminée",
    "phase.checks.completed": "Vérifications terminées",
    "phase.review.completed": "Revue terminée",
    "phase.fix.completed": "Corrections terminées",
    "delivery.confirmed": "Livraison confirmée",
}


def _time(value: str) -> str:
    return value[11:19] if len(value) >= 19 else value


def _safe(value: str) -> str:
    return re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value)


def event_line(event: dict[str, Any]) -> str | None:
    event_type = str(event["type"])
    label = _EVENTS.get(event_type)
    data = redact(event.get("data", {}))
    if label is None and event_type in {"agent.turn.started", "agent.turn.finished"}:
        if not isinstance(data, dict):
            data = {}
        provider = _safe(str(data.get("provider", "Agent")))
        phase = _safe(str(data.get("phase", "")))
        action = "démarre" if event_type.endswith("started") else "termine"
        label = f"{provider} {action}" + (f" · {phase}" if phase else "")
    if label is None:
        return None
    detail = ""
    if isinstance(data, dict) and event_type == "phase.checks.completed":
        detail = " · réussies" if data.get("passed") is True else " · à corriger"
    elif isinstance(data, dict) and event_type == "phase.review.completed":
        detail = " · prête" if data.get("ready") is True else " · corrections nécessaires"
    if isinstance(data, dict) and event_type.startswith("run."):
        message = data.get("message")
        if isinstance(message, str) and message:
            detail = f" · {_safe(message.splitlines()[0][:160])}"
    return f"  {_time(str(event['occurred_at']))} · {label}{detail}"


def run_events(database: Database, run_id: str) -> list[dict[str, Any]]:
    # Keep pagination explicit so an old, busy run is not silently truncated.
    events: list[dict[str, Any]] = []
    cursor = 0
    while True:
        page = database.events_after(cursor, run_id=run_id, limit=1000)
        if not page:
            break
        events.extend(page)
        cursor = int(page[-1]["seq"])
    return events


def print_run(
    state: RunState, events: list[dict[str, Any]], ship_request_id: str | None = None
) -> None:
    print(f"Run {state.id}")
    print(f"Projet : {state.project_id} · fonctionnalité : {state.feature_id}")
    print(
        f"Dernier état enregistré : {_STAGES.get(state.stage.value, state.stage.value)} · "
        f"{_STATUSES.get(state.status.value, state.status.value)}"
    )
    print(f"Créé : {state.created_at.isoformat()} · actualisé : {state.updated_at.isoformat()}")
    lines = [line for event in events if (line := event_line(event)) is not None]
    if lines:
        print("Déroulement :")
        print("\n".join(lines))
    if state.status.value == "completed" and state.stage.value == "done":
        latest_delivery = next(
            (
                event.get("data", {})
                for event in reversed(events)
                if event.get("type") in {"delivery.status", "delivery.confirmed"}
            ),
            None,
        )
        if isinstance(latest_delivery, dict):
            ci_status = str(latest_delivery.get("status", "ci_unknown"))
            ci_label = {
                "ci_unknown": "inconnu",
                "ci_pending": "en cours",
                "ci_passed": "checks visibles réussis",
                "ci_failed": "checks en échec ou annulés",
            }.get(ci_status, _safe(ci_status))
            print(f"CI (dernier état enregistré) : {ci_label}")
            if ci_status in {"ci_unknown", "ci_pending"}:
                print(
                    f"Actualiser : cohorte delivery-status {shlex.quote(state.id)} --live --watch"
                )
    if state.status.value == "waiting_user" and state.stage.value == "ship":
        if ship_request_id:
            print(f"Pour livrer : cohorte approve {ship_request_id}")
            print(f"Puis : cohorte ship {state.id} --live")
        else:
            print("Livraison en attente ; consulter les décisions avec cohorte status")
    elif state.status.value in {"failed", "paused", "waiting_auth", "waiting_quota"}:
        print(f"Reprendre après correction : cohorte resume {state.id} --live")


def run_summary_line(state: RunState) -> str:
    stage = _STAGES.get(state.stage.value, state.stage.value)
    status = _STATUSES.get(state.status.value, state.status.value)
    return f"{state.id} · {stage} · {status} · {state.updated_at:%Y-%m-%d %H:%M}"


def print_result(result: dict[str, Any]) -> None:
    print(f"Run {result['run_id']} · exécution terminée")
    changed = result.get("changed_files", [])
    print(f"Fichiers modifiés : {len(changed)}")
    for path in changed[:10]:
        print(f"  {path}")
    if len(changed) > 10:
        print(f"  … et {len(changed) - 10} autre(s)")
    for check in result.get("checks", []):
        check_status = {"passed": "réussi", "failed": "en échec"}.get(
            str(check["status"]), str(check["status"])
        )
        print(f"  Check {check['check_id']} · {check_status}")
    review = result.get("review", {})
    verdict = str(review.get("verdict", "indisponible"))
    review_label = {"ready": "prête", "blocked": "bloquée"}.get(verdict, verdict)
    print(f"Revue : {review_label}")
    if result.get("worktree"):
        print(f"Worktree : {result['worktree']}")
    request_id = result.get("ship_request_id")
    if request_id:
        print(f"Livraison en attente · demande {request_id}")
        print(f"Pour livrer : cohorte approve {request_id}")
        print(f"Puis : cohorte ship {result['run_id']} --live")


class RunProgress:
    """Show journal milestones and an honest heartbeat while a CLI run blocks."""

    def __init__(self, path: Path, run_id: str, *, enabled: bool) -> None:
        self.path = path
        self.run_id = run_id
        self.enabled = enabled
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> RunProgress:
        if self.enabled:
            print(
                f"Run {self.run_id} démarré. Suivi : cohorte run show {self.run_id}",
                file=sys.stderr,
            )
            self._thread = threading.Thread(target=self._follow, daemon=True)
            self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            # Progress is advisory; it must never mask a workflow result.
            with suppress(KeyError, OSError, sqlite3.Error):
                self._read_once(final=True)

    def _read_once(self, *, final: bool = False) -> None:
        # A fresh connection works across worker threads and sees committed events.
        database = Database(self.path)
        try:
            events = database.events_after(getattr(self, "_cursor", 0), run_id=self.run_id)
            for event in events:
                seq = int(event["seq"])
                self._cursor = seq
                line = event_line(event)
                if line:
                    print(line.strip(), file=sys.stderr, flush=True)
                    self._last_visible = time.monotonic()
            if not final and time.monotonic() - getattr(self, "_last_visible", 0.0) >= 15:
                state = database.get_run(self.run_id)
                elapsed = int(
                    (datetime.now(state.created_at.tzinfo) - state.created_at).total_seconds()
                )
                print(
                    f"Toujours en cours · {_STAGES.get(state.stage.value, state.stage.value)} · {elapsed}s",
                    file=sys.stderr,
                    flush=True,
                )
                self._last_visible = time.monotonic()
        finally:
            database.close()

    def _follow(self) -> None:
        self._last_visible = time.monotonic()
        while not self._stop.wait(2):
            try:
                self._read_once()
            except (KeyError, OSError, sqlite3.Error):
                # The run may not have been created yet. The next poll will retry.
                continue
