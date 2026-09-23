from __future__ import annotations

import argparse
import hashlib
import json
import sys
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
from cohorte.application.delivery import ShipRunner
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
    sub.add_parser("doctor")
    init = sub.add_parser("init")
    init.add_argument("path", type=Path, nargs="?", default=Path.cwd())
    init.add_argument("--language", default="fr")
    status = sub.add_parser("status")
    status.add_argument("run", nargs="?")
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
    loop.add_argument("--run-id", required=True)
    loop.add_argument("--live", action="store_true", required=True)
    fleet = sub.add_parser("fleet")
    fleet.add_argument("specs", type=Path, nargs="+")
    fleet.add_argument("--profile", type=Path, required=True)
    fleet.add_argument("--repo", type=Path, default=Path.cwd())
    fleet.add_argument("--worktrees", type=Path, required=True)
    fleet.add_argument("--fleet-id", required=True)
    fleet.add_argument("--live", action="store_true", required=True)
    intake = sub.add_parser("intake")
    intake.add_argument("project_id")
    intake_source = intake.add_mutually_exclusive_group(required=True)
    intake_source.add_argument("--text")
    intake_source.add_argument("--file", type=Path)
    intake_source.add_argument("--url")
    intake.add_argument("--title")
    brainstorm = sub.add_parser("brainstorm")
    brainstorm.add_argument("project_id")
    brainstorm.add_argument("--feature-id", required=True)
    brainstorm.add_argument("--idea", required=True)
    brainstorm.add_argument("--context", default="")
    brainstorm.add_argument("--answer", action="append", required=True)
    brainstorm.add_argument("--prior-decision", action="append", default=[])
    brainstorm.add_argument("--perspective", action="append")
    brainstorm.add_argument("--repo", type=Path, default=Path.cwd())
    brainstorm.add_argument("--provider", choices=["claude", "codex"])
    brainstorm.add_argument("--output", type=Path)
    brainstorm.add_argument("--live", action="store_true", required=True)
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
    patch_spec.add_argument("--source-artifact-id", required=True)
    patch_spec.add_argument("--source-revision", type=int, required=True)
    patch_spec.add_argument("--profile", type=Path, required=True)
    patch_spec.add_argument("--patch-id", required=True)
    patch_spec.add_argument("--title", required=True)
    patch_spec.add_argument("--reproduction", required=True)
    patch_spec.add_argument("--observed", required=True)
    patch_spec.add_argument("--expected", required=True)
    patch_spec.add_argument("--surface", action="append", required=True)
    patch_spec.add_argument("--write-path", action="append", required=True)
    patch_spec.add_argument("--check", action="append", default=[])
    patch_spec.add_argument("--manual-regression", action="store_true")
    patch_spec.add_argument("--in-scope", action="append", required=True)
    patch_spec.add_argument("--out-of-scope", action="append", default=[])
    patch_spec.add_argument("--rollback", required=True)
    patch_spec.add_argument("--output", type=Path, required=True)
    patch = sub.add_parser("patch")
    patch.add_argument("spec", type=Path)
    patch.add_argument("--profile", type=Path, required=True)
    patch.add_argument("--repo", type=Path, default=Path.cwd())
    patch.add_argument("--worktrees", type=Path, required=True)
    patch.add_argument("--run-id", required=True)
    patch.add_argument("--live", action="store_true", required=True)
    audit = sub.add_parser("audit")
    audit.add_argument("--profile", type=Path, required=True)
    audit.add_argument("--repo", type=Path, default=Path.cwd())
    audit.add_argument("--audit-id", required=True)
    audit.add_argument("--title", required=True)
    audit.add_argument("--surface", action="append", required=True)
    audit.add_argument("--path", action="append", required=True)
    audit.add_argument("--concern", action="append", required=True)
    audit.add_argument("--output", type=Path, required=True)
    audit.add_argument("--live", action="store_true", required=True)
    refactor = sub.add_parser("refactor")
    refactor.add_argument("selection", type=Path)
    refactor.add_argument("--profile", type=Path, required=True)
    refactor.add_argument("--repo", type=Path, default=Path.cwd())
    refactor.add_argument("--worktrees", type=Path, required=True)
    refactor.add_argument("--run-id", required=True)
    refactor.add_argument("--live", action="store_true", required=True)
    refactor_request = sub.add_parser("refactor-request")
    refactor_request.add_argument("selection", type=Path)
    retro = sub.add_parser("retro")
    retro.add_argument("reports", type=Path, nargs="+")
    retro.add_argument("--proposal-id", required=True)
    retro.add_argument("--rule", required=True)
    retro.add_argument("--output", type=Path, required=True)
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
    claude = inspect_runtime("claude")
    codex = inspect_runtime("codex")
    return {
        **service.health(),
        "python_required": ">=3.12",
        "data_dir": str(args.data_dir),
        "config_dir": str(args.config_dir),
        "providers": [asdict(claude), asdict(codex)],
        "support_claim": "codex-bounded-live-align-local-integrations-migration-darwin-service-windows-ci-pipe",
        "next_validation": "Validate the external Francois client and Windows slow-client behavior, then complete the AC01-AC30 matrix.",
    }


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


