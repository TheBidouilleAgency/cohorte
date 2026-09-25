from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, NoReturn, cast

from platformdirs import user_config_path, user_data_path
from pydantic import BaseModel, ValidationError

from cohorte import __version__
from cohorte.adapters.claude import ClaudeAdapter
from cohorte.adapters.codex import CodexAdapter
from cohorte.adapters.git import GitRepository
from cohorte.adapters.hosting import GitHubProvider, GitLabProvider
from cohorte.adapters.native_login import native_login
from cohorte.adapters.providers import inspect_runtime, workflow_runtime
from cohorte.application.delivery import ShipRunner, render_release_notes
from cohorte.application.durable import (
    RunStopped,
    SqliteAgentEventSink,
    SqliteRunJournal,
    SqliteTaskJournal,
    record_run_error,
)
from cohorte.application.fleet import FleetRunner
from cohorte.application.multisurface import MultiSurfaceRunner
from cohorte.application.service import CohorteService
from cohorte.application.vertical import VerticalRunner
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.redaction import redact
from cohorte.execution.checks import CheckRunner
from cohorte.persistence.sqlite import Database
from cohorte.protocol.rpc import MAX_FRAME_BYTES, RpcServer


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cohorte", description="Local coding-agent workflow engine"
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--json", action="store_true", help="emit one structured JSON response")
    parser.add_argument("--config-dir", type=Path, default=user_config_path("cohorte"))
    parser.add_argument("--data-dir", type=Path, default=user_data_path("cohorte"))
    sub = parser.add_subparsers(dest="command", required=True)
    doctor = sub.add_parser("doctor")
    doctor.add_argument("--repo", type=Path, default=Path.cwd())
    doctor.add_argument("--project-id")
    update_pipeline = sub.add_parser(
        "update-pipeline", help="preview or apply profile reconciliation"
    )
    update_pipeline.add_argument("--repo", type=Path, default=Path.cwd())
    update_pipeline.add_argument("--apply", action="store_true")
    wrappers = sub.add_parser("wrappers", help="preview or install optional host-client shortcuts")
    wrappers.add_argument("--runtime", action="append", required=True)
    wrappers.add_argument("--repo", type=Path, default=Path.cwd())
    wrappers.add_argument("--apply", action="store_true")
    init = sub.add_parser("init")
    init.add_argument("path", type=Path, nargs="?", default=Path.cwd())
    init.add_argument("--language", default="fr")
    init.add_argument(
        "--preview", action="store_true", help="inspect the detected profile without registering it"
    )
    init.add_argument(
        "--refresh", action="store_true", help="replace the stored profile with a new discovery"
    )
    init.add_argument(
        "--profile-file", type=Path, help="register an explicitly reviewed profile JSON"
    )
    profile = sub.add_parser("profile")
    profile_sub = profile.add_subparsers(dest="profile_command", required=True)
    for action in ("show", "edit", "apply"):
        child = profile_sub.add_parser(action)
        if action == "apply":
            child.add_argument("file", type=Path)
            child.add_argument("--project-id")
        else:
            child.add_argument("project_id", nargs="?")
    status = sub.add_parser("status")
    status.add_argument("run", nargs="?")
    specs_board = sub.add_parser("specs", help="list project feature specifications")
    specs_board.add_argument("--project-id")
    specs_board.add_argument("--status")
    brief = sub.add_parser("brief", help="read a stored brainstorm brief")
    brief_sub = brief.add_subparsers(dest="brief_command", required=True)
    brief_show = brief_sub.add_parser("show", help="show the latest brief for a feature")
    brief_show.add_argument("feature_id")
    export = sub.add_parser("export")
    export.add_argument("run_id")
    export.add_argument("--output", type=Path)
    export.add_argument("--max-bytes", type=int, default=10 * 1024 * 1024)
    auth = sub.add_parser("auth")
    auth_sub = auth.add_subparsers(dest="auth_command", required=True)
    auth_status = auth_sub.add_parser("status")
    auth_status.add_argument("provider", choices=["claude", "codex"], nargs="?")
    for name in ["login", "verify", "logout", "disconnect"]:
        child = auth_sub.add_parser(name)
        child.add_argument("target", choices=["claude", "codex"])
        if name == "verify":
            child.add_argument("--live", action="store_true")
            child.add_argument("--full", action="store_true")
    rpc = sub.add_parser("rpc")
    rpc.add_argument("--stdio", action="store_true", required=True)
    service_command = sub.add_parser("service")
    service_command.add_argument("action", choices=["start", "status", "stop"])
    checks = sub.add_parser("check")
    checks.add_argument("profile", type=Path)
    checks.add_argument("check_id")
    schemas = sub.add_parser("schemas")
    schemas.add_argument("output", type=Path)
    loop = sub.add_parser("loop")
    loop.add_argument("spec", type=Path)
    loop.add_argument("--profile", type=Path, required=True)
    loop.add_argument("--repo", type=Path, default=Path.cwd())
    loop.add_argument("--worktrees", type=Path, required=True)
    loop.add_argument("--existing-worktree", type=Path)
    loop.add_argument("--run-id", required=True)
    loop.add_argument("--live", action="store_true", required=True)
    fleet = sub.add_parser("fleet")
    fleet.add_argument("specs", type=Path, nargs="+")
    fleet.add_argument("--profile", type=Path, required=True)
    fleet.add_argument("--repo", type=Path, default=Path.cwd())
    fleet.add_argument("--worktrees", type=Path, required=True)
    fleet.add_argument("--fleet-id", required=True)
    fleet.add_argument("--live", action="store_true", required=True)
    fleet_plan = sub.add_parser("fleet-plan", help="provision supervised feature worktrees")
    fleet_plan.add_argument("specs", type=Path, nargs="+")
    fleet_plan.add_argument("--profile", type=Path, required=True)
    fleet_plan.add_argument("--repo", type=Path, default=Path.cwd())
    fleet_plan.add_argument("--worktrees", type=Path, required=True)
    fleet_plan.add_argument("--fleet-id", required=True)
    fleet_plan.add_argument("--apply", action="store_true", help="provision the reviewed plan")
    fleet_status = sub.add_parser("fleet-status", help="inspect a supervised fleet")
    fleet_status.add_argument("fleet_id")
    fleet_status.add_argument("--project-id", required=True)
    fleet_status.add_argument("--no-fetch", action="store_true")
    fleet_sync = sub.add_parser("fleet-sync", help="synchronize after a feature merge")
    fleet_sync.add_argument("fleet_id")
    fleet_sync.add_argument("--project-id", required=True)
    fleet_sync.add_argument("--merged", required=True)
    fleet_sync.add_argument("--apply", action="store_true")
    intake = sub.add_parser("intake")
    intake.add_argument("project_id", nargs="?")
    intake_source = intake.add_mutually_exclusive_group()
    intake_source.add_argument("--text")
    intake_source.add_argument("--file", type=Path)
    intake_source.add_argument("--url")
    intake.add_argument("--title")
    intake.add_argument("--continue", dest="continue_feature_id", metavar="FEATURE_ID")
    intake.add_argument("--answer", action="append", default=[], metavar="N=RÉPONSE")
    intake.add_argument("--route", choices=["feature", "patch"])
    intake.add_argument("--manual", action="store_true", help="skip read-only agent triage")
    brainstorm = sub.add_parser("brainstorm")
    brainstorm.add_argument("project_id", nargs="?")
    brainstorm.add_argument("--feature-id")
    brainstorm.add_argument("--from-intake", metavar="FEATURE_ID")
    brainstorm.add_argument(
        "--continue",
        dest="continue_feature_id",
        metavar="FEATURE_ID",
        help="answer open questions and continue a stored brainstorm",
    )
    brainstorm.add_argument("--idea")
    brainstorm.add_argument("--context", default="")
    brainstorm.add_argument("--answer", action="append", default=[])
    brainstorm.add_argument("--prior-decision", action="append", default=[])
    brainstorm.add_argument("--perspective", action="append")
    brainstorm.add_argument("--repo", type=Path, default=Path.cwd())
    brainstorm.add_argument("--provider", choices=["claude", "codex"])
    brainstorm.add_argument("--output", type=Path)
    brainstorm.add_argument("--live", action="store_true")
    guided_spec = sub.add_parser("spec", help="guide a stored brief through exact spec approval")
    guided_spec.add_argument("feature_id", nargs="?")
    guided_spec.add_argument("--refresh", action="store_true", help="replace a saved draft")
    guided_spec.add_argument(
        "--manual", action="store_true", help="skip the agent's draft proposal"
    )
    guided_start = sub.add_parser("start", help="run a guided, frozen feature")
    guided_start.add_argument("feature_id", nargs="?")
    freeze_request = sub.add_parser("spec-freeze-request")
    freeze_request.add_argument("draft", type=Path)
    freeze_request.add_argument("--profile", type=Path, required=True)
    freeze_request.add_argument("--repo", type=Path, default=Path.cwd())
    freeze = sub.add_parser("spec-freeze")
    freeze.add_argument("draft", type=Path)
    freeze.add_argument("--profile", type=Path, required=True)
    freeze.add_argument("--repo", type=Path, default=Path.cwd())
    freeze.add_argument("--decision-id", required=True)
    freeze.add_argument("--output", type=Path, required=True)
    patch_spec = sub.add_parser("patch-spec")
    patch_spec.add_argument("--from-intake", metavar="FEATURE_ID")
    patch_spec.add_argument("--source-artifact-id")
    patch_spec.add_argument("--source-revision", type=int)
    patch_spec.add_argument("--profile", type=Path)
    patch_spec.add_argument("--patch-id")
    patch_spec.add_argument("--title")
    patch_spec.add_argument("--reproduction")
    patch_spec.add_argument("--observed")
    patch_spec.add_argument("--expected")
    patch_spec.add_argument("--surface", action="append")
    patch_spec.add_argument("--write-path", action="append")
    patch_spec.add_argument("--check", action="append", default=[])
    patch_spec.add_argument("--manual-regression", action="store_true")
    patch_spec.add_argument("--manual", action="store_true", help="skip read-only agent diagnosis")
    patch_spec.add_argument("--in-scope", action="append")
    patch_spec.add_argument("--out-of-scope", action="append", default=[])
    patch_spec.add_argument("--rollback")
    patch_spec.add_argument("--output", type=Path)
    patch = sub.add_parser("patch")
    patch.add_argument("spec", type=Path)
    patch.add_argument("--profile", type=Path, required=True)
    patch.add_argument("--repo", type=Path, default=Path.cwd())
    patch.add_argument("--worktrees", type=Path, required=True)
    patch.add_argument("--run-id", required=True)
    patch.add_argument("--live", action="store_true", required=True)
    audit = sub.add_parser("audit")
    audit.add_argument("--profile", type=Path)
    audit.add_argument("--repo", type=Path, default=Path.cwd())
    audit.add_argument("--audit-id")
    audit.add_argument("--title")
    audit.add_argument("--surface", action="append")
    audit.add_argument("--path", action="append")
    audit.add_argument("--concern", action="append")
    audit.add_argument("--output", type=Path)
    audit.add_argument("--live", action="store_true")
    incoming_review = sub.add_parser("incoming-review")
    incoming_review.add_argument("number", type=int)
    incoming_review.add_argument("--profile", type=Path)
    incoming_review.add_argument("--repo", type=Path, default=Path.cwd())
    incoming_review.add_argument("--worktrees", type=Path)
    incoming_review.add_argument("--title")
    incoming_review.add_argument("--description")
    incoming_review.add_argument("--live", action="store_true")
    refactor = sub.add_parser("refactor")
    refactor.add_argument("selection", type=Path)
    refactor.add_argument("--profile", type=Path, required=True)
    refactor.add_argument("--repo", type=Path, default=Path.cwd())
    refactor.add_argument("--worktrees", type=Path, required=True)
    refactor.add_argument("--run-id", required=True)
    refactor.add_argument("--live", action="store_true", required=True)
    refactor_plan = sub.add_parser(
        "refactor-plan", help="select audit findings for a bounded refactor"
    )
    refactor_plan.add_argument("report", type=Path)
    refactor_plan.add_argument("--profile", type=Path)
    refactor_plan.add_argument("--repo", type=Path, default=Path.cwd())
    refactor_plan.add_argument("--finding", action="append", required=True)
    refactor_plan.add_argument("--invariant", action="append", required=True)
    refactor_plan.add_argument("--rollback", required=True)
    refactor_plan.add_argument("--output", type=Path)
    refactor_plan.add_argument("--approve", action="store_true")
    refactor_request = sub.add_parser("refactor-request")
    refactor_request.add_argument("selection", type=Path)
    retro = sub.add_parser("retro")
    retro.add_argument("reports", type=Path, nargs="*")
    retro.add_argument("--proposal-id")
    retro.add_argument("--rule")
    retro.add_argument("--output", type=Path)
    retro.add_argument("--pattern")
    retro.add_argument("--manual", action="store_true")
    retro.add_argument("--live", action="store_true")
    retro_apply = sub.add_parser("retro-apply")
    retro_apply.add_argument("proposal", type=Path)
    retro_apply.add_argument("--profile", type=Path, required=True)
    retro_apply.add_argument("--decision-id", required=True)
    retro_apply.add_argument("--output", type=Path, required=True)
    design_snapshot = sub.add_parser("design-snapshot")
    design_snapshot.add_argument("--profile", type=Path, required=True)
    design_snapshot.add_argument("--repo", type=Path, default=Path.cwd())
    design_snapshot.add_argument("--output", type=Path, required=True)
    retrieval = sub.add_parser("retrieve")
    retrieval.add_argument("query")
    retrieval.add_argument("--profile", type=Path, required=True)
    retrieval.add_argument("--repo", type=Path, default=Path.cwd())
    retrieval.add_argument("--limit", type=int, default=20)
    align_plan = sub.add_parser("align-ds-plan")
    align_plan.add_argument("--profile", type=Path, required=True)
    align_plan.add_argument("--repo", type=Path, default=Path.cwd())
    align_plan.add_argument("--output", type=Path, required=True)
    align_request = sub.add_parser("align-ds-request")
    align_request.add_argument("selection", type=Path)
    align = sub.add_parser("align-ds")
    align.add_argument("selection", type=Path)
    align.add_argument("--profile", type=Path, required=True)
    align.add_argument("--repo", type=Path, default=Path.cwd())
    align.add_argument("--worktrees", type=Path, required=True)
    align.add_argument("--run-id", required=True)
    align.add_argument("--live", action="store_true", required=True)
    kanban = sub.add_parser("kanban-project")
    kanban.add_argument("--profile", type=Path, required=True)
    kanban.add_argument("--feature-id", required=True)
    kanban.add_argument("--title", required=True)
    kanban.add_argument("--state", required=True)
    kanban.add_argument("--state-version", type=int, required=True)
    kanban.add_argument("--run-id")
    kanban.add_argument("--plan-only", action="store_true")
    metrics = sub.add_parser("metrics")
    metrics.add_argument("--project-id")
    metrics.add_argument("--days", type=int, default=30)
    metrics.add_argument(
        "--group-by",
        choices=["project", "run", "phase", "provider"],
        default="project",
    )
    migrate = sub.add_parser("migrate")
    migration_action = migrate.add_mutually_exclusive_group(required=True)
    migration_action.add_argument("--from-v2", type=Path)
    migration_action.add_argument("--apply", type=Path)
    migration_action.add_argument("--rollback", type=Path)
    migrate.add_argument("--plan", type=Path)
    migrate.add_argument("--backup-dir", type=Path)
    resume = sub.add_parser("resume")
    resume.add_argument("run_id")
    resume.add_argument("--live", action="store_true", required=True)
    pause = sub.add_parser("pause")
    pause.add_argument("run_id")
    pause.add_argument("--reason", default="")
    cancel = sub.add_parser("cancel")
    cancel.add_argument("run_id")
    cancel.add_argument("--reason", default="")
    for name in ["approve", "deny"]:
        decision = sub.add_parser(name)
        decision.add_argument("request_id")
        decision.add_argument("--response-id")
    ship = sub.add_parser("ship")
    ship.add_argument("run_id")
    ship.add_argument("--live", action="store_true", required=True)
    delivery_status = sub.add_parser("delivery-status")
    delivery_status.add_argument("run_id")
    delivery_status.add_argument("--live", action="store_true", required=True)
    delivery_status.add_argument("--watch", action="store_true")
    delivery_status.add_argument("--timeout", type=int, default=300)
    return parser


