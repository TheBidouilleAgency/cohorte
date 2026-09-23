from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from typing import Any, Literal

from cohorte.domain.errors import CohorteError

AgentEventSink = Callable[[str, dict[str, Any]], None]


def _tokens(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _cost(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if number >= 0 and math.isfinite(number):
            return number
    return None


class AgentEvents:
    """Emit bounded, content-free events with one shape for both SDKs."""

    def __init__(
        self,
        sink: AgentEventSink | None,
        provider: Literal["claude", "codex"],
        phase: str,
        read_only: bool,
    ) -> None:
        self.sink = sink
        self.base = {
            "provider": provider,
            "phase": phase,
            "access": "read_only" if read_only else "workspace_write",
        }

    def _emit(self, event_type: str, data: dict[str, Any]) -> None:
        if self.sink is not None:
            self.sink(event_type, {**self.base, **data})

    def started(self) -> None:
        self._emit("agent.turn.started", {})

    def finished(self, session_ref: str) -> None:
        self._emit("agent.turn.finished", {"status": "completed", "session_ref": session_ref})

    def failed(self, error: Exception) -> None:
        code = error.code.value if isinstance(error, CohorteError) else "PROVIDER_ERROR"
        self._emit("agent.turn.finished", {"status": "failed", "error_code": code})

    def stopped(self) -> None:
        self._emit("agent.turn.finished", {"status": "stopped"})

    def usage(
        self,
        *,
        input_tokens: object = None,
        output_tokens: object = None,
        cache_tokens: object = None,
        estimated_cost: object = None,
    ) -> None:
        self._emit(
            "agent.usage",
            {
                "input_tokens": _tokens(input_tokens),
                "output_tokens": _tokens(output_tokens),
                "cache_tokens": _tokens(cache_tokens),
                "estimated_cost": _cost(estimated_cost),
                "source": "sdk_reported",
            },
        )

    def tool(
        self,
        tool: str,
        *,
        decision: Literal["allow", "deny", "unknown"],
        outcome: Literal["completed", "failed", "denied", "unknown"],
        source: Literal["pre_tool_hook", "sdk_result"],
    ) -> None:
        self._emit(
            "agent.tool",
            {
                "tool": tool,
                "decision": decision,
                "outcome": outcome,
                "source": source,
                "count": 1,
            },
        )

    def permission_denials(self, count: int) -> None:
        if count > 0:
            self._emit(
                "agent.permission.denials",
                {"count": count, "source": "sdk_result"},
            )


def codex_usage(events: AgentEvents, usage: object) -> None:
    total = getattr(usage, "total", None)
    events.usage(
        input_tokens=getattr(total, "input_tokens", None),
        output_tokens=getattr(total, "output_tokens", None),
        cache_tokens=getattr(total, "cached_input_tokens", None),
    )


def claude_usage(events: AgentEvents, usage: object, cost: object) -> None:
    values = usage if isinstance(usage, Mapping) else {}
    events.usage(
        input_tokens=values.get("input_tokens"),
        output_tokens=values.get("output_tokens"),
        cache_tokens=values.get("cache_read_input_tokens"),
        estimated_cost=cost,
    )


def codex_tools(events: AgentEvents, items: object) -> None:
    if not isinstance(items, list):
        return
    categories = {
        "commandExecution": "command",
        "fileChange": "file_change",
        "mcpToolCall": "mcp",
        "dynamicToolCall": "dynamic",
    }
    denials = 0
    for item in items:
        value = getattr(item, "root", item)
        item_type = getattr(value, "type", None)
        category = categories.get(item_type) if isinstance(item_type, str) else None
        if category is None:
            continue
        status = getattr(value, "status", None)
        status = getattr(status, "value", status)
        if status == "declined":
            decision: Literal["allow", "deny", "unknown"] = "deny"
            outcome: Literal["completed", "failed", "denied", "unknown"] = "denied"
            denials += 1
        elif status in {"completed", "succeeded", "applied"}:
            decision, outcome = "unknown", "completed"
        elif status in {"failed", "error"}:
            decision, outcome = "unknown", "failed"
        else:
            decision, outcome = "unknown", "unknown"
        events.tool(
            category,
            decision=decision,
            outcome=outcome,
            source="sdk_result",
        )
    events.permission_denials(denials)
