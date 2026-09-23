from __future__ import annotations

from types import SimpleNamespace

from cohorte.adapters.events import AgentEvents, codex_tools


def test_invalid_usage_is_unavailable_and_declined_tool_is_content_free() -> None:
    emitted: list[tuple[str, dict]] = []
    events = AgentEvents(lambda kind, data: emitted.append((kind, data)), "codex", "build", False)
    events.usage(
        input_tokens=True, output_tokens=-2, cache_tokens="12", estimated_cost=float("inf")
    )
    codex_tools(
        events,
        [
            SimpleNamespace(
                root=SimpleNamespace(
                    type="commandExecution",
                    status=SimpleNamespace(value="declined"),
                    command="PRIVATE_COMMAND",
                    aggregated_output="PRIVATE_OUTPUT",
                )
            )
        ],
    )

    assert emitted[0][1]["input_tokens"] is None
    assert emitted[0][1]["output_tokens"] is None
    assert emitted[0][1]["cache_tokens"] is None
    assert emitted[0][1]["estimated_cost"] is None
    assert emitted[1][0] == "agent.tool"
    assert emitted[1][1]["decision"] == "deny"
    assert emitted[2][0] == "agent.permission.denials"
    assert emitted[2][1]["count"] == 1
    assert "PRIVATE_" not in str(emitted)
