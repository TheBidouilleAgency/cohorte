from __future__ import annotations

import json
from typing import Any, ClassVar

import pytest

from cohorte.adapters.figma import FigmaDesignPort
from cohorte.application.context import DesignDocument, capture_design
from cohorte.application.discovery import discover_project
from cohorte.cli import main as cli
from cohorte.domain.models import DesignConfig


class FakeResponse:
    def __init__(self, status: int, body: dict[str, Any]) -> None:
        self.status = status
        self.body = json.dumps(body).encode()

    def read(self, limit: int) -> bytes:
        return self.body[:limit]


class FakeConnection:
    requests: ClassVar[list[tuple[str, str, dict[str, str]]]] = []
    response = FakeResponse(200, {"version": "v12", "document": {"id": "0:0"}})

    def __init__(self, host: str, timeout: int) -> None:
        assert host == "api.figma.com"
        assert timeout == 20

    def request(self, method: str, path: str, headers: dict[str, str]) -> None:
        self.requests.append((method, path, headers))

    def getresponse(self) -> FakeResponse:
        return self.response

    def close(self) -> None:
        pass


def test_figma_capture_reads_versioned_node_snapshot_without_token_in_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeConnection.requests = []
    FakeConnection.response = FakeResponse(
        200, {"version": "v12", "document": {"id": "0:0", "children": [{"id": "1:2"}]}}
    )
    monkeypatch.setattr("cohorte.adapters.figma.http.client.HTTPSConnection", FakeConnection)
    config = DesignConfig(
        enabled=True,
        provider="figma",
        source="https://www.figma.com/design/AbCdEf123456/Design?node-id=1-2",
    )
    capture = capture_design(config, FigmaDesignPort(token="test-token-must-not-leak"))

    assert capture.status == "captured"
    assert capture.source == "AbCdEf123456?node-id=1:2"
    assert capture.version == "v12"
    assert capture.sha256 is not None
    assert FakeConnection.requests[0][1] == "/v1/files/AbCdEf123456?ids=1%3A2"
    assert "test-token-must-not-leak" not in capture.model_dump_json()


def test_figma_http_failure_blocks_without_leaking_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeConnection.response = FakeResponse(403, {"err": "token=secret-from-server"})
    monkeypatch.setattr("cohorte.adapters.figma.http.client.HTTPSConnection", FakeConnection)
    capture = capture_design(
        DesignConfig(enabled=True, provider="figma", source="AbCdEf123456"),
        FigmaDesignPort(token="test-token-must-not-leak"),
    )
    assert capture.status == "blocked"
    assert capture.error == "Figma file request failed with HTTP 403"
    assert "test-token-must-not-leak" not in capture.model_dump_json()
    assert "secret-from-server" not in capture.model_dump_json()


def test_figma_missing_token_stays_explicit_and_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FIGMA_ACCESS_TOKEN", raising=False)
    capture = capture_design(
        DesignConfig(enabled=True, provider="figma", source="AbCdEf123456"),
        FigmaDesignPort(),
    )
    assert capture.status == "blocked"
    assert capture.error == "Figma file connection requires FIGMA_ACCESS_TOKEN"


def test_figma_rejects_non_figma_url() -> None:
    with pytest.raises(ValueError, match="Figma HTTPS"):
        FigmaDesignPort(token="test").fetch("https://example.com/file/AbCdEf123456")


def test_align_ds_plan_uses_configured_figma_source(
    tmp_path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (tmp_path / "design-snapshot.json").write_text("{}")
    profile, _ = discover_project(tmp_path)
    document = profile.model_dump(mode="json")
    document["integrations"]["design"] = {
        "enabled": True,
        "provider": "figma",
        "source": "https://www.figma.com/design/AbCdEf123456/Design",
        "snapshot_path": "design-snapshot.json",
    }
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(document))
    monkeypatch.setattr(
        FigmaDesignPort,
        "fetch",
        lambda _self, _source: DesignDocument(
            provider="figma",
            source="AbCdEf123456",
            version="v2",
            content={"document": {"id": "1"}},
        ),
    )
    result = cli.run(
        [
            "--json",
            "--data-dir",
            str(tmp_path / "data"),
            "align-ds-plan",
            "--profile",
            str(profile_path),
            "--repo",
            str(tmp_path),
            "--output",
            str(tmp_path / "plan.json"),
        ]
    )
    assert result == 0
    assert json.loads(capsys.readouterr().out)["data"]["plan"]["status"] == "changes"