def run(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    database = Database(args.data_dir / "cohorte.sqlite3")
    service = CohorteService(database)
    try:
        if args.command == "doctor":
            _emit(_doctor(service, args), args.json)
        elif args.command == "init":
            _emit(service.init_project(args.path, args.language), args.json)
        elif args.command == "status":
            if args.run:
                payload: Any = service.database.get_run(args.run).model_dump(mode="json")
            else:
                payload = {
                    "runs": [r.model_dump(mode="json") for r in service.database.list_runs()]
                }
            _emit(payload, args.json)
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
            from cohorte.application.intake import IntakeSourceType, load_intake_source

            if args.text is not None:
                source_type, value = IntakeSourceType.TEXT, args.text
            elif args.file is not None:
                source_type, value = IntakeSourceType.FILE, str(args.file)
            else:
                source_type, value = IntakeSourceType.URL, args.url
            source, locator = load_intake_source(source_type, value)
            _emit(
                service.intake(
                    args.project_id,
                    source,
                    args.title,
                    source_type=source_type,
                    locator=locator,
                ),
                args.json,
            )
        elif args.command == "brainstorm":
            from cohorte.application.preparation import BrainstormRunner, canonical_model_bytes
            from cohorte.domain.models import ProjectProfile

            project = database.get_project(args.project_id)
            repository = args.repo.resolve(strict=True)
            if Path(project["root_path"]).resolve() != repository:
                raise ValueError("brainstorm repository does not match the registered project")
            project_profile = (
                ProjectProfile.model_validate(project["profile"])
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
            brief = BrainstormRunner(brainstorm_runtime).run(
                repository,
                args.feature_id,
                args.idea,
                args.context,
                args.answer,
                args.prior_decision,
                args.perspective,
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
            _emit(payload, args.json)
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

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
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
            args.output.write_text(audit_report.model_dump_json(indent=2) + "\n")
            _emit(
                {
                    "output": str(args.output),
                    "report_ref": report_ref,
                    "report": audit_report.model_dump(mode="json"),
                },
                args.json,
            )
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
            if not selection.approval_ref.id.startswith("decision:"):
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

            reports = [
                AuditReport.model_validate_json(report.read_text()) for report in args.reports
            ]
            proposal = propose_retro(args.proposal_id, args.rule, reports)
            proposal_ref = database.put_artifact(
                "retro-proposal", proposal.model_dump_json(indent=2).encode()
            )
            subject_hash = hashlib.sha256(proposal.model_dump_json().encode()).hexdigest()
            request_id = database.create_request(
                None,
                "retro-ratification",
                {
                    "proposal_id": proposal.proposal_id,
                    "rule": proposal.rule,
                    "proposal_ref": proposal_ref,
                },
                subject_hash,
            )
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
            profile_ref = database.put_artifact(
                "project-profile",
                ratified.profile_after.model_dump_json(indent=2).encode(),
                artifact_id=f"profile:{profile.project_id}",
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
                FileDesignPort,
                capture_design,
                plan_design_alignment,
            )
            from cohorte.domain.models import ProjectProfile

            profile = ProjectProfile.model_validate_json(args.profile.read_text())
            design = profile.integrations.design
            port = FileDesignPort(args.repo) if design.provider == "file" else None
            capture = capture_design(design, port)
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
            _emit(report.model_dump(mode="json"), args.json)
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
                base_commit=GitRepository(args.repo).head,
                created_at=now,
                updated_at=now,
            )
            database.create_run(state)
            worktree = args.worktrees.resolve() / f"{spec.feature_id}-{args.run_id}"
            database.append_event(
                "run.context",
                {
                    "repository": str(args.repo.resolve(strict=True)),
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
                args.repo,
                profile,
                stop_requested=journal.stop_requested,
                event_sink=journal.agent_event,
            )
            try:
                loop_result: Any
                if len(spec.surfaces) > 1:
                    loop_result = MultiSurfaceRunner(runtime).run(
                        args.repo,
                        args.worktrees,
                        profile,
                        spec,
                        args.run_id,
                        observe=journal,
                        task_journal=SqliteTaskJournal(database, args.run_id),
                    )
                else:
                    loop_result = VerticalRunner(runtime).run(
                        args.repo,
                        args.worktrees,
                        profile,
                        spec,
                        args.run_id,
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