def _emit(payload: Any, json_mode: bool) -> None:
    if json_mode:
        print(json.dumps({"ok": True, "data": payload}, ensure_ascii=False, default=str))
    elif isinstance(payload, str):
        print(payload)
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))


def _fail(error: Exception, json_mode: bool, debug: bool = False) -> NoReturn:
    if isinstance(error, CohorteError):
        data = error.as_data()
        exit_code = 6 if error.code.value in {"EFFECT_UNCERTAIN", "VERSION_CONFLICT"} else 3
    elif isinstance(error, (ValueError, ValidationError)):
        data = {
            "code": "VALIDATION_ERROR",
            "message": str(error),
            "impact": "command was not applied",
            "retryable": False,
            "remediation": "correct the input and retry",
        }
        exit_code = 3
    else:
        data = {
            "code": "EXECUTION_ERROR",
            "message": str(error),
            "impact": "command failed",
            "retryable": False,
            "remediation": "run cohorte doctor; retry with diagnostics enabled",
        }
        exit_code = 5
    data = redact(data)
    if json_mode:
        print(json.dumps({"ok": False, "error": data}, ensure_ascii=False), file=sys.stdout)
    else:
        print(
            f"{data['code']}: {data['message']}\nImpact: {data['impact']}\nAction: {data['remediation']}",
            file=sys.stderr,
        )
    raise SystemExit(exit_code)


def _doctor(service: CohorteService, args: argparse.Namespace) -> dict[str, Any]:
    from cohorte.application.project_doctor import inspect_project
    from cohorte.domain.models import ProjectProfile

    claude = inspect_runtime("claude")
    codex = inspect_runtime("codex")
    try:
        project = (
            service.database.get_project(args.project_id)
            if args.project_id
            else _project_for_path(service.database, args.repo)
        )
    except (KeyError, ValueError):
        project = None
    project_health = (
        inspect_project(
            Path(project["root_path"]),
            ProjectProfile.model_validate_json(json.dumps(project["profile"])),
        )
        if project is not None
        else {"registered": False, "fix": "Run cohorte init . in this project."}
    )
    return {
        **service.health(),
        "python_required": ">=3.12",
        "data_dir": str(args.data_dir),
        "config_dir": str(args.config_dir),
        "providers": [asdict(claude), asdict(codex)],
        "project": project_health,
        "support_claim": "codex-bounded-live-align-local-integrations-migration-darwin-service-windows-ci-pipe",
        "next_validation": "Validate the external Francois client and Windows slow-client behavior, then complete the AC01-AC30 matrix.",
    }


def _emit_doctor_result(result: dict[str, Any], json_mode: bool) -> None:
    if json_mode:
        _emit(result, True)
        return
    database = result["database"]
    print(f"Cohorte {result['version']} · base {'OK' if database['ok'] else 'à corriger'}")
    for provider in result["providers"]:
        availability = provider["connection_state"]
        version = provider["runtime_version"] or "version inconnue"
        print(f"{provider['provider']} · {availability} · {version}")
    project = result["project"]
    if project.get("registered") is False:
        print(f"Projet : non initialisé · {project['fix']}")
        return
    print(
        f"Projet {project['project_id']} · {project['surfaces']} surfaces · "
        f"{project['checks']} checks · {'OK' if project['ok'] else 'à corriger'}"
    )
    for finding in project["findings"]:
        print(f"  {finding['code']} · {finding['message']}")
        print(f"  Action : {finding['fix']}")


def _schemas(output: Path) -> dict[str, Any]:
    from cohorte.application.alignment import AlignmentSelection
    from cohorte.application.context import (
        DesignAlignmentPlan,
        DesignCapture,
        RetrievalResult,
    )
    from cohorte.application.fleet import FleetPlan
    from cohorte.application.intake import IntakeReport
    from cohorte.application.kanban import KanbanProjectionPlan
    from cohorte.application.maintenance import (
        AuditReport,
        AuditSpec,
        RefactorSelection,
        RetroProposal,
    )
    from cohorte.application.metrics import MetricsReport
    from cohorte.application.migration import MigrationResult, V2MigrationPlan
    from cohorte.application.patch import PatchSpec
    from cohorte.application.preparation import (
        BrainstormBrief,
        BrainstormContribution,
        BrainstormSynthesis,
        FrozenSpecResult,
        SpecFreezePreparation,
    )
    from cohorte.domain.models import FeatureSpec, ProjectProfile, RunState, TaskPlan
    from cohorte.protocol.models import EventEnvelope, RpcRequest

    output.mkdir(parents=True, exist_ok=True)
    models: list[type[BaseModel]] = [
        ProjectProfile,
        FeatureSpec,
        TaskPlan,
        RunState,
        EventEnvelope,
        RpcRequest,
        FleetPlan,
        IntakeReport,
        PatchSpec,
        AuditSpec,
        AuditReport,
        RefactorSelection,
        RetroProposal,
        DesignCapture,
        RetrievalResult,
        DesignAlignmentPlan,
        AlignmentSelection,
        KanbanProjectionPlan,
        MetricsReport,
        V2MigrationPlan,
        MigrationResult,
        BrainstormContribution,
        BrainstormSynthesis,
        BrainstormBrief,
        SpecFreezePreparation,
        FrozenSpecResult,
    ]
    for model in models:
        path = output / f"{model.__name__}.schema.json"
        path.write_text(json.dumps(model.model_json_schema(), indent=2) + "\n")
    return {"written": [f"{model.__name__}.schema.json" for model in models]}


def _create_ship_request(database: Database, run_id: str, result: Any) -> str:
    payload = {
        "candidate_tree_hash": result.candidate_tree_hash,
        "branch": result.branch,
        "worktree": result.worktree,
    }
    stored = database.deduplicated(
        f"ship-request:{run_id}",
        payload,
        lambda: {
            "id": database.create_request(
                run_id,
                "ship",
                {"branch": result.branch, "worktree": result.worktree},
                result.candidate_tree_hash,
            )
        },
    )
    return cast(str, stored["id"])


def _project_for_path(database: Database, path: Path) -> dict[str, Any]:
    resolved = path.resolve(strict=True)
    matches = [
        item
        for item in database.list_projects()
        if resolved == Path(item["root_path"]).resolve()
        or resolved.is_relative_to(Path(item["root_path"]).resolve())
    ]
    if not matches:
        raise ValueError("no registered Cohorte project for this directory; run cohorte init .")
    return database.get_project(max(matches, key=lambda item: len(item["root_path"]))["id"])


def _prompt(label: str, *, required: bool = True) -> str:
    while True:
        answer = input(f"{label}: ").strip()
        if answer or not required:
            return answer
        print("Une réponse est nécessaire.", file=sys.stderr)


def _brainstorm_followup_answers(
    questions: list[str], proposals: list[Any] | None = None
) -> list[str]:
    answers: list[str] = []
    suggestions = {item.question: item for item in proposals or []}
    for index, question in enumerate(questions):
        suggestion = suggestions.get(question)
        if suggestion is None and proposals is not None and len(proposals) == len(questions):
            suggestion = proposals[index]
        if suggestion is not None:
            print(f"\n{question}")
            print(f"  Produit : {suggestion.business_option}")
            print(f"  Code : {suggestion.code_option}")
            print(f"  À vérifier : {suggestion.caveat}")
        while True:
            answer = _prompt(
                f"{question} (p = adopter la piste produit, c = piste code, Entrée = ouvert)",
                required=False,
            )
            lowered = answer.casefold()
            if lowered in {"p", "produit"} and suggestion is not None:
                answer = suggestion.business_option
            elif lowered in {"c", "code"} and suggestion is not None:
                answer = suggestion.code_option
            elif lowered in {"p", "c", "produit", "code"}:
                print("Aucune proposition disponible pour cette question.")
                continue
            if answer.endswith("?") or lowered in {"tu proposes quoi", "tu en penses quoi"}:
                if suggestion is None:
                    print(
                        "Le panel n'a pas proposé de réponse vérifiable ; la question reste ouverte."
                    )
                else:
                    print(f"Piste produit : {suggestion.business_option}")
                    print(f"Piste code : {suggestion.code_option}")
                continue
            break
        if answer:
            answers.append(f"{question} {answer}")
    extra = _prompt("Autre élément à ajouter (facultatif)", required=False)
    if extra:
        answers.append(extra)
    return answers


def _require_new_brainstorm_feature(database: Database, project_id: str, feature_id: str) -> None:
    try:
        feature = database.get_feature(feature_id)
    except KeyError:
        return
    if feature["project_id"] != project_id:
        raise ValueError(f"feature belongs to another project: {feature_id}")
    try:
        database.latest_artifact(f"brief:{feature_id}")
    except KeyError:
        return
    raise ValueError(f"brainstorm already exists; run cohorte brainstorm --continue {feature_id}")


def _profile_context(profile: dict[str, Any]) -> str:
    surfaces = profile.get("surfaces", [])
    summary = {
        "project": profile.get("name"),
        "description": profile.get("description", ""),
        "surfaces": [
            {
                "id": item.get("id"),
                "paths": item.get("paths"),
                "depends_on": item.get("depends_on", []),
            }
            for item in surfaces
        ],
        "checks": [item.get("id") for item in profile.get("checks", [])],
        "conventions": profile.get("conventions", []),
        "note": "This stored Cohorte profile defines the project boundaries. PIPELINE.md is not required for brainstorming.",
    }
    return json.dumps(summary, ensure_ascii=False)


def _edit_profile(document: dict[str, Any]) -> dict[str, Any]:
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR")
    if not editor:
        raise ValueError("set VISUAL or EDITOR to edit the profile")
    with tempfile.TemporaryDirectory(prefix="cohorte-profile-") as directory:
        path = Path(directory) / "profile.json"
        path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        command = [*shlex.split(editor), str(path)]
        if subprocess.run(command, check=False).returncode != 0:
            raise ValueError("profile editor exited with an error")
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError("profile must be a JSON object")
        return loaded


def _emit_profile_result(result: dict[str, Any], json_mode: bool) -> None:
    if json_mode:
        _emit(result, True)
        return
    profile = result["profile"]
    reference = result.get("profile_ref", {"revision": profile["revision"]})
    print(
        f"{'Brouillon' if result.get('preview') else 'Profil'} {profile['project_id']} · révision {reference['revision']} · "
        f"{len(profile['surfaces'])} surfaces · {len(profile['checks'])} checks"
    )
    analysis = result.get("analysis", {})
    if analysis:
        print("Analyse du dépôt :")
        for surface in analysis.get("surfaces", []):
            check_ids = ", ".join(item["id"] for item in surface["checks"]) or "aucun"
            print(
                f"  {surface['id']} · {', '.join(surface['paths'])} · "
                f"{surface['role_profile']} · checks : {check_ids}"
            )
        contract = analysis.get("contract", {})
        if contract.get("enabled"):
            print(f"Contrat détecté : {contract['mechanism']} · {', '.join(contract['paths'])}")
        for signal, label in (
            ("conventions", "Règles présentes"),
            ("design", "Design présent"),
            ("retrieval", "Retrieval configuré"),
            ("isolation", "Isolation possible"),
        ):
            sources = analysis.get("signals", {}).get(signal, [])
            if sources:
                print(f"{label} : {', '.join(sources)}")
        print(f"Panel brainstorm : {', '.join(analysis.get('brainstorm_panel', []))}")
    for question in result.get("questions", []):
        print(f"À confirmer : {question}")
    print("Voir le détail : cohorte profile show")
    print("Corriger le profil : cohorte profile edit")


