from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from typing import Literal

from cohorte.domain.models import RunState, StrictModel
from cohorte.persistence.sqlite import Database


class MetricValue(StrictModel):
    name: str
    unit: str
    value: int | float | None
    availability: Literal["available", "unavailable", "partial"]
    source: str


class MetricGroup(StrictModel):
    key: str
    outcomes: dict[str, int]
    values: list[MetricValue]


class MetricsReport(StrictModel):
    schema_version: Literal[1] = 1
    project_id: str | None
    since: datetime
    until: datetime
    group_by: Literal["project", "run", "phase", "provider"]
    outcomes: dict[str, int]
    values: list[MetricValue]
    groups: list[MetricGroup]
    generated_at: datetime


def _usage_metric(events: list[dict[str, object]], field: str) -> MetricValue:
    present: list[float] = []
    for event in events:
        value = event.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            present.append(float(value))
    if not present:
        return MetricValue(
            name=field,
            unit="tokens" if "tokens" in field else "currency_estimate",
            value=None,
            availability="unavailable",
            source="provider events did not expose this field",
        )
    return MetricValue(
        name=field,
        unit="tokens" if "tokens" in field else "currency_estimate",
        value=sum(present),
        availability="available" if len(present) == len(events) else "partial",
        source="agent.usage events",
    )


def _run_values(
    runs: list[RunState], approvals: int, usage: list[dict[str, object]]
) -> list[MetricValue]:
    durations = [
        (run.updated_at - run.created_at).total_seconds()
        for run in runs
        if run.updated_at >= run.created_at
    ]
    values = [
        MetricValue(
            name="runs", unit="count", value=len(runs), availability="available", source="runs"
        ),
        MetricValue(
            name="mean_run_duration",
            unit="seconds",
            value=(sum(durations) / len(durations)) if durations else None,
            availability="available" if durations else "unavailable",
            source="run timestamps",
        ),
        MetricValue(
            name="human_interventions",
            unit="count",
            value=approvals,
            availability="available",
            source="approvals",
        ),
        MetricValue(
            name="fix_cycles",
            unit="count",
            value=sum(run.fix_cycles for run in runs),
            availability="available",
            source="run states",
        ),
    ]
    for field in ("input_tokens", "output_tokens", "cache_tokens", "estimated_cost"):
        values.append(_usage_metric(usage, field))
    return values


def _usage_values(events: list[dict[str, object]], count_name: str) -> list[MetricValue]:
    values = [
        MetricValue(
            name=count_name,
            unit="count",
            value=len(events),
            availability="available",
            source="durable events",
        )
    ]
    for field in ("input_tokens", "output_tokens", "cache_tokens", "estimated_cost"):
        values.append(_usage_metric(events, field))
    return values


def metrics_report(
    database: Database,
    *,
    project_id: str | None,
    since: datetime,
    until: datetime,
    group_by: Literal["project", "run", "phase", "provider"] = "project",
) -> MetricsReport:
    if since.tzinfo is None or until.tzinfo is None:
        raise ValueError("metrics bounds must be timezone-aware")
    if since >= until:
        raise ValueError("metrics since must be before until")
    source = database.metrics_source(project_id, since, until)
    runs = [RunState.model_validate_json(json.dumps(run)) for run in source["runs"]]
    outcomes = Counter(run.status.value for run in runs)
    usage = source["usage_events"]
    values = _run_values(runs, source["approvals"], usage)
    groups: list[MetricGroup] = []
    if group_by == "project":
        groups.append(
            MetricGroup(
                key=project_id or "all-projects",
                outcomes=dict(sorted(outcomes.items())),
                values=values,
            )
        )
    elif group_by == "run":
        approvals_by_run = source["approvals_by_run"]
        for run in runs:
            run_usage = [event for event in usage if event.get("run_id") == run.id]
            groups.append(
                MetricGroup(
                    key=run.id,
                    outcomes={run.status.value: 1},
                    values=_run_values([run], int(approvals_by_run.get(run.id, 0)), run_usage),
                )
            )
    elif group_by == "provider":
        by_provider: dict[str, list[dict[str, object]]] = {}
        for event in usage:
            provider = event.get("provider")
            key = provider if isinstance(provider, str) and provider else "unavailable"
            by_provider.setdefault(key, []).append(event)
        if not by_provider:
            by_provider["unavailable"] = []
        groups = [
            MetricGroup(key=key, outcomes={}, values=_usage_values(events, "usage_events"))
            for key, events in sorted(by_provider.items())
        ]
    else:
        phase_events = source["phase_events"]
        by_phase: dict[str, list[dict[str, object]]] = {}
        for event in phase_events:
            event_type = event.get("event_type")
            key = (
                event_type.removeprefix("phase.").removesuffix(".completed")
                if isinstance(event_type, str)
                else "unavailable"
            )
            by_phase.setdefault(key, []).append(event)
        for event in usage:
            phase = event.get("phase")
            if isinstance(phase, str) and phase:
                by_phase.setdefault(phase, []).append(event)
        if not by_phase:
            by_phase["unavailable"] = []
        groups = [
            MetricGroup(key=key, outcomes={}, values=_usage_values(events, "events"))
            for key, events in sorted(by_phase.items())
        ]
    return MetricsReport(
        project_id=project_id,
        since=since,
        until=until,
        group_by=group_by,
        outcomes=dict(sorted(outcomes.items())),
        values=values,
        groups=groups,
        generated_at=datetime.now(UTC),
    )
