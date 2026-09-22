from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from cohorte import __version__
from cohorte.adapters.providers import inspect_runtime
from cohorte.application.metrics import metrics_report
from cohorte.application.service import CohorteService, git_head
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import EventType, Stage, WorkflowEvent
from cohorte.protocol.models import InitializeParams, RespondParams, RpcRequest

MAX_FRAME_BYTES = 1024 * 1024


class RpcServer:
    def __init__(
        self,
        service: CohorteService,
        shutdown: Callable[[], None] | None = None,
        connection_id: str = "stdio",
        live_events: bool | None = None,
    ) -> None:
        self.service = service
        self.shutdown = shutdown
        self.connection_id = connection_id
        self.live_events = shutdown is not None if live_events is None else live_events
        self.initialized = False

    def handle_line(self, line: bytes) -> bytes:
        request_id: str | int | None = None
        response: dict[str, Any]
        try:
            if len(line) > MAX_FRAME_BYTES:
                raise ValueError("frame exceeds 1 MiB")
            request = RpcRequest.model_validate_json(line)
            request_id = request.id
            result = self.dispatch(request.method, request.params)
            response = {"jsonrpc": "2.0", "id": request.id, "result": result}
        except (ValueError, ValidationError, json.JSONDecodeError) as error:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32602,
                    "message": "Invalid params",
                    "data": {
                        "code": "PROTOCOL_INVALID",
                        "message": str(error),
                        "impact": "request was not applied",
                        "retryable": False,
                        "remediation": "send a valid cohorte/1 JSON-RPC request",
                    },
                },
            }
        except CohorteError as error:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32000, "message": error.message, "data": error.as_data()},
            }
        except KeyError as error:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32601,
                    "message": "Not found",
                    "data": {
                        "code": "NOT_FOUND",
                        "message": str(error),
                        "impact": "request was not applied",
                        "retryable": False,
                        "remediation": "refresh resource identifiers",
                    },
                },
            }
        return (json.dumps(response, separators=(",", ":")) + "\n").encode()

    def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "initialize":
            data = InitializeParams.model_validate(params)
            if data.protocol_major != 1:
                raise CohorteError(
                    ErrorCode.PROTOCOL_INCOMPATIBLE,
                    "protocol major is unsupported",
                    "connection cannot continue",
                    remediation="use cohorte/1",
                )
            self.initialized = True
            return {
                "server_version": __version__,
                "protocol_major": 1,
                "protocol_minor": 0,
                "capabilities": [
                    "accounts.passive-status",
                    "events.replay",
                    *(["events.live"] if self.live_events else []),
                    "metrics.grouped",
                    "projects.read",
                    "requests.respond",
                    "runs.control",
                    "service.control" if self.shutdown is not None else "service.foreground",
                ],
                "connection_id": self.connection_id,
            }
        if not self.initialized:
            raise CohorteError(
                ErrorCode.PROTOCOL_INCOMPATIBLE,
                "initialize must be called first",
                "operation was rejected",
                remediation="perform the cohorte/1 handshake",
            )
        handlers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
            "health.get": lambda _: self.service.health(),
            "projects.list": self._projects_list,
            "projects.get": self._projects_get,
            "projects.init": self._projects_init,
            "accounts.list": self._accounts_list,
            "accounts.status": self._accounts_status,
            "features.list": self._features_list,
            "features.get": self._features_get,
            "runs.start": self._runs_start,
            "runs.get": self._runs_get,
            "runs.list": self._runs_list,
            "runs.pause": lambda p: self._transition(p, EventType.PAUSE),
            "runs.resume": lambda p: self._transition(p, EventType.RESUME),
            "runs.cancel": lambda p: self._transition(p, EventType.CANCEL),
            "events.subscribe": self._events,
            "events.unsubscribe": self._events_unsubscribe,
            "requests.list": self._requests_list,
            "requests.respond": self._respond,
            "artifacts.get": self._artifact,
            "metrics.get": self._metrics,
            "service.shutdown": self._service_shutdown,
        }
        handler = handlers.get(method)
        if handler is None:
            raise KeyError(method)
        return handler(params)

    def _dedupe(
        self, params: dict[str, Any], operation: Callable[[], dict[str, Any]]
    ) -> dict[str, Any]:
        request_id = str(params.get("request_id", ""))
        if not request_id:
            raise ValueError("mutating operation requires request_id")
        return self.service.database.deduplicated(request_id, params, operation)

    def _projects_init(self, params: dict[str, Any]) -> dict[str, Any]:
        return self._dedupe(params, lambda: self.service.init_project(Path(str(params["path"]))))

    def _projects_list(self, params: dict[str, Any]) -> dict[str, Any]:
        if params:
            unknown = set(params) - {"cursor"}
            if unknown:
                raise ValueError(f"unknown projects.list params: {sorted(unknown)}")
        return {"items": self.service.database.list_projects(), "cursor": None}

    def _projects_get(self, params: dict[str, Any]) -> dict[str, Any]:
        return self.service.database.get_project(str(params["project_id"]))

    @staticmethod
    def _account(provider: str) -> dict[str, Any]:
        if provider not in {"claude", "codex"}:
            raise ValueError("provider must be claude or codex")
        result = inspect_runtime(provider)  # type: ignore[arg-type]
        return {
            "account_id": f"native:{provider}:default",
            "provider": provider,
            "label": "Official client default context",
            "connection_state": result.connection_state,
            "effective_auth_mode": result.effective_auth_mode,
            "billing_evidence": result.billing_evidence,
            "runtime_version": result.runtime_version,
            "certified": result.certified,
        }

    def _accounts_list(self, params: dict[str, Any]) -> dict[str, Any]:
        provider = params.get("provider")
        providers = [str(provider)] if provider is not None else ["claude", "codex"]
        return {"items": [self._account(item) for item in providers], "cursor": None}

    def _accounts_status(self, params: dict[str, Any]) -> dict[str, Any]:
        account_id = str(params["account_id"])
        prefix = "native:"
        suffix = ":default"
        if not account_id.startswith(prefix) or not account_id.endswith(suffix):
            raise KeyError(account_id)
        return self._account(account_id[len(prefix) : -len(suffix)])

    def _features_list(self, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "items": self.service.database.list_features(str(params["project_id"])),
            "cursor": None,
        }

    def _features_get(self, params: dict[str, Any]) -> dict[str, Any]:
        return self.service.database.get_feature(str(params["feature_id"]))

    def _runs_start(self, params: dict[str, Any]) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            root = Path(str(params["path"]))
            state = self.service.start_run(
                str(params["project_id"]),
                str(params["feature_id"]),
                git_head(root),
                Stage(str(params.get("stage", "plan"))),
            )
            return {"run_id": state.id, "state_version": state.state_version}

        return self._dedupe(params, operation)

    def _runs_get(self, params: dict[str, Any]) -> dict[str, Any]:
        return self.service.database.get_run(str(params["run_id"])).model_dump(mode="json")

    def _runs_list(self, params: dict[str, Any]) -> dict[str, Any]:
        items = self.service.database.list_runs(params.get("project_id"))
        return {"items": [item.model_dump(mode="json") for item in items], "cursor": None}

    def _transition(self, params: dict[str, Any], event_type: EventType) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            current = self.service.database.get_run(str(params["run_id"]))
            expected = params.get("expected_version")
            if expected is not None and expected != current.state_version:
                raise CohorteError(
                    ErrorCode.VERSION_CONFLICT,
                    "run version is stale",
                    "action was rejected",
                    retryable=True,
                    remediation="refresh the run",
                )
            state, intents = self.service.transition(current.id, WorkflowEvent(type=event_type))
            return {
                "resource_id": state.id,
                "state_version": state.state_version,
                "data": state.model_dump(mode="json"),
                "intents": intents,
            }

        return self._dedupe(params, operation)

    def _events(self, params: dict[str, Any]) -> dict[str, Any]:
        items = self.service.database.events_after(
            int(params.get("after_seq", 0)),
            params.get("run_id"),
            project_id=params.get("project_id"),
        )
        watermark = items[-1]["seq"] if items else int(params.get("after_seq", 0))
        return {
            "subscription_id": f"{self.connection_id}:events",
            "watermark": watermark,
            "items": items,
        }

    def _events_unsubscribe(self, params: dict[str, Any]) -> dict[str, Any]:
        if params.get("subscription_id") != f"{self.connection_id}:events":
            raise KeyError(str(params.get("subscription_id")))
        return {"unsubscribed": True}

    def _requests_list(self, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "items": self.service.database.list_requests(
                params.get("run_id"), params.get("status")
            ),
            "cursor": None,
        }

    def _metrics(self, params: dict[str, Any]) -> dict[str, Any]:
        group_by = str(params.get("group_by", "project"))
        if group_by not in {"project", "run", "phase", "provider"}:
            raise ValueError("invalid metrics group_by")
        report = metrics_report(
            self.service.database,
            project_id=params.get("project_id"),
            since=datetime.fromisoformat(str(params["since"])),
            until=datetime.fromisoformat(str(params["until"])),
            group_by=group_by,  # type: ignore[arg-type]
        )
        return report.model_dump(mode="json")

    def _respond(self, params: dict[str, Any]) -> dict[str, Any]:
        data = RespondParams.model_validate(params)
        return self.service.database.respond_request(
            data.request_id, data.response_id, data.response, data.subject_hash
        )

    def _artifact(self, params: dict[str, Any]) -> dict[str, Any]:
        return self.service.database.get_artifact(
            str(params["id"]),
            int(params["revision"]),
            int(params.get("offset", 0)),
            int(params.get("limit", 65536)),
        )

    def _service_shutdown(self, params: dict[str, Any]) -> dict[str, Any]:
        if self.shutdown is None:
            raise CohorteError(
                ErrorCode.CAPABILITY_MISSING,
                "this connection does not own a persistent service",
                "shutdown was rejected",
                remediation="connect to the local Cohorte service",
            )

        def operation() -> dict[str, Any]:
            assert self.shutdown is not None
            self.shutdown()
            return {"accepted": True}

        return self._dedupe(params, operation)
