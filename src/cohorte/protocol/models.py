from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, model_validator

from cohorte.domain.models import StrictModel


class RpcRequest(StrictModel):
    jsonrpc: Literal["2.0"]
    id: str | int
    method: str = Field(min_length=1, max_length=200)
    params: dict[str, Any] = Field(default_factory=dict)


class InitializeParams(StrictModel):
    protocol_major: int
    protocol_minor: int
    client: dict[str, str]
    capabilities: list[str] = Field(default_factory=list)


class MutationParams(StrictModel):
    request_id: str = Field(min_length=1)
    expected_version: int | None = Field(default=None, ge=1)


class RespondParams(StrictModel):
    response_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    response: Any
    subject_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class EventEnvelope(StrictModel):
    event_id: str
    seq: int = Field(ge=1)
    schema_version: Literal[1] = 1
    project_id: str | None = None
    run_id: str | None = None
    task_id: str | None = None
    attempt_id: str | None = None
    type: str
    occurred_at: str
    data: dict[str, Any]

    @model_validator(mode="after")
    def known_type(self) -> EventEnvelope:
        if "." not in self.type:
            raise ValueError("event type must be namespaced")
        return self