def _configure_init_candidate(profile: Any, analysis: dict[str, Any], root: Path) -> Any:
    """Offer only detected integrations; a skipped choice keeps the safe default."""
    from cohorte.domain.models import ProjectProfile

    document = profile.model_dump(mode="json")
    signals = analysis.get("signals", {})
    retrieval_sources = signals.get("retrieval", [])
    if retrieval_sources:
        available = sorted(
            {
                provider
                for provider in ("serena", "graphify")
                if any(provider in item.casefold() for item in retrieval_sources)
            }
        )
        print(f"Retrieval détecté : {', '.join(retrieval_sources)}")
        selected = _prompt(
            f"Utiliser quel provider ? [{'/'.join([*available, 'files', 'none'])}; Entrée = inchangé]",
            required=False,
        ).casefold()
        if selected and selected not in {*available, "files", "none"}:
            raise ValueError("retrieval provider must match a detected server, files or none")
        if selected:
            document["integrations"]["retrieval"] = {
                "provider": selected,
                "fallback_to_files": selected in {"serena", "graphify"},
                "roots": ["."],
            }
    if signals.get("design"):
        print(f"Design détecté : {', '.join(signals['design'])}")
        source = _prompt(
            "Source design JSON relative ou URL Figma (Entrée = désactivé)", required=False
        ).strip()
        if source:
            if source.startswith(("https://www.figma.com/", "https://figma.com/")):
                provider = "figma"
            else:
                candidate = (root / source).resolve(strict=True)
                if (
                    not candidate.is_relative_to(root.resolve(strict=True))
                    or not candidate.is_file()
                ):
                    raise ValueError("design source must be a file inside the project")
                if candidate.stat().st_size > 2 * 1024 * 1024:
                    raise ValueError("design source exceeds 2 MiB")
                payload = json.loads(candidate.read_text(encoding="utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("design source must contain a JSON object")
                provider = "file"
            snapshot_path = _prompt(
                "Snapshot design JSON du dépôt (chemin relatif, obligatoire)", required=True
            ).strip()
            snapshot = (root / snapshot_path).resolve(strict=True)
            if not snapshot.is_relative_to(root.resolve(strict=True)) or not snapshot.is_file():
                raise ValueError("design snapshot must be a file inside the project")
            if snapshot.stat().st_size > 2 * 1024 * 1024:
                raise ValueError("design snapshot exceeds 2 MiB")
            if not isinstance(json.loads(snapshot.read_text(encoding="utf-8")), dict):
                raise ValueError("design snapshot must contain a JSON object")
            document["integrations"]["design"] = {
                "enabled": True,
                "provider": provider,
                "source": source,
                "snapshot_path": snapshot_path,
            }
    return ProjectProfile.model_validate_json(json.dumps(document))


def _emit_supervised_fleet(
    command: str, result: dict[str, Any], json_mode: bool, data_dir: Path
) -> None:
    if json_mode:
        _emit(result, True)
        return
    if command == "fleet-plan":
        print(
            f"{'Fleet préparée' if result['prepared'] else 'Proposition Fleet'} "
            f"{result['fleet_id']} · {len(result['order'])} features · base {result['base_commit'][:12]}"
        )
        for overlap in result["overlaps"]:
            print(
                f"Chevauchement : {overlap['left_feature']} / {overlap['right_feature']} · "
                f"{', '.join(overlap['paths'])}"
            )
        for feature_id in result["order"]:
            item = result["features"][feature_id]
            dependencies = ", ".join(item["depends_on"]) or "aucune"
            print(f"{feature_id} · après {dependencies} · {item['worktree']}")
            if result["prepared"] and item["spec_path"] and result["profile_path"]:
                command_line = [
                    "cohorte",
                    "--data-dir",
                    str(data_dir),
                    "loop",
                    item["spec_path"],
                    "--profile",
                    result["profile_path"],
                    "--repo",
                    result["repository"],
                    "--worktrees",
                    result["worktree_parent"],
                    "--existing-worktree",
                    item["worktree"],
                    "--run-id",
                    f"{result['fleet_id']}-{feature_id}"[:80],
                    "--live",
                ]
                print(f"  Dans sa propre session : {shlex.join(command_line)}")
        if result["prepared"]:
            print(
                f"Suivi : cohorte fleet-status {result['fleet_id']} --project-id {result['project_id']}"
            )
        else:
            print("Après validation de l'ordre et des chevauchements, relancer avec --apply.")
    elif command == "fleet-status":
        print(f"Fleet {result['fleet_id']} · {len(result['rows'])} features actives")
        for row in result["rows"]:
            run = row.get("run")
            phase = f" · {run['stage']}/{run['status']}" if run else ""
            drift = f" · ↑{row['ahead']} ↓{row['behind']}" if "ahead" in row else ""
            print(f"{row['feature_id']} · {row['state']}{phase}{drift} · {row['next']}")
    else:
        print(f"Fleet {result['fleet_id']} · merge vérifié : {result['merged_feature']}")
        for item in result["outcomes"]:
            action = f" · {item['action']}" if item.get("action") else ""
            print(f"{item['feature_id']} · {item['status']}{action}")


def _emit_project_status(database: Database, project: dict[str, Any]) -> None:
    project_id = project["id"]
    features = database.list_features(project_id)
    runs = database.list_runs(project_id)
    requests = [
        item
        for item in database.list_requests(status="pending")
        if item["run_id"] is not None and any(run.id == item["run_id"] for run in runs)
    ]
    print(f"Projet {project_id} · {len(features)} fonctionnalités · {len(runs)} exécutions")
    if features:
        print("Fonctionnalités :")
        for item in features[-10:]:
            print(f"  {item['id']} · {item['status']} · {item['title']}")
    if runs:
        print("Exécutions récentes :")
        for state in runs[-10:]:
            print(f"  {state.id} · {state.stage.value} · {state.status.value}")
    if requests:
        print("Décisions en attente :")
        for item in requests:
            print(f"  {item['id']} · {item['kind']} · run {item['run_id']}")
    if not features:
        print("Pour commencer : cohorte brainstorm")


def run(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    database = Database(args.data_dir / "cohorte.sqlite3")
    service = CohorteService(database)
    try:
        if args.command == "start":
            from cohorte.cli.guided_feature import guided_start

            if args.json:
                raise ValueError("start is interactive; use loop with explicit paths for JSON")
            project = _project_for_path(database, Path.cwd())
            spec_path, profile_path, worktrees, run_id = guided_start(
                database, args.data_dir, project, args.feature_id
            )
            args.command = "loop"
            args.spec = spec_path
            args.profile = profile_path
            args.repo = Path(project["root_path"])
            args.worktrees = worktrees
            args.run_id = run_id
            args.existing_worktree = None
            args.live = True
        if args.command == "doctor":
            _emit_doctor_result(_doctor(service, args), args.json)
        elif args.command == "update-pipeline":
            from cohorte.application.discovery import (
                discover_project,
                discovery_report,
                reconcile_profile,
            )
            from cohorte.domain.models import ProjectProfile

            project = _project_for_path(database, args.repo)
            root = Path(project["root_path"])
            current_profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
            detected, questions = discover_project(root, current_profile.language)
            proposed = reconcile_profile(current_profile, detected)
            before = current_profile.model_dump(mode="json")
            after = proposed.model_dump(mode="json")
            changed_fields = sorted(
                key for key in before if key != "revision" and before[key] != after[key]
            )
            if args.apply and changed_fields:
                saved = service.init_project(root, current_profile.language, refresh=True)
                proposed_document = saved["profile"]
                reference = saved["profile_ref"]
            else:
                proposed_document = after
                reference = project["profile_ref"]
            update_result = {
                "project_id": current_profile.project_id,
                "changed_fields": changed_fields,
                "questions": questions,
                "analysis": discovery_report(proposed, questions, root),
                "profile": proposed_document,
                "profile_ref": reference,
                "applied": bool(args.apply and changed_fields),
            }
            if args.json:
                _emit(update_result, True)
            else:
                print(
                    f"Profil {current_profile.project_id} · "
                    f"{'réconcilié' if update_result['applied'] else 'prévisualisation'}"
                )
                print(f"Champs détectés à mettre à jour : {', '.join(changed_fields) or 'aucun'}")
                for question in questions:
                    print(f"À confirmer : {question}")
                if changed_fields and not args.apply:
                    print("Relancer avec --apply après validation du profil proposé en JSON.")
        elif args.command == "wrappers":
            from cohorte.application.client_wrappers import apply_wrappers, wrapper_plan

            wrappers_result = (
                apply_wrappers(args.repo, args.runtime)
                if args.apply
                else wrapper_plan(args.repo, args.runtime)
            )
            if args.json:
                _emit({"wrappers": wrappers_result, "applied": args.apply}, True)
            else:
                for wrapper_item in wrappers_result:
                    print(
                        f"{wrapper_item['runtime']} · {wrapper_item['status']} · "
                        f"{wrapper_item['path']}"
                    )
                if not args.apply:
                    print("Relancer avec --apply pour créer les fichiers proposés.")
        elif args.command == "init":
            if args.profile_file is not None:
                if args.preview:
                    raise ValueError("--profile-file cannot be combined with --preview")
                from cohorte.domain.models import ProjectProfile

                chosen_profile = ProjectProfile.model_validate_json(args.profile_file.read_text())
                _emit_profile_result(
                    service.init_project(
                        args.path,
                        args.language,
                        refresh=args.refresh,
                        profile_override=chosen_profile,
                    ),
                    args.json,
                )
                return 0
            if args.preview or (not args.json and sys.stdin.isatty()):
                from cohorte.application.discovery import (
                    discover_project,
                    discovery_report,
                    profile_provenance,
                    reconcile_profile,
                )

                candidate, questions = discover_project(args.path, args.language)
                try:
                    existing_project = database.get_project(candidate.project_id)
                except KeyError:
                    existing_project = None
                if existing_project is not None and not args.refresh and not args.preview:
                    _emit_profile_result(service.init_project(args.path, args.language), args.json)
                    return 0
                if existing_project is not None and args.refresh:
                    from cohorte.domain.models import ProjectProfile

                    current_profile = ProjectProfile.model_validate_json(
                        json.dumps(existing_project["profile"])
                    )
                    candidate = reconcile_profile(current_profile, candidate)
                preview = {
                    "profile": candidate.model_dump(mode="json"),
                    "questions": questions,
                    "provenance": profile_provenance(args.path),
                    "analysis": discovery_report(candidate, questions, args.path),
                    "preview": True,
                }
                _emit_profile_result(preview, args.json)
                if args.preview:
                    return 0
                candidate = _configure_init_candidate(
                    candidate, cast(dict[str, Any], preview["analysis"]), args.path
                )
                if candidate.model_dump(mode="json") != preview["profile"]:
                    print("Profil ajusté selon vos choix :")
                    preview["profile"] = candidate.model_dump(mode="json")
                    preview["analysis"] = discovery_report(candidate, questions, args.path)
                    _emit_profile_result(preview, args.json)
                if _prompt("Enregistrer ce profil ? [o/N]", required=False).casefold() not in {
                    "o",
                    "oui",
                    "y",
                    "yes",
                }:
                    print("Profil non enregistré.")
                    return 0
            _emit_profile_result(
                service.init_project(
                    args.path,
                    args.language,
                    refresh=args.refresh,
                    profile_override=candidate if not args.json and sys.stdin.isatty() else None,
                ),
                args.json,
            )
        elif args.command == "profile":
            project = (
                database.get_project(args.project_id)
                if args.project_id
                else _project_for_path(database, Path.cwd())
            )
            if args.profile_command == "show":
                _emit(
                    {"profile": project["profile"], "profile_ref": project["profile_ref"]},
                    args.json,
                )
            else:
                if args.profile_command == "edit":
                    if args.json or not sys.stdin.isatty():
                        raise ValueError(
                            "profile edit requires an interactive terminal without --json"
                        )
                    document = _edit_profile(project["profile"])
                else:
                    document = json.loads(args.file.read_text(encoding="utf-8"))
                    if not isinstance(document, dict):
                        raise ValueError("profile must be a JSON object")
                _emit_profile_result(
                    service.save_project_profile(
                        project["id"], document, project["profile_ref"]["revision"]
                    ),
                    args.json,
                )
        elif args.command == "status":
            if args.run:
                payload: Any = service.database.get_run(args.run).model_dump(mode="json")
                _emit(payload, args.json)
            elif not args.json:
                try:
                    project = _project_for_path(database, Path.cwd())
                except ValueError:
                    runs = database.list_runs()
                    print(f"{len(runs)} exécutions enregistrées")
                    for state in runs[-10:]:
                        print(
                            f"  {state.id} · {state.project_id} · "
                            f"{state.stage.value} · {state.status.value}"
                        )
                else:
                    _emit_project_status(database, project)
            else:
                payload = {
                    "runs": [r.model_dump(mode="json") for r in service.database.list_runs()]
                }
                _emit(payload, args.json)
        elif args.command == "specs":
            project = (
                database.get_project(args.project_id)
                if args.project_id
                else _project_for_path(database, Path.cwd())
            )
            features = database.list_features(project["id"])
            if args.status:
                features = [item for item in features if item["status"] == args.status]
            rows = []
            for feature in features:
                try:
                    ready = database.latest_artifact(f"ready:{feature['id']}")
                    ready_ref = {key: ready[key] for key in ("id", "revision", "sha256")}
                except KeyError:
                    ready_ref = None
                rows.append(
                    {
                        "feature_id": feature["id"],
                        "title": feature["title"],
                        "kind": feature["kind"],
                        "status": feature["status"],
                        "ready_ref": ready_ref,
                        "updated_at": feature["updated_at"],
                    }
                )
            if args.json:
                _emit({"project_id": project["id"], "features": rows}, True)
            else:
                print(f"Specs · {project['id']} · {len(rows)} fonctionnalités")
                for row in rows:
                    next_action = (
                        f"cohorte start {row['feature_id']}"
                        if row["status"] == "frozen" and row["ready_ref"]
                        else f"cohorte spec {row['feature_id']}"
                    )
                    print(
                        f"  {row['feature_id']} · {row['status']} · {row['title']} · {next_action}"
                    )
        elif args.command == "export":
            exported = service.export_run(args.run_id, args.max_bytes)
            if args.output is None:
                _emit(exported, args.json)
            else:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                temporary = args.output.with_name(f".{args.output.name}.cohorte.tmp")
                temporary.write_text(
                    json.dumps(exported, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                temporary.replace(args.output)
                _emit({"path": str(args.output), "bytes": args.output.stat().st_size}, args.json)
        elif args.command == "auth":
            if args.auth_command == "login":
                if args.json:
                    raise ValueError("auth login requires an interactive terminal without --json")
                _emit(asdict(native_login(cast(Literal["claude", "codex"], args.target))), False)
            elif args.auth_command == "status":
                providers = [args.provider] if args.provider else ["claude", "codex"]
                _emit(
                    {
                        "accounts": [
                            asdict(inspect_runtime(cast(Literal["claude", "codex"], provider)))
                            for provider in providers
                        ]
                    },
                    args.json,
                )
            elif args.auth_command == "verify" and args.target == "codex" and args.live:
                adapter = CodexAdapter(Path.cwd())
                _emit(adapter.verify_full() if args.full else adapter.verify_live(), args.json)
            elif args.auth_command == "verify" and args.target == "claude" and args.live:
                if args.full:
                    raise ValueError("Claude full G0 qualification is not implemented")
                _emit(ClaudeAdapter(Path.cwd()).verify_live(), args.json)
            elif args.auth_command == "verify" and not args.live:
                target = cast(Literal["claude", "codex"], args.target)
                _emit(asdict(inspect_runtime(target)), args.json)
            else:
                _fail(
                    ValueError(
                        f"auth {args.auth_command} requires the G0 adapter for the pinned official runtime; "
                        "no credential flow is emulated"
                    ),
                    args.json,
                )
        elif args.command == "rpc":
            server = RpcServer(service)
            while line := sys.stdin.buffer.readline(MAX_FRAME_BYTES + 1):
                sys.stdout.buffer.write(server.handle_line(line))
                sys.stdout.buffer.flush()
        elif args.command == "service":
            from cohorte.service.host import service_status, start_service, stop_service

            if args.action == "start":
                service_result = start_service(args.data_dir)
            elif args.action == "status":
                service_result = service_status(args.data_dir)
            else:
                service_result = stop_service(args.data_dir)
            _emit(service_result, args.json)
        elif args.command == "check":
            from cohorte.domain.models import ProjectProfile

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            definition = next((item for item in profile.checks if item.id == args.check_id), None)
            if definition is None:
                raise ValueError(f"unknown check: {args.check_id}")
            _emit(asdict(CheckRunner(Path.cwd()).run(definition)), args.json)
        elif args.command == "schemas":
            _emit(_schemas(args.output), args.json)
        elif args.command == "intake":
            from cohorte.application.intake import (
                IntakeProposal,
                IntakeReport,
                IntakeSourceType,
                IntakeTriage,
                answer_intake,
                load_intake_source,
            )
            from cohorte.cli.guided_intake import (
                ask_answers,
                ask_route,
                parse_answers,
                print_report,
                propose_intake,
            )
            from cohorte.domain.models import ArtifactRef

            project = (
                database.get_project(args.project_id)
                if args.project_id
                else _project_for_path(database, Path.cwd())
            )
            continuing = args.continue_feature_id is not None
            intake_proposal: IntakeProposal | None = None
            if continuing:
                if args.text is not None or args.file is not None or args.url is not None:
                    raise ValueError("intake --continue cannot read a new source")
                feature_id = args.continue_feature_id
                try:
                    feature = database.get_feature(feature_id)
                    if feature["project_id"] != project["id"]:
                        raise KeyError(feature_id)
                    if feature["status"] == "frozen":
                        raise ValueError("frozen intake cannot be changed")
                    stored_report = database.latest_intake_report(feature_id)
                except KeyError as error:
                    raise ValueError(f"unknown intake in this project: {feature_id}") from error
                intake_report_doc = IntakeReport.model_validate_json(stored_report["content"])
                intake_report_ref = ArtifactRef.model_validate(
                    {key: stored_report[key] for key in ("id", "revision", "sha256")}
                )
                intake_result: dict[str, Any] = {
                    "feature_id": feature_id,
                    "report": intake_report_doc.model_dump(mode="json"),
                    "report_ref": intake_report_ref.model_dump(mode="json"),
                }
            else:
                if args.text is None and args.file is None and args.url is None:
                    if args.json or not sys.stdin.isatty():
                        raise ValueError(
                            "intake requires --text, --file or --url; run in a terminal for guided mode"
                        )
                    source_kind = _prompt("Source [texte/fichier/url]").lower()
                    if source_kind in {"texte", "text"}:
                        args.text = _prompt("Décris la demande")
                    elif source_kind in {"fichier", "file"}:
                        args.file = Path(_prompt("Chemin du fichier")).expanduser()
                    elif source_kind == "url":
                        args.url = _prompt("URL de la demande")
                    else:
                        raise ValueError("source must be texte, fichier or url")
                if args.text is not None:
                    source_type, value = IntakeSourceType.TEXT, args.text
                elif args.file is not None:
                    source_type, value = IntakeSourceType.FILE, str(args.file)
                else:
                    source_type, value = IntakeSourceType.URL, args.url
                source, locator = load_intake_source(source_type, value)
                if not args.json and sys.stdin.isatty() and not args.manual:
                    print(
                        "L'agent analyse la demande et le dépôt en lecture seule…", file=sys.stderr
                    )
                    try:
                        intake_proposal = propose_intake(project, source)
                    except (CohorteError, ValueError, RuntimeError) as error:
                        print(
                            f"Triage agent indisponible : {error}; analyse déterministe conservée.",
                            file=sys.stderr,
                        )
                intake_result = service.intake(
                    project["id"],
                    source,
                    args.title,
                    source_type=source_type,
                    locator=locator,
                )
                feature_id = cast(str, intake_result["feature_id"])
                intake_report_doc = IntakeReport.model_validate_json(
                    json.dumps(intake_result["report"])
                )
                intake_report_ref = ArtifactRef.model_validate(intake_result["report_ref"])
                if intake_proposal is not None:
                    proposal_ref = database.put_artifact(
                        "intake-proposal",
                        intake_proposal.model_dump_json(indent=2).encode(),
                        artifact_id=f"proposal:intake:{feature_id}",
                    )
                    print(
                        f"Piste de l'agent : {intake_proposal.route.value} · {intake_proposal.rationale}"
                    )
                    if intake_proposal.suspected_surfaces:
                        print(
                            f"Surfaces probables : {', '.join(intake_proposal.suspected_surfaces)}"
                        )
                    print(f"À vérifier : {intake_proposal.caveat}")
                    proposed_questions = intake_proposal.questions
                    proposal_route = intake_report_doc.triage
                    if intake_proposal.route != proposal_route:
                        choice = _prompt(
                            f"Adopter le parcours {intake_proposal.route.value} proposé ? [o/N]",
                            required=False,
                        )
                        if choice.casefold() in {"o", "oui", "y", "yes"}:
                            proposal_route = intake_proposal.route
                    intake_report_doc = intake_report_doc.model_copy(
                        update={
                            "triage": proposal_route,
                            "questions": proposed_questions or intake_report_doc.questions,
                            "reasons": [
                                *intake_report_doc.reasons,
                                "read-only agent proposal reviewed",
                            ],
                            "previous_report_ref": intake_report_ref,
                        }
                    )
                    stored = database.put_artifact(
                        "intake-report",
                        intake_report_doc.model_dump_json(indent=2).encode(),
                        artifact_id=f"intake:{feature_id}",
                    )
                    intake_report_ref = ArtifactRef.model_validate(stored)
                    database.set_feature_kind(feature_id, proposal_route.value)
                    intake_result.update(
                        {
                            "report": intake_report_doc.model_dump(mode="json"),
                            "report_ref": intake_report_ref.model_dump(mode="json"),
                            "proposal_ref": proposal_ref,
                        }
                    )
            if args.json:
                intake_answers = parse_answers(args.answer, intake_report_doc.questions)
                route = IntakeTriage(args.route) if args.route else None
            elif sys.stdin.isatty() and (
                intake_report_doc.questions or intake_report_doc.triage == IntakeTriage.QUESTIONS
            ):
                print_report(feature_id, intake_report_doc, intake_report_ref.revision)
                intake_answers = ask_answers(intake_report_doc)
                route = ask_route(intake_report_doc)
            else:
                intake_answers = parse_answers(args.answer, intake_report_doc.questions)
                route = IntakeTriage(args.route) if args.route else None
            if intake_answers or route is not None:
                intake_report_doc = answer_intake(
                    intake_report_doc, intake_answers, route, previous_ref=intake_report_ref
                )
                stored = database.put_artifact(
                    "intake-report",
                    intake_report_doc.model_dump_json(indent=2).encode(),
                    artifact_id=f"intake:{feature_id}",
                )
                intake_report_ref = ArtifactRef.model_validate(stored)
                if route is not None:
                    database.set_feature_kind(feature_id, route.value)
                intake_result["report"] = intake_report_doc.model_dump(mode="json")
                intake_result["report_ref"] = intake_report_ref.model_dump(mode="json")
            if args.json:
                _emit(intake_result, True)
            else:
                print_report(feature_id, intake_report_doc, intake_report_ref.revision)
        elif args.command == "brainstorm":
            from cohorte.application.preparation import (
                BrainstormBrief,
                BrainstormRunner,
                canonical_model_bytes,
            )
            from cohorte.application.repository_context import (
                collect_project_overview,
                collect_repository_context,
            )
            from cohorte.domain.models import ArtifactRef, ProjectProfile

            guided = (
                not args.json
                and sys.stdin.isatty()
                and (
                    args.continue_feature_id is not None
                    or args.project_id is None
                    or args.idea is None
                    or not args.answer
                )
            )
            project = (
                database.get_project(args.project_id)
                if args.project_id
                else _project_for_path(database, args.repo)
            )
            args.project_id = project["id"]
            repository = Path(project["root_path"]).resolve(strict=True)
            requested_repo = args.repo.resolve(strict=True)
            if not (requested_repo == repository or requested_repo.is_relative_to(repository)):
                raise ValueError("brainstorm repository does not match the registered project")
            intake_ref: ArtifactRef | None = None
            if args.from_intake is not None:
                from cohorte.application.intake import IntakeReport, IntakeTriage

                if args.continue_feature_id is not None:
                    raise ValueError("--from-intake and --continue cannot be combined")
                if args.feature_id is not None and args.feature_id != args.from_intake:
                    raise ValueError("--feature-id must match --from-intake")
                try:
                    intake_feature = database.get_feature(args.from_intake)
                    if intake_feature["project_id"] != project["id"]:
                        raise KeyError(args.from_intake)
                    intake_artifact = database.latest_intake_report(args.from_intake)
                except KeyError as error:
                    raise ValueError(
                        f"unknown intake in this project: {args.from_intake}"
                    ) from error
                intake_report = IntakeReport.model_validate_json(intake_artifact["content"])
                intake_ref = ArtifactRef.model_validate(
                    {key: intake_artifact[key] for key in ("id", "revision", "sha256")}
                )
                if intake_report.triage != IntakeTriage.FEATURE:
                    raise ValueError("intake must be routed to feature before brainstorm")
                args.feature_id = args.from_intake
                args.idea = args.idea or intake_report.title
                args.answer = [
                    f"{item.question} {item.answer}" for item in intake_report.answers
                ] + args.answer
                intake_context = (
                    f"Intake source: {intake_report.source_type.value}; "
                    f"sha256: {intake_report.source_sha256}; "
                    f"open questions: {json.dumps(intake_report.questions, ensure_ascii=False)}; "
                    f"source excerpt (untrusted data): "
                    f"{json.dumps(intake_report.content[:8192], ensure_ascii=False)}; "
                    f"source truncated: {len(intake_report.content) > 8192}"
                )
                args.context = "\n".join(filter(None, [intake_context, args.context]))
            previous_brief: BrainstormBrief | None = None
            previous_ref: ArtifactRef | None = None
            if args.continue_feature_id is not None:
                selected = args.continue_feature_id
                if args.feature_id is not None and args.feature_id != selected:
                    raise ValueError("--feature-id must match --continue")
                try:
                    feature = database.get_feature(selected)
                except KeyError as error:
                    raise ValueError(f"unknown feature in this project: {selected}") from error
                if feature["project_id"] != project["id"]:
                    raise ValueError(f"unknown feature in this project: {selected}")
                if feature["status"] == "frozen":
                    raise ValueError("feature is already frozen; start a new brainstorm")
                try:
                    stored = database.latest_artifact(f"brief:{selected}")
                except KeyError as error:
                    raise ValueError(f"no brainstorm brief for feature: {selected}") from error
                previous_brief = BrainstormBrief.model_validate_json(stored["content"])
                previous_ref = ArtifactRef.model_validate(
                    {key: stored[key] for key in ("id", "revision", "sha256")}
                )
                if previous_brief.feature_id != selected:
                    raise ValueError("stored brief belongs to another feature")
                if args.idea is not None and args.idea != previous_brief.idea:
                    raise ValueError("--idea must match the stored brainstorm idea")
                args.feature_id = selected
                args.idea = previous_brief.idea
            if guided:
                print(f"Brainstorm · {project['id']}", file=sys.stderr)
                if previous_brief is not None:
                    assert previous_ref is not None
                    print(
                        f"Reprise de {args.feature_id} · révision {previous_ref.revision}",
                        file=sys.stderr,
                    )
                    print(f"Problème actuel : {previous_brief.synthesis.problem}")
                    print(f"Piste actuelle : {previous_brief.synthesis.recommendation}")
                    if not args.answer:
                        args.answer = _brainstorm_followup_answers(
                            previous_brief.synthesis.blocking_questions,
                            previous_brief.synthesis.question_proposals,
                        )
                        if not args.answer:
                            print("Aucune nouvelle réponse ; brief inchangé.")
                            return 0
                else:
                    args.idea = args.idea or _prompt("Quelle idée veux-tu explorer ?")
                    if not args.feature_id:
                        suggested = re.sub(r"[^a-z0-9]+", "-", args.idea.lower()).strip("-")[:80]
                        args.feature_id = (
                            _prompt(f"Identifiant [{suggested}]", required=False) or suggested
                        )
                    _require_new_brainstorm_feature(database, project["id"], args.feature_id)
                panel = (
                    ProjectProfile.model_validate_json(
                        json.dumps(project["profile"])
                    ).brainstorm_panel
                    if project.get("profile")
                    else ["product", "architecture", "qa"]
                )
                print(f"Le panel {', '.join(panel)} travaille…", file=sys.stderr)
            if not args.live and not guided:
                raise ValueError("brainstorm requires --live")
            if previous_brief is not None and not args.answer and not guided:
                raise ValueError("brainstorm --continue requires at least one --answer")
            if not args.idea or not args.feature_id:
                raise ValueError(
                    "brainstorm requires --feature-id and --idea; run in a terminal for guided mode"
                )
            if previous_brief is None and not guided:
                _require_new_brainstorm_feature(database, project["id"], args.feature_id)
            project_profile = (
                ProjectProfile.model_validate_json(json.dumps(project["profile"]))
                if project.get("profile") is not None
                else None
            )
            brainstorm_runtime: CodexAdapter | ClaudeAdapter
            selected_provider = args.provider or (
                project_profile.agent_defaults.provider.value
                if project_profile is not None
                else "codex"
            )
            agent_events = SqliteAgentEventSink(database.path, args.project_id)
            if selected_provider == "claude":
                brainstorm_runtime = ClaudeAdapter(
                    repository,
                    model=project_profile.agent_defaults.model
                    if project_profile is not None
                    else None,
                    event_sink=agent_events,
                )
            else:
                brainstorm_runtime = CodexAdapter(repository, event_sink=agent_events)
            runner = BrainstormRunner(brainstorm_runtime)
            while True:
                repository_context = collect_repository_context(
                    repository,
                    " ".join(
                        [
                            args.feature_id,
                            args.idea,
                            *(previous_brief.user_answers if previous_brief else []),
                            *args.answer,
                        ]
                    ),
                )
                brief = runner.run(
                    repository,
                    args.feature_id,
                    args.idea,
                    "\n".join(
                        filter(
                            None,
                            [
                                _profile_context(project["profile"]),
                                collect_project_overview(repository),
                                repository_context,
                                args.context,
                            ],
                        )
                    ),
                    args.answer,
                    args.prior_decision,
                    args.perspective
                    or (project_profile.brainstorm_panel if project_profile else None),
                    previous_brief=previous_brief,
                    previous_brief_ref=previous_ref,
                    intake_ref=intake_ref,
                )
                brief_ref = database.put_artifact(
                    "brainstorm-brief",
                    canonical_model_bytes(brief),
                    artifact_id=f"brief:{args.feature_id}",
                )
                database.ensure_feature(args.feature_id, args.project_id, args.idea[:200])
                payload = {"brief": brief.model_dump(mode="json"), "brief_ref": brief_ref}
                if args.output is not None:
                    args.output.parent.mkdir(parents=True, exist_ok=True)
                    temporary = args.output.with_name(f".{args.output.name}.cohorte.tmp")
                    temporary.write_bytes(canonical_model_bytes(brief))
                    temporary.replace(args.output)
                    payload["output"] = str(args.output)
                if not guided:
                    _emit(payload, args.json)
                    break
                synthesis = brief.synthesis
                print(f"\n{brief.idea}\n")
                print(f"Problème : {synthesis.problem}\n")
                print(f"Piste : {synthesis.recommendation}\n")
                if synthesis.blocking_questions:
                    print("Questions à trancher :")
                    for question in synthesis.blocking_questions:
                        print(f"  • {question}")
                print(f"\nBrief enregistré : {brief_ref['id']} (révision {brief_ref['revision']})")
                if not synthesis.blocking_questions:
                    print(f"Prochaine étape : cohorte spec {args.feature_id}")
                    break
                answer = _prompt("Répondre à ces questions maintenant ? [o/N]", required=False)
                if answer.lower() not in {"o", "oui", "y", "yes"}:
                    print(f"Reprendre plus tard : cohorte brainstorm --continue {args.feature_id}")
                    break
                answers = _brainstorm_followup_answers(
                    synthesis.blocking_questions, synthesis.question_proposals
                )
                if not answers:
                    print(f"Reprendre plus tard : cohorte brainstorm --continue {args.feature_id}")
                    break
                previous_brief = brief
                previous_ref = ArtifactRef.model_validate(brief_ref)
                args.answer = answers
        elif args.command == "brief":
            from cohorte.application.preparation import BrainstormBrief
            from cohorte.cli.brief import print_brief

            project = _project_for_path(database, Path.cwd())
            try:
                feature = database.get_feature(args.feature_id)
            except KeyError as error:
                raise ValueError(f"unknown feature in this project: {args.feature_id}") from error
            if feature["project_id"] != project["id"]:
                raise ValueError(f"unknown feature in this project: {args.feature_id}")
            try:
                stored = database.latest_artifact(f"brief:{args.feature_id}")
            except KeyError as error:
                raise ValueError(f"no brainstorm brief for feature: {args.feature_id}") from error
            brief = BrainstormBrief.model_validate_json(stored["content"])
            payload = {
                "brief": brief.model_dump(mode="json"),
                "brief_ref": {key: stored[key] for key in ("id", "revision", "sha256")},
            }
            if args.json:
                _emit(payload, True)
            else:
                print_brief(brief, stored["revision"])
        elif args.command == "spec":
            from cohorte.cli.guided_feature import guided_spec

            if args.json:
                raise ValueError("spec is interactive; use spec-freeze-request for JSON")
            project = _project_for_path(database, Path.cwd())
            guided_spec(
                database, args.data_dir, project, args.feature_id, args.refresh, not args.manual
            )
        elif args.command == "spec-freeze-request":
            from cohorte.application.preparation import SpecFreezer
            from cohorte.domain.models import FeatureSpec, ProjectProfile

            draft = FeatureSpec.model_validate_json(args.draft.read_text())
            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            base_commit = GitRepository(args.repo.resolve(strict=True)).head
            prepared = SpecFreezer(database).prepare(draft, profile, base_commit)
            _emit(prepared.model_dump(mode="json"), args.json)
        elif args.command == "spec-freeze":
            from cohorte.application.preparation import SpecFreezer, canonical_model_bytes
            from cohorte.domain.models import FeatureSpec, ProjectProfile

            draft = FeatureSpec.model_validate_json(args.draft.read_text())
            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            repository = args.repo.resolve(strict=True)
            frozen_result = SpecFreezer(database).freeze(
                draft,
                profile,
                GitRepository(repository).head,
                args.decision_id,
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_name(f".{args.output.name}.cohorte.tmp")
            temporary.write_bytes(canonical_model_bytes(frozen_result.spec))
            temporary.replace(args.output)
            profile_ref = database.put_artifact("project-profile", canonical_model_bytes(profile))
            database.ensure_project(
                profile.project_id,
                str(repository),
                profile_ref["id"],
            )
            database.ensure_feature(
                frozen_result.spec.feature_id,
                profile.project_id,
                frozen_result.spec.title,
            )
            database.set_feature_status(frozen_result.spec.feature_id, "frozen")
            _emit(
                {**frozen_result.model_dump(mode="json"), "output": str(args.output)},
                args.json,
            )
        elif args.command == "patch-spec":
            from cohorte.application.patch import PatchSpec, RegressionMode, patch_profile
            from cohorte.domain.models import ArtifactRef, ProjectProfile

            if args.from_intake is not None:
                from cohorte.cli.guided_patch import guided_patch_spec

                if args.json:
                    raise ValueError(
                        "patch-spec --from-intake is interactive; use explicit fields for JSON"
                    )
                if (
                    any(
                        value is not None
                        for value in (
                            args.source_artifact_id,
                            args.source_revision,
                            args.profile,
                            args.patch_id,
                            args.title,
                            args.reproduction,
                            args.observed,
                            args.expected,
                            args.surface,
                            args.write_path,
                            args.in_scope,
                            args.rollback,
                            args.output,
                        )
                    )
                    or args.check
                    or args.out_of_scope
                    or args.manual_regression
                ):
                    raise ValueError(
                        "patch-spec --from-intake cannot be combined with explicit patch fields"
                    )
                project = _project_for_path(database, Path.cwd())
                guided_patch_document, output = guided_patch_spec(
                    database, project, args.data_dir, args.from_intake, propose=not args.manual
                )
                _emit(
                    {"output": str(output), "patch": guided_patch_document.model_dump(mode="json")},
                    False,
                )
                return 0
            mandatory = {
                "source-artifact-id": args.source_artifact_id,
                "source-revision": args.source_revision,
                "profile": args.profile,
                "patch-id": args.patch_id,
                "title": args.title,
                "reproduction": args.reproduction,
                "observed": args.observed,
                "expected": args.expected,
                "surface": args.surface,
                "write-path": args.write_path,
                "in-scope": args.in_scope,
                "rollback": args.rollback,
                "output": args.output,
            }
            missing = [name for name, value in mandatory.items() if value is None]
            if missing:
                raise ValueError(
                    f"patch-spec requires {', '.join('--' + name for name in missing)}"
                )
            assert args.profile is not None and args.output is not None
            assert args.source_artifact_id is not None and args.source_revision is not None
            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            source_artifact = database.get_artifact(args.source_artifact_id, args.source_revision)
            patch_document = PatchSpec(
                patch_id=args.patch_id,
                title=args.title,
                source_ref=ArtifactRef(
                    id=source_artifact["id"],
                    revision=source_artifact["revision"],
                    sha256=source_artifact["sha256"],
                ),
                reproduction=args.reproduction,
                observed_behavior=args.observed,
                expected_behavior=args.expected,
                surfaces=args.surface,
                write_paths=args.write_path,
                regression_mode=(
                    RegressionMode.MANUAL if args.manual_regression else RegressionMode.AUTOMATIC
                ),
                regression_check_ids=args.check,
                in_scope=args.in_scope,
                out_of_scope=args.out_of_scope,
                rollback=args.rollback,
            )
            patch_profile(profile, patch_document)
            args.output.write_text(patch_document.model_dump_json(indent=2) + "\n")
            _emit(
                {"output": str(args.output), "patch": patch_document.model_dump(mode="json")},
                args.json,
            )
        elif args.command == "patch":
            from cohorte.application.patch import (
                PatchRunner,
                PatchSpec,
                patch_feature_spec,
                patch_profile,
            )
            from cohorte.domain.models import ProjectProfile, RunState, RunStatus, Stage

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            patch_document = PatchSpec.model_validate_json(args.spec.read_text())
            bounded_profile = patch_profile(profile, patch_document)
            feature_spec = patch_feature_spec(patch_document)
            profile_ref = database.put_artifact(
                "project-profile", bounded_profile.model_dump_json(indent=2).encode()
            )
            spec_ref = database.put_artifact(
                "patch-spec", feature_spec.model_dump_json(indent=2).encode()
            )
            repository = args.repo.resolve(strict=True)
            database.ensure_project(profile.project_id, str(repository), profile_ref["id"])
            database.ensure_feature(
                feature_spec.feature_id, profile.project_id, feature_spec.title, kind="patch"
            )
            now = datetime.now(UTC)
            database.create_run(
                RunState(
                    id=args.run_id,
                    project_id=profile.project_id,
                    feature_id=feature_spec.feature_id,
                    stage=Stage.BUILD,
                    status=RunStatus.RUNNING,
                    state_version=1,
                    base_commit=GitRepository(repository).head,
                    created_at=now,
                    updated_at=now,
                )
            )
            worktree = args.worktrees.resolve() / f"{feature_spec.feature_id}-{args.run_id}"
            database.append_event(
                "run.context",
                {
                    "workflow": "patch",
                    "repository": str(repository),
                    "worktree_parent": str(args.worktrees.resolve()),
                    "worktree": str(worktree),
                    "profile_ref": profile_ref,
                    "spec_ref": spec_ref,
                },
                project_id=profile.project_id,
                run_id=args.run_id,
            )
            journal = SqliteRunJournal(database, args.run_id)
            try:
                patch_result = PatchRunner(
                    workflow_runtime(
                        repository,
                        profile,
                        stop_requested=journal.stop_requested,
                        event_sink=journal.agent_event,
                    )
                ).run(
                    repository,
                    args.worktrees,
                    profile,
                    patch_document,
                    args.run_id,
                    observe=journal,
                )
            except RunStopped:
                _emit(database.get_run(args.run_id).model_dump(mode="json"), args.json)
                return 0
            except Exception as error:
                record_run_error(database, args.run_id, error)
                raise
            request_id = _create_ship_request(database, args.run_id, patch_result.candidate)
            _emit({**asdict(patch_result), "ship_request_id": request_id}, args.json)
        elif args.command == "audit":
            from cohorte.application.maintenance import AuditRunner, AuditSpec
            from cohorte.domain.models import ProjectProfile

            if args.profile is None:
                project = _project_for_path(database, args.repo)
                profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
                args.repo = Path(project["root_path"])
            else:
                profile = ProjectProfile.model_validate_json(args.profile.read_text())
            args.audit_id = args.audit_id or datetime.now(UTC).strftime("audit-%Y%m%d-%H%M%S")
            args.title = args.title or f"Audit de {profile.name}"
            args.surface = args.surface or [surface.id for surface in profile.surfaces]
            selected = {surface.id: surface for surface in profile.surfaces}
            if not set(args.surface) <= selected.keys():
                raise ValueError("audit refers to an unknown surface")
            args.path = args.path or list(
                dict.fromkeys(path for sid in args.surface for path in selected[sid].paths)
            )
            args.concern = args.concern or [
                "conformité aux conventions du projet",
                "correction et sécurité",
                "couverture des comportements critiques",
            ]
            args.output = args.output or (args.data_dir / "audits" / f"{args.audit_id}.json")
            audit_spec = AuditSpec(
                audit_id=args.audit_id,
                title=args.title,
                surface_ids=args.surface,
                paths=args.path,
                concerns=args.concern,
            )
            audit_report = AuditRunner(
                workflow_runtime(
                    args.repo,
                    profile,
                    event_sink=SqliteAgentEventSink(database.path, profile.project_id),
                )
            ).run(args.repo, profile, audit_spec)
            report_ref = database.put_artifact(
                "audit-report", audit_report.model_dump_json(indent=2).encode()
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(audit_report.model_dump_json(indent=2) + "\n")
            _emit(
                {
                    "output": str(args.output),
                    "report_ref": report_ref,
                    "report": audit_report.model_dump(mode="json"),
                },
                args.json,
            )
        elif args.command == "incoming-review":
            from cohorte.application.incoming_review import (
                lookup_incoming_metadata,
                review_incoming,
            )
            from cohorte.domain.models import ProjectProfile

            if args.json and not args.live:
                raise ValueError("incoming-review in JSON mode requires --live")
            repository = args.repo.resolve(strict=True)
            if args.profile is not None:
                profile = ProjectProfile.model_validate_json(args.profile.read_text())
            else:
                project = _project_for_path(database, repository)
                profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
                if Path(project["root_path"]).resolve() != repository:
                    raise ValueError("incoming review must use the registered project root")
            metadata = lookup_incoming_metadata(
                repository,
                profile,
                args.number,
                title=args.title,
                description=args.description,
            )
            incoming_result = review_incoming(
                repository,
                args.worktrees or args.data_dir / "worktrees",
                profile,
                metadata,
                workflow_runtime(repository, profile),
            )
            result_ref = database.put_artifact(
                "incoming-review",
                incoming_result.model_dump_json(indent=2).encode(),
                artifact_id=f"incoming-review:{profile.project_id}:{metadata.host}:{metadata.number}",
            )
            if args.json:
                _emit(
                    {"report": incoming_result.model_dump(mode="json"), "report_ref": result_ref},
                    True,
                )
            else:
                print(
                    f"Revue {metadata.host} #{metadata.number} · {incoming_result.review.verdict.value} · "
                    f"{len(incoming_result.changed_files)} fichiers · "
                    f"{len(incoming_result.review.findings)} constats"
                )
                for finding in incoming_result.review.findings:
                    print(f"  • {finding.severity} · {finding.path} · {finding.message}")
                print(f"Artefact : {result_ref['id']} (révision {result_ref['revision']})")
                print(f"Checkout isolé : {incoming_result.worktree}")
        elif args.command == "refactor":
            from cohorte.application.maintenance import (
                AuditReport,
                RefactorRunner,
                RefactorSelection,
                refactor_feature,
                refactor_profile,
                refactor_subject_hash,
            )
            from cohorte.domain.models import ProjectProfile, RunState, RunStatus, Stage

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            selection = RefactorSelection.model_validate_json(args.selection.read_text())
            backlog_artifact = database.get_artifact(
                selection.backlog_ref.id, selection.backlog_ref.revision
            )
            if backlog_artifact["sha256"] != selection.backlog_ref.sha256:
                raise CohorteError(
                    ErrorCode.ARTIFACT_CORRUPT,
                    "refactor backlog reference hash does not match stored artifact",
                    "refactor implementation was not started",
                    remediation="refresh the audit backlog reference",
                )
            backlog = AuditReport.model_validate_json(backlog_artifact["content"])
            if (
                not selection.approved
                or selection.approval_ref is None
                or not selection.approval_ref.id.startswith("decision:")
            ):
                raise CohorteError(
                    ErrorCode.APPROVAL_REQUIRED,
                    "refactor selection has no persisted approval decision",
                    "refactor implementation was not started",
                    remediation="create and approve a refactor request for this selection",
                )
            approval = database.get_approval(selection.approval_ref.id.removeprefix("decision:"))
            request = database.get_request(approval["request_id"])
            subject_hash = refactor_subject_hash(selection)
            if (
                request["kind"] != "refactor-selection"
                or request["subject_hash"] != subject_hash
                or approval["answer"] != {"approved": True}
                or selection.approval_ref.sha256 != subject_hash
            ):
                raise CohorteError(
                    ErrorCode.APPROVAL_REQUIRED,
                    "decision does not approve this exact refactor selection",
                    "refactor implementation was not started",
                    remediation="approve the current selection and use its decision reference",
                )
            bounded_profile = refactor_profile(profile, selection)
            feature_spec = refactor_feature(selection)
            profile_ref = database.put_artifact(
                "project-profile", bounded_profile.model_dump_json(indent=2).encode()
            )
            spec_ref = database.put_artifact(
                "refactor-spec", feature_spec.model_dump_json(indent=2).encode()
            )
            repository = args.repo.resolve(strict=True)
            database.ensure_project(profile.project_id, str(repository), profile_ref["id"])
            database.ensure_feature(
                feature_spec.feature_id,
                profile.project_id,
                feature_spec.title,
                kind="refactor",
            )
            now = datetime.now(UTC)
            database.create_run(
                RunState(
                    id=args.run_id,
                    project_id=profile.project_id,
                    feature_id=feature_spec.feature_id,
                    stage=Stage.BUILD,
                    status=RunStatus.RUNNING,
                    state_version=1,
                    base_commit=GitRepository(repository).head,
                    created_at=now,
                    updated_at=now,
                )
            )
            worktree = args.worktrees.resolve() / f"{feature_spec.feature_id}-{args.run_id}"
            database.append_event(
                "run.context",
                {
                    "workflow": "refactor",
                    "repository": str(repository),
                    "worktree_parent": str(args.worktrees.resolve()),
                    "worktree": str(worktree),
                    "profile_ref": profile_ref,
                    "spec_ref": spec_ref,
                },
                project_id=profile.project_id,
                run_id=args.run_id,
            )
            journal = SqliteRunJournal(database, args.run_id)
            try:
                refactor_result = RefactorRunner(
                    workflow_runtime(
                        repository,
                        profile,
                        stop_requested=journal.stop_requested,
                        event_sink=journal.agent_event,
                    )
                ).run(
                    repository,
                    args.worktrees,
                    profile,
                    selection,
                    backlog,
                    args.run_id,
                    observe=journal,
                )
            except RunStopped:
                _emit(database.get_run(args.run_id).model_dump(mode="json"), args.json)
                return 0
            except Exception as error:
                record_run_error(database, args.run_id, error)
                raise
            request_id = _create_ship_request(database, args.run_id, refactor_result.candidate)
            _emit({**asdict(refactor_result), "ship_request_id": request_id}, args.json)
        elif args.command == "refactor-plan":
            from cohorte.adapters.git import path_is_owned
            from cohorte.application.maintenance import (
                AuditReport,
                RefactorSelection,
                refactor_subject_hash,
                validate_refactor_backlog,
            )
            from cohorte.domain.models import ArtifactRef, ProjectProfile

            repository = args.repo.resolve(strict=True)
            if args.profile is None:
                project = _project_for_path(database, repository)
                profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
            else:
                profile = ProjectProfile.model_validate_json(args.profile.read_text())
            backlog = AuditReport.model_validate_json(args.report.read_text())
            available = {finding.id: finding for finding in backlog.findings}
            selected_ids = list(dict.fromkeys(args.finding))
            if missing := sorted(set(selected_ids) - available.keys()):
                raise ValueError(f"unknown audit findings: {', '.join(missing)}")
            selected_findings = [available[finding_id] for finding_id in selected_ids]
            selected_surfaces = [
                surface
                for surface in profile.surfaces
                if any(path_is_owned(finding.path, surface.paths) for finding in selected_findings)
            ]
            if not selected_surfaces or any(
                not any(path_is_owned(finding.path, surface.paths) for surface in selected_surfaces)
                for finding in selected_findings
            ):
                raise ValueError("every selected finding must be owned by a profile surface")
            check_ids = list(
                dict.fromkeys(check for surface in selected_surfaces for check in surface.check_ids)
            )
            if not check_ids:
                raise ValueError("selected surfaces need a configured check before refactor")
            backlog_content = backlog.model_dump_json(indent=2).encode()
            try:
                backlog_reference = database.artifact_ref_by_hash(
                    "audit-report", hashlib.sha256(backlog_content).hexdigest()
                )
            except KeyError as error:
                raise ValueError(
                    "audit report is not registered; run cohorte audit before refactor-plan"
                ) from error
            backlog_ref = ArtifactRef.model_validate(backlog_reference)
            selection = RefactorSelection(
                refactor_id=f"refactor-{backlog.audit_id}"[:80],
                title=f"Corriger les constats de {backlog.audit_id}",
                backlog_ref=backlog_ref,
                selected_finding_ids=selected_ids,
                invariants=args.invariant,
                surfaces=[surface.id for surface in selected_surfaces],
                write_paths=list(dict.fromkeys(finding.path for finding in selected_findings)),
                check_ids=check_ids,
                out_of_scope=[],
                rollback=args.rollback,
            )
            validate_refactor_backlog(selection, backlog)
            subject_hash = refactor_subject_hash(selection)
            selection_path = args.output or (
                args.data_dir / "refactors" / f"{selection.refactor_id}.json"
            )
            refactor_request_id: str | None = None
            if args.approve:
                refactor_request_id = database.create_request(
                    None,
                    "refactor-selection",
                    {
                        "refactor_id": selection.refactor_id,
                        "selected_finding_ids": selected_ids,
                        "write_paths": selection.write_paths,
                        "invariants": selection.invariants,
                    },
                    subject_hash,
                )
                decision = database.respond_request(
                    refactor_request_id,
                    f"cli:refactor-plan:{refactor_request_id}",
                    {"approved": True},
                    subject_hash,
                )
                selection = selection.model_copy(
                    update={
                        "approved": True,
                        "approval_ref": ArtifactRef(
                            id=f"decision:{decision['decision_id']}",
                            revision=1,
                            sha256=subject_hash,
                        ),
                    }
                )
                selection_path.parent.mkdir(parents=True, exist_ok=True)
                selection_path.write_text(selection.model_dump_json(indent=2) + "\n")
            plan_result = {
                "selection": selection.model_dump(mode="json"),
                "subject_hash": subject_hash,
                "approved": args.approve,
                "request_id": refactor_request_id,
                "output": str(selection_path) if args.approve else None,
            }
            if args.json:
                _emit(plan_result, True)
            else:
                print(
                    f"Refactor {selection.refactor_id} · {len(selected_ids)} constats · "
                    f"{', '.join(selection.surfaces)}"
                )
                for audit_finding in selected_findings:
                    print(
                        f"  {audit_finding.id} · P{audit_finding.priority} · "
                        f"{audit_finding.path} · {audit_finding.recommendation}"
                    )
                print(f"Invariant : {'; '.join(selection.invariants)}")
                if args.approve:
                    print(f"Sélection approuvée : {selection_path}")
                else:
                    print("Relancer avec --approve pour enregistrer cette sélection exacte.")
        elif args.command == "refactor-request":
            from cohorte.application.maintenance import (
                RefactorSelection,
                refactor_subject_hash,
            )

            selection = RefactorSelection.model_validate_json(args.selection.read_text())
            subject_hash = refactor_subject_hash(selection)
            request_id = database.create_request(
                None,
                "refactor-selection",
                {
                    "refactor_id": selection.refactor_id,
                    "selected_finding_ids": selection.selected_finding_ids,
                    "write_paths": selection.write_paths,
                    "invariants": selection.invariants,
                },
                subject_hash,
            )
            _emit(
                {"request_id": request_id, "subject_hash": subject_hash},
                args.json,
            )
        elif args.command == "retro":
            from cohorte.application.maintenance import AuditReport, propose_retro
            from cohorte.application.retrospective import (
                mine_review_patterns,
                proposal_from_pattern,
                suggest_retro_rules,
            )
            from cohorte.domain.models import ProjectProfile, Provider

            retro_project_id: str | None = None
            if args.reports:
                if not args.proposal_id or not args.rule or args.output is None:
                    raise ValueError(
                        "retro with report files requires --proposal-id, --rule and --output"
                    )
                reports = [
                    AuditReport.model_validate_json(report.read_text()) for report in args.reports
                ]
                proposal = propose_retro(args.proposal_id, args.rule, reports)
            else:
                project = _project_for_path(database, Path.cwd())
                retro_project_id = project["id"]
                profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
                patterns = mine_review_patterns(database, profile)
                suggestions = []
                if patterns and not args.manual and (args.live or not args.json):
                    repository = Path(project["root_path"]).resolve(strict=True)
                    runtime = (
                        ClaudeAdapter(repository)
                        if profile.agent_defaults.provider == Provider.CLAUDE
                        else CodexAdapter(repository)
                    )
                    try:
                        suggestions = suggest_retro_rules(
                            runtime, repository, profile, patterns
                        ).suggestions
                    except (CohorteError, ValueError, RuntimeError) as error:
                        if not args.json:
                            print(f"Propositions agent indisponibles : {error}", file=sys.stderr)
                if args.pattern is None and (args.json or not sys.stdin.isatty()):
                    _emit(
                        {
                            "patterns": [item.model_dump(mode="json") for item in patterns],
                            "suggestions": [item.model_dump(mode="json") for item in suggestions],
                        },
                        args.json,
                    )
                    return 0
                if not patterns:
                    print("Aucun motif présent dans les revues d'au moins deux features.")
                    return 0
                if not args.json:
                    for pattern in patterns:
                        print(
                            f"{pattern.id} · {pattern.surface_id}/{pattern.category} · "
                            f"{len({item.feature_id for item in pattern.evidence})} features"
                        )
                        for item in pattern.evidence[:5]:
                            print(f"  • {item.feature_id} · {item.path} · {item.message}")
                        suggestion = next(
                            (item for item in suggestions if item.pattern_id == pattern.id), None
                        )
                        if suggestion:
                            label = (
                                "Règle existante à mieux faire appliquer"
                                if suggestion.existing_rule_gap
                                else "Règle proposée"
                            )
                            print(f"  {label} : {suggestion.rule}")
                            print(f"  Limite : {suggestion.caveat}")
                selected = args.pattern or _prompt(
                    "Motif à transformer en proposition (Entrée = arrêter)", required=False
                )
                if not selected:
                    return 0
                selected_pattern = next((item for item in patterns if item.id == selected), None)
                if selected_pattern is None:
                    raise ValueError("unknown retro pattern")
                suggestion = next(
                    (item for item in suggestions if item.pattern_id == selected_pattern.id), None
                )
                if args.json and not args.rule:
                    raise ValueError("retro --pattern in JSON mode requires --rule")
                if args.rule:
                    rule = args.rule
                elif suggestion is not None and not suggestion.existing_rule_gap:
                    choice = _prompt("Adopter la règle proposée ? [o/N]", required=False)
                    rule = suggestion.rule if choice.casefold() in {"o", "oui", "y", "yes"} else ""
                else:
                    rule = ""
                rule = rule or _prompt("Règle concrète à proposer", required=False)
                if not rule:
                    print("Aucune règle proposée ; profil inchangé.")
                    return 0
                proposal = proposal_from_pattern(
                    selected_pattern, args.proposal_id or f"retro-{selected_pattern.id}", rule
                )
                args.output = args.output or (
                    args.data_dir / "retros" / f"{proposal.proposal_id}.json"
                )
            proposal_ref = database.put_artifact(
                "retro-proposal", proposal.model_dump_json(indent=2).encode()
            )
            subject_hash = hashlib.sha256(proposal.model_dump_json().encode()).hexdigest()
            request_id = database.create_request(
                retro_project_id,
                "retro-ratification",
                {
                    "proposal_id": proposal.proposal_id,
                    "rule": proposal.rule,
                    "proposal_ref": proposal_ref,
                },
                subject_hash,
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(proposal.model_dump_json(indent=2) + "\n")
            _emit(
                {
                    "output": str(args.output),
                    "proposal_ref": proposal_ref,
                    "ratification_request_id": request_id,
                    "proposal": proposal.model_dump(mode="json"),
                },
                args.json,
            )
        elif args.command == "retro-apply":
            from cohorte.application.maintenance import RetroProposal, ratify_retro
            from cohorte.domain.models import ArtifactRef, ProjectProfile

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            proposal = RetroProposal.model_validate_json(args.proposal.read_text())
            decision = database.get_approval(args.decision_id)
            request = database.get_request(decision["request_id"])
            expected_hash = hashlib.sha256(proposal.model_dump_json().encode()).hexdigest()
            if (
                request["kind"] != "retro-ratification"
                or request["subject_hash"] != expected_hash
                or decision["answer"] != {"approved": True}
            ):
                raise CohorteError(
                    ErrorCode.APPROVAL_REQUIRED,
                    "decision does not ratify this retro proposal",
                    "the project profile was not changed",
                    remediation="approve this proposal's pending ratification request",
                )
            ratified = ratify_retro(
                profile,
                proposal,
                ArtifactRef(
                    id=f"decision:{decision['id']}",
                    revision=1,
                    sha256=request["subject_hash"],
                ),
            )
            try:
                active_project = database.get_project(profile.project_id)
            except KeyError:
                profile_ref = database.put_artifact(
                    "project-profile",
                    ratified.profile_after.model_dump_json(indent=2).encode(),
                    artifact_id=f"profile:{profile.project_id}",
                )
            else:
                if active_project["profile"] != profile.model_dump(mode="json"):
                    raise ValueError("retro profile is stale; reload the active project profile")
                updated_document = ratified.profile_after.model_dump(mode="json")
                updated_document["revision"] = profile.revision
                saved = service.save_project_profile(
                    profile.project_id,
                    updated_document,
                    active_project["profile_ref"]["revision"],
                )
                profile_ref = cast(dict[str, Any], saved["profile_ref"])
                if saved["profile"] != ratified.profile_after.model_dump(mode="json"):
                    raise AssertionError(
                        "ratified convention was not applied to the active profile"
                    )
            args.output.write_text(ratified.profile_after.model_dump_json(indent=2) + "\n")
            _emit(
                {
                    "output": str(args.output),
                    "profile_ref": profile_ref,
                    "ratification": ratified.model_dump(mode="json"),
                },
                args.json,
            )
        elif args.command == "design-snapshot":
            from cohorte.application.context import DesignPort, FileDesignPort, capture_design
            from cohorte.domain.models import ProjectProfile

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            port: DesignPort | None
            if profile.integrations.design.provider == "file":
                port = FileDesignPort(args.repo)
            elif profile.integrations.design.provider == "figma":
                from cohorte.adapters.figma import FigmaDesignPort

                port = FigmaDesignPort()
            else:
                port = None
            capture = capture_design(profile.integrations.design, port)
            if capture.status == "blocked":
                raise CohorteError(
                    ErrorCode.DESIGN_UNAVAILABLE,
                    capture.error or "design integration is unavailable",
                    "design snapshot was not captured",
                    remediation="restore the configured design connection and retry",
                )
            capture_ref = database.put_artifact(
                "design-snapshot", capture.model_dump_json(indent=2).encode()
            )
            args.output.write_text(capture.model_dump_json(indent=2) + "\n")
            _emit(
                {
                    "output": str(args.output),
                    "snapshot_ref": capture_ref,
                    "snapshot": capture.model_dump(mode="json"),
                },
                args.json,
            )
        elif args.command == "retrieve":
            from cohorte.application.context import RetrievalPort, retrieve_context
            from cohorte.domain.models import ProjectProfile

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            retrieval_port: RetrievalPort | None
            if profile.integrations.retrieval.provider == "serena":
                from cohorte.adapters.serena import SerenaRetrievalPort

                retrieval_port = SerenaRetrievalPort(
                    args.repo, profile.integrations.retrieval.roots
                )
            elif profile.integrations.retrieval.provider == "graphify":
                from cohorte.adapters.graphify import GraphifyRetrievalPort

                retrieval_port = GraphifyRetrievalPort(
                    args.repo, profile.integrations.retrieval.roots
                )
            else:
                retrieval_port = None
            result = retrieve_context(
                args.repo,
                profile.integrations.retrieval,
                args.query,
                port=retrieval_port,
                limit=args.limit,
            )
            result_ref = database.put_artifact(
                "retrieval-snapshot", result.model_dump_json(indent=2).encode()
            )
            _emit(
                {
                    "result_ref": result_ref,
                    "result": result.model_dump(mode="json"),
                },
                args.json,
            )
        elif args.command == "align-ds-plan":
            from cohorte.application.context import (
                DesignPort,
                FileDesignPort,
                capture_design,
                plan_design_alignment,
            )
            from cohorte.domain.models import ProjectProfile

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            design = profile.integrations.design
            alignment_port: DesignPort | None
            if design.provider == "file":
                alignment_port = FileDesignPort(args.repo)
            elif design.provider == "figma":
                from cohorte.adapters.figma import FigmaDesignPort

                alignment_port = FigmaDesignPort()
            else:
                alignment_port = None
            capture = capture_design(design, alignment_port)
            plan = plan_design_alignment(args.repo, design, capture)
            if plan.status == "blocked":
                raise CohorteError(
                    ErrorCode.DESIGN_UNAVAILABLE,
                    plan.error or "design alignment inputs are unavailable",
                    "alignment plan was not created",
                    remediation="restore the design source and committed snapshot",
                )
            capture_ref = database.put_artifact(
                "design-snapshot", capture.model_dump_json(indent=2).encode()
            )
            plan_ref = database.put_artifact(
                "design-alignment-plan", plan.model_dump_json(indent=2).encode()
            )
            args.output.write_text(plan.model_dump_json(indent=2) + "\n")
            _emit(
                {
                    "output": str(args.output),
                    "capture_ref": capture_ref,
                    "plan_ref": plan_ref,
                    "plan": plan.model_dump(mode="json"),
                },
                args.json,
            )
        elif args.command == "align-ds-request":
            from cohorte.application.alignment import (
                AlignmentSelection,
                alignment_subject_hash,
            )

            alignment_selection = AlignmentSelection.model_validate_json(args.selection.read_text())
            subject_hash = alignment_subject_hash(alignment_selection)
            request_id = database.create_request(
                None,
                "design-alignment",
                {
                    "alignment_id": alignment_selection.alignment_id,
                    "plan_ref": alignment_selection.plan_ref.model_dump(mode="json"),
                    "write_paths": alignment_selection.write_paths,
                },
                subject_hash,
            )
            _emit(
                {"request_id": request_id, "subject_hash": subject_hash},
                args.json,
            )
        elif args.command == "align-ds":
            from cohorte.application.alignment import (
                AlignmentRunner,
                AlignmentSelection,
                alignment_feature,
                alignment_profile,
                alignment_subject_hash,
            )
            from cohorte.application.context import DesignAlignmentPlan
            from cohorte.domain.models import ProjectProfile, RunState, RunStatus, Stage

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            alignment_selection = AlignmentSelection.model_validate_json(args.selection.read_text())
            plan_artifact = database.get_artifact(
                alignment_selection.plan_ref.id, alignment_selection.plan_ref.revision
            )
            if plan_artifact["sha256"] != alignment_selection.plan_ref.sha256:
                raise CohorteError(
                    ErrorCode.ARTIFACT_CORRUPT,
                    "alignment plan reference hash does not match stored artifact",
                    "alignment was not started",
                    remediation="refresh the alignment plan reference",
                )
            plan = DesignAlignmentPlan.model_validate_json(plan_artifact["content"])
            if not alignment_selection.approval_ref.id.startswith("decision:"):
                raise CohorteError(
                    ErrorCode.APPROVAL_REQUIRED,
                    "alignment has no persisted approval decision",
                    "alignment was not started",
                    remediation="create and approve an alignment request",
                )
            approval = database.get_approval(
                alignment_selection.approval_ref.id.removeprefix("decision:")
            )
            request = database.get_request(approval["request_id"])
            subject_hash = alignment_subject_hash(alignment_selection)
            if (
                request["kind"] != "design-alignment"
                or request["subject_hash"] != subject_hash
                or approval["answer"] != {"approved": True}
                or alignment_selection.approval_ref.sha256 != subject_hash
            ):
                raise CohorteError(
                    ErrorCode.APPROVAL_REQUIRED,
                    "decision does not approve this exact alignment",
                    "alignment was not started",
                    remediation="approve the current alignment selection",
                )
            bounded_profile = alignment_profile(profile, alignment_selection)
            feature_spec = alignment_feature(alignment_selection, plan)
            profile_ref = database.put_artifact(
                "project-profile", bounded_profile.model_dump_json(indent=2).encode()
            )
            spec_ref = database.put_artifact(
                "alignment-spec", feature_spec.model_dump_json(indent=2).encode()
            )
            repository = args.repo.resolve(strict=True)
            database.ensure_project(profile.project_id, str(repository), profile_ref["id"])
            database.ensure_feature(
                feature_spec.feature_id,
                profile.project_id,
                feature_spec.title,
                kind="align-ds",
            )
            now = datetime.now(UTC)
            database.create_run(
                RunState(
                    id=args.run_id,
                    project_id=profile.project_id,
                    feature_id=feature_spec.feature_id,
                    stage=Stage.BUILD,
                    status=RunStatus.RUNNING,
                    state_version=1,
                    base_commit=GitRepository(repository).head,
                    created_at=now,
                    updated_at=now,
                )
            )
            worktree = args.worktrees.resolve() / f"{feature_spec.feature_id}-{args.run_id}"
            database.append_event(
                "run.context",
                {
                    "workflow": "align-ds",
                    "repository": str(repository),
                    "worktree_parent": str(args.worktrees.resolve()),
                    "worktree": str(worktree),
                    "profile_ref": profile_ref,
                    "spec_ref": spec_ref,
                },
                project_id=profile.project_id,
                run_id=args.run_id,
            )
            journal = SqliteRunJournal(database, args.run_id)
            try:
                alignment_result = AlignmentRunner(
                    workflow_runtime(
                        repository,
                        profile,
                        stop_requested=journal.stop_requested,
                        event_sink=journal.agent_event,
                    )
                ).run(
                    repository,
                    args.worktrees,
                    profile,
                    alignment_selection,
                    plan,
                    args.run_id,
                    observe=journal,
                )
            except RunStopped:
                _emit(database.get_run(args.run_id).model_dump(mode="json"), args.json)
                return 0
            except Exception as error:
                record_run_error(database, args.run_id, error)
                raise
            request_id = _create_ship_request(database, args.run_id, alignment_result.candidate)
            _emit({**asdict(alignment_result), "ship_request_id": request_id}, args.json)
        elif args.command == "kanban-project":
            from cohorte.application.kanban import (
                KanbanCard,
                apply_projection,
                plan_projection,
            )
            from cohorte.domain.models import ProjectProfile

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            kanban_plan = plan_projection(
                profile.integrations.kanban,
                KanbanCard(
                    feature_id=args.feature_id,
                    title=args.title,
                    state=args.state,
                    run_id=args.run_id,
                ),
            )
            if args.plan_only:
                _emit({"plan": kanban_plan.model_dump(mode="json")}, args.json)
            else:
                projection_result = apply_projection(profile.integrations.kanban, kanban_plan)
                durable = database.record_projection(
                    "obsidian-kanban",
                    args.feature_id,
                    args.state_version,
                    projection_result.status,
                    {
                        "board_path": projection_result.board_path,
                        "sha256": projection_result.sha256,
                        "run_id": args.run_id,
                        "state": args.state,
                    },
                )
                _emit(
                    {
                        "projection": projection_result.model_dump(mode="json"),
                        "durable": durable,
                    },
                    args.json,
                )
        elif args.command == "metrics":
            from cohorte.application.metrics import metrics_report

            if args.days < 1:
                raise ValueError("metrics days must be positive")
            until = datetime.now(UTC)
            report = metrics_report(
                database,
                project_id=args.project_id,
                since=until - timedelta(days=args.days),
                until=until,
                group_by=cast(Literal["project", "run", "phase", "provider"], args.group_by),
            )
            if args.json:
                _emit(report.model_dump(mode="json"), True)
            else:
                print(
                    f"Métriques · {report.project_id or 'tous les projets'} · "
                    f"{args.days} jours · groupement {report.group_by}"
                )
                print(
                    "Résultats : "
                    + (
                        ", ".join(f"{key}: {value}" for key, value in report.outcomes.items())
                        or "aucun run"
                    )
                )
                for metric in report.values:
                    rendered = metric.value if metric.value is not None else "indisponible"
                    print(f"  {metric.name} · {rendered} {metric.unit} · {metric.availability}")
                if report.groups:
                    print(f"Groupes : {', '.join(group.key for group in report.groups)}")
        elif args.command == "migrate":
            from cohorte.application.migration import (
                V2MigrationPlan,
                apply_v2_migration,
                plan_v2_migration,
                rollback_database,
            )

            if args.from_v2 is not None:
                if args.plan is None:
                    raise ValueError("migrate --from-v2 requires --plan OUTPUT")
                migration_plan = plan_v2_migration(args.from_v2)
                args.plan.parent.mkdir(parents=True, exist_ok=True)
                args.plan.write_text(migration_plan.model_dump_json(indent=2) + "\n")
                _emit(
                    {"plan": migration_plan.model_dump(mode="json"), "path": str(args.plan)},
                    args.json,
                )
            elif args.apply is not None:
                if args.plan is not None:
                    raise ValueError("--plan is only valid with --from-v2")
                migration_plan = V2MigrationPlan.model_validate_json(args.apply.read_text())
                backup_dir = args.backup_dir or (args.data_dir / "backups")
                migration_result = apply_v2_migration(database, migration_plan, backup_dir)
                _emit(migration_result.model_dump(mode="json"), args.json)
            else:
                if args.plan is not None or args.backup_dir is not None:
                    raise ValueError("--plan and --backup-dir are not valid with --rollback")
                safety = rollback_database(database, args.rollback)
                _emit(
                    {"restored_from": str(args.rollback), "safety_backup": str(safety)},
                    args.json,
                )
        elif args.command == "fleet":
            from cohorte.domain.models import FeatureSpec, ProjectProfile

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            specs = [FeatureSpec.model_validate_json(path.read_text()) for path in args.specs]
            fleet_result = FleetRunner(
                workflow_runtime(
                    args.repo,
                    profile,
                    event_sink=SqliteAgentEventSink(database.path, profile.project_id),
                )
            ).run(
                args.repo,
                args.worktrees,
                profile,
                specs,
                args.fleet_id,
            )
            _emit(asdict(fleet_result), args.json)
        elif args.command in {"fleet-plan", "fleet-status", "fleet-sync"}:
            from cohorte.application.fleet_control import (
                create_supervised_fleet,
                preview_supervised_fleet,
                supervised_fleet_status,
                sync_supervised_fleet,
            )

            if args.command == "fleet-plan":
                from cohorte.domain.models import FeatureSpec, ProjectProfile

                profile = ProjectProfile.model_validate_json(args.profile.read_text())
                specs = [FeatureSpec.model_validate_json(path.read_text()) for path in args.specs]
                manifest = args.data_dir / "fleets" / profile.project_id / f"{args.fleet_id}.json"
                if args.apply:
                    fleet_output = create_supervised_fleet(
                        args.repo,
                        args.worktrees,
                        manifest,
                        profile,
                        specs,
                        args.fleet_id,
                        profile_path=args.profile,
                        spec_paths=args.specs,
                    )
                else:
                    if manifest.exists():
                        raise ValueError("fleet already exists; inspect fleet-status")
                    fleet_output = preview_supervised_fleet(
                        args.repo,
                        args.worktrees,
                        profile,
                        specs,
                        args.fleet_id,
                        profile_path=args.profile,
                        spec_paths=args.specs,
                    )
            else:
                manifest = args.data_dir / "fleets" / args.project_id / f"{args.fleet_id}.json"
                if args.command == "fleet-status":
                    fleet_output = supervised_fleet_status(
                        manifest,
                        fetch=not args.no_fetch,
                        runs=database.list_runs(args.project_id),
                    )
                else:
                    from cohorte.domain.models import RunStatus

                    active_features = {
                        state.feature_id
                        for state in database.list_runs(args.project_id)
                        if state.status
                        not in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}
                    }
                    fleet_output = sync_supervised_fleet(
                        manifest, args.merged, apply=args.apply, active_features=active_features
                    )
            _emit_supervised_fleet(args.command, fleet_output, args.json, args.data_dir)
        elif args.command == "loop":
            from cohorte.domain.models import (
                FeatureSpec,
                ProjectProfile,
                RunState,
                RunStatus,
                Stage,
            )

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            spec = FeatureSpec.model_validate_json(args.spec.read_text())
            execution_repo = args.existing_worktree or args.repo
            if args.existing_worktree is not None:
                source_common = Path(
                    subprocess.run(
                        ["git", "rev-parse", "--git-common-dir"],
                        cwd=args.repo,
                        capture_output=True,
                        text=True,
                        check=True,
                    ).stdout.strip()
                )
                candidate_common = Path(
                    subprocess.run(
                        ["git", "rev-parse", "--git-common-dir"],
                        cwd=args.existing_worktree,
                        capture_output=True,
                        text=True,
                        check=True,
                    ).stdout.strip()
                )
                source_common = (args.repo / source_common).resolve()
                candidate_common = (args.existing_worktree / candidate_common).resolve()
                if source_common != candidate_common:
                    raise ValueError("existing worktree belongs to another repository")
                if GitRepository(execution_repo).is_dirty():
                    raise ValueError("existing worktree must be clean before starting a run")
            profile_ref = database.put_artifact(
                "project-profile", profile.model_dump_json(indent=2).encode()
            )
            spec_ref = database.put_artifact(
                "feature-spec", spec.model_dump_json(indent=2).encode()
            )
            database.ensure_project(
                profile.project_id, str(args.repo.resolve(strict=True)), profile_ref["id"]
            )
            database.ensure_feature(spec.feature_id, profile.project_id, spec.title)
            now = datetime.now(UTC)
            state = RunState(
                id=args.run_id,
                project_id=profile.project_id,
                feature_id=spec.feature_id,
                stage=Stage.BUILD,
                status=RunStatus.RUNNING,
                state_version=1,
                base_commit=GitRepository(execution_repo).head,
                created_at=now,
                updated_at=now,
            )
            database.create_run(state)
            worktree = (
                args.existing_worktree.resolve()
                if args.existing_worktree is not None
                else args.worktrees.resolve() / f"{spec.feature_id}-{args.run_id}"
            )
            database.append_event(
                "run.context",
                {
                    "repository": str(execution_repo.resolve(strict=True)),
                    "worktree_parent": str(args.worktrees.resolve()),
                    "worktree": str(worktree),
                    "profile_ref": profile_ref,
                    "spec_ref": spec_ref,
                },
                project_id=profile.project_id,
                run_id=args.run_id,
            )
            journal = SqliteRunJournal(database, args.run_id)
            runtime = workflow_runtime(
                execution_repo,
                profile,
                stop_requested=journal.stop_requested,
                event_sink=journal.agent_event,
            )
            try:
                loop_result: Any
                if len(spec.surfaces) > 1:
                    loop_result = MultiSurfaceRunner(runtime).run(
                        execution_repo,
                        args.worktrees,
                        profile,
                        spec,
                        args.run_id,
                        existing_worktree=args.existing_worktree,
                        observe=journal,
                        task_journal=SqliteTaskJournal(database, args.run_id),
                    )
                else:
                    loop_result = VerticalRunner(runtime).run(
                        execution_repo,
                        args.worktrees,
                        profile,
                        spec,
                        args.run_id,
                        existing_worktree=args.existing_worktree,
                        observe=journal,
                    )
            except RunStopped:
                _emit(database.get_run(args.run_id).model_dump(mode="json"), args.json)
                return 0
            except Exception as error:
                record_run_error(database, args.run_id, error)
                raise
            request_id = _create_ship_request(database, args.run_id, loop_result)
            _emit({**asdict(loop_result), "ship_request_id": request_id}, args.json)
        elif args.command == "resume":
            from cohorte.domain.models import FeatureSpec, ProjectProfile, RunStatus, Stage

            state = database.get_run(args.run_id)
            if state.stage == Stage.SHIP and state.status == RunStatus.WAITING_USER:
                _emit(state.model_dump(mode="json"), args.json)
                return 0
            if state.status not in {RunStatus.RUNNING, RunStatus.FAILED, RunStatus.PAUSED}:
                raise ValueError(f"run {args.run_id} cannot resume from {state.status.value}")
            context = database.latest_event(args.run_id, "run.context")["data"]
            profile_ref = context["profile_ref"]
            spec_ref = context["spec_ref"]
            profile_doc = database.get_artifact(profile_ref["id"], profile_ref["revision"])[
                "content"
            ]
            spec_doc = database.get_artifact(spec_ref["id"], spec_ref["revision"])["content"]
            profile = ProjectProfile.model_validate_json(profile_doc)
            spec = FeatureSpec.model_validate_json(spec_doc)
            if state.status != RunStatus.RUNNING:
                running = state.model_copy(
                    update={
                        "status": RunStatus.RUNNING,
                        "state_version": state.state_version + 1,
                        "updated_at": datetime.now(UTC),
                    }
                )
                database.update_run(
                    running, state.state_version, "run.resumed", {"from": state.status.value}
                )
                state = running
            repository = Path(context["repository"])
            worktree = Path(context["worktree"])
            journal = SqliteRunJournal(database, args.run_id)
            runtime = workflow_runtime(
                repository,
                profile,
                stop_requested=journal.stop_requested,
                event_sink=journal.agent_event,
            )
            try:
                resume_result: Any
                if len(spec.surfaces) > 1:
                    resume_result = MultiSurfaceRunner(runtime).run(
                        repository,
                        Path(context["worktree_parent"]),
                        profile,
                        spec,
                        args.run_id,
                        existing_worktree=worktree if worktree.exists() else None,
                        resume_stage=state.stage,
                        initial_fix_cycles=state.fix_cycles,
                        observe=journal,
                        task_journal=SqliteTaskJournal(database, args.run_id),
                    )
                else:
                    resume_result = VerticalRunner(runtime).run(
                        repository,
                        Path(context["worktree_parent"]),
                        profile,
                        spec,
                        args.run_id,
                        existing_worktree=worktree if worktree.exists() else None,
                        resume_stage=state.stage,
                        initial_fix_cycles=state.fix_cycles,
                        observe=journal,
                    )
            except RunStopped:
                _emit(database.get_run(args.run_id).model_dump(mode="json"), args.json)
                return 0
            except Exception as error:
                record_run_error(database, args.run_id, error)
                raise
            request_id = _create_ship_request(database, args.run_id, resume_result)
            _emit({**asdict(resume_result), "ship_request_id": request_id}, args.json)
        elif args.command == "pause":
            _emit(service.pause(args.run_id, args.reason).model_dump(mode="json"), args.json)
        elif args.command == "cancel":
            _emit(service.cancel(args.run_id, args.reason).model_dump(mode="json"), args.json)
        elif args.command in {"approve", "deny"}:
            request = database.get_request(args.request_id)
            approved = args.command == "approve"
            response_id = args.response_id or f"cli:{args.request_id}:{args.command}"
            decision_result = database.respond_request(
                args.request_id,
                response_id,
                {"approved": approved},
                request["subject_hash"],
            )
            _emit({**decision_result, "approved": approved}, args.json)
        elif args.command == "ship":
            from cohorte.domain.models import FeatureSpec, ProjectProfile, RunStatus, Stage

            state = database.get_run(args.run_id)
            if state.stage == Stage.DONE and state.status == RunStatus.COMPLETED:
                delivery = database.latest_event(args.run_id, "delivery.confirmed")["data"]
                _emit(delivery, args.json)
                return 0
            context = database.latest_event(args.run_id, "run.context")["data"]
            profile_ref = context["profile_ref"]
            spec_ref = context["spec_ref"]
            profile = ProjectProfile.model_validate_json(
                database.get_artifact(profile_ref["id"], profile_ref["revision"])["content"]
            )
            spec = FeatureSpec.model_validate_json(
                database.get_artifact(spec_ref["id"], spec_ref["revision"])["content"]
            )
            request = database.ship_request_for_run(args.run_id)
            branch = str(request["payload"]["branch"])
            worktree = Path(request["payload"]["worktree"])
            if profile.vcs.host == "github":
                provider: Any = GitHubProvider(worktree)
            elif profile.vcs.host == "gitlab":
                provider = GitLabProvider(worktree)
            else:
                raise ValueError("ship requires a github or gitlab project profile")
            body = (
                f"{spec.problem}\n\n"
                f"Validated Cohorte candidate: `{state.candidate_tree_hash}`\n\n"
                f"Acceptance criteria:\n"
                + "\n".join(f"- {item.statement}" for item in spec.acceptance)
            )
            notes = render_release_notes(
                profile.integrations.release_notes,
                title=spec.title,
                problem=spec.problem,
                acceptance=[item.statement for item in spec.acceptance],
            )
            if notes is not None:
                body += f"\n\n{notes}"
            delivery_result = ShipRunner(database, provider).run(
                state, profile, worktree, branch, spec.title, body
            )
            current = database.get_run(args.run_id)
            completed = current.model_copy(
                update={
                    "stage": Stage.DONE,
                    "status": RunStatus.COMPLETED,
                    "state_version": current.state_version + 1,
                    "updated_at": datetime.now(UTC),
                }
            )
            database.update_run(
                completed,
                current.state_version,
                "delivery.confirmed",
                delivery_result.model_dump(mode="json"),
            )
            _emit(delivery_result.model_dump(mode="json"), args.json)
        elif args.command == "delivery-status":
            from cohorte.application.delivery import DeliveryResult, DeliveryStatus
            from cohorte.domain.models import ProjectProfile

            context = database.latest_event(args.run_id, "run.context")["data"]
            profile_ref = context["profile_ref"]
            profile = ProjectProfile.model_validate_json(
                database.get_artifact(profile_ref["id"], profile_ref["revision"])["content"]
            )
            worktree = Path(context["worktree"])
            if profile.vcs.host == "github":
                status_provider: Any = GitHubProvider(worktree)
            elif profile.vcs.host == "gitlab":
                status_provider = GitLabProvider(worktree)
            else:
                raise ValueError("delivery status requires github or gitlab")
            document = database.latest_event(args.run_id, "delivery.confirmed")["data"]
            delivery = DeliveryResult.model_validate_json(json.dumps(document))
            deadline = time.monotonic() + max(0, args.timeout)
            while True:
                delivery = ShipRunner(database, status_provider).refresh(delivery)
                database.append_event(
                    "delivery.status",
                    delivery.model_dump(mode="json"),
                    run_id=args.run_id,
                )
                if (
                    not args.watch
                    or delivery.status in {DeliveryStatus.CI_PASSED, DeliveryStatus.CI_FAILED}
                    or time.monotonic() >= deadline
                ):
                    break
                time.sleep(5)
            _emit(delivery.model_dump(mode="json"), args.json)
        return 0
    except Exception as error:
        _fail(error, args.json)
    finally:
        database.close()


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
