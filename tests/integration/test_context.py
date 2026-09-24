from __future__ import annotations

import os
from pathlib import Path

import pytest

from cohorte.application.context import (
    FileDesignPort,
    RetrievalHit,
    capture_design,
    retrieve_context,
)
from cohorte.application.repository_context import collect_repository_context
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import DesignConfig, RetrievalConfig


class BrokenRetrievalPort:
    def search(self, query: str, limit: int) -> list[RetrievalHit]:
        raise RuntimeError("graph index offline; access_token=sk-fake-never-store")


class BrokenDesignPort:
    def fetch(self, source: str):
        raise RuntimeError("design service offline; access_token=sk-fake-never-store")


def test_disabled_design_is_explicitly_skipped() -> None:
    capture = capture_design(DesignConfig())
    assert capture.status == "skipped"
    assert capture.provider == "none"
    assert capture.content is None


def test_file_design_snapshot_captures_content_version_and_hash(
    tmp_path: Path,
) -> None:
    (tmp_path / "design.json").write_text('{"version":"tokens-v2","tokens":{"space-md":"16px"}}')
    capture = capture_design(
        DesignConfig(enabled=True, provider="file", source="design.json"),
        FileDesignPort(tmp_path),
    )
    assert capture.status == "captured"
    assert capture.version == "tokens-v2"
    assert capture.sha256 is not None
    assert capture.content == {"version": "tokens-v2", "tokens": {"space-md": "16px"}}


def test_external_design_failure_is_blocked_and_redacted() -> None:
    capture = capture_design(
        DesignConfig(enabled=True, provider="figma", source="design-id"),
        BrokenDesignPort(),
    )
    assert capture.status == "blocked"
    assert capture.provider == "figma"
    assert capture.content is None
    assert "design service offline" in (capture.error or "")
    assert "sk-fake-never-store" not in capture.model_dump_json()


def test_configured_retrieval_failure_is_visible_without_fallback(
    tmp_path: Path,
) -> None:
    with pytest.raises(CohorteError) as caught:
        retrieve_context(
            tmp_path,
            RetrievalConfig(provider="graphify", fallback_to_files=False),
            "needle",
            port=BrokenRetrievalPort(),
        )
    assert caught.value.code == ErrorCode.RETRIEVAL_UNAVAILABLE
    assert "graph index offline" in caught.value.message
    assert "sk-fake-never-store" not in caught.value.message


def test_explicit_retrieval_fallback_is_labeled_and_bounded(tmp_path: Path) -> None:
    (tmp_path / "module.py").write_text("def needle():\n    return 'found'\n")
    result = retrieve_context(
        tmp_path,
        RetrievalConfig(
            provider="serena",
            fallback_to_files=True,
            roots=["module.py"],
        ),
        "needle",
        port=BrokenRetrievalPort(),
    )
    assert result.status == "fallback"
    assert result.configured_provider == "serena"
    assert result.effective_provider == "files"
    assert result.fallback_reason is not None
    assert result.fallback_reason.startswith("graph index offline")
    assert "sk-fake-never-store" not in result.model_dump_json()
    assert result.hits[0].path == "module.py"


def test_disabled_retrieval_uses_file_search_without_claiming_fallback(
    tmp_path: Path,
) -> None:
    (tmp_path / "notes.txt").write_text("Design snapshot reference\n")
    result = retrieve_context(
        tmp_path,
        RetrievalConfig(provider="none", roots=["."]),
        "snapshot",
    )
    assert result.status == "ok"
    assert result.configured_provider == "none"
    assert result.effective_provider == "files"


def test_brainstorm_context_finds_cited_code_and_excludes_private_files(tmp_path: Path) -> None:
    source = tmp_path / "src" / "service"
    source.mkdir(parents=True)
    (source / "host.py").write_text(
        "def start_service():\n"
        "    current = service_status()\n"
        "    if current['running']:\n"
        "        return current\n"
        "    process = subprocess.Popen(['python', '-m', 'service'])\n"
    )
    (tmp_path / ".env").write_text("API_KEY=private-value\n")
    (source / "private_token.py").write_text("service_token=private-value\n")
    if os.name != "nt":
        outside = tmp_path.parent / f"{tmp_path.name}-outside.py"
        outside.write_text("def start_service(): return 'outside-private-value'\n")
        (source / "outside.py").symlink_to(outside)

    context = collect_repository_context(tmp_path, "service start should compare versions")

    assert "src/service/host.py:1: def start_service():" in context
    assert "subprocess.Popen" in context
    assert "private-value" not in context
    assert "outside-private-value" not in context
    assert len(context) <= 9000


def test_brainstorm_context_rechecks_changed_source_each_round(tmp_path: Path) -> None:
    source = tmp_path / "src"
    source.mkdir()
    module = source / "onboarding.py"
    module.write_text("def onboarding_step(): return 'first'\n")
    first = collect_repository_context(tmp_path, "onboarding step")
    module.write_text("def onboarding_step(): return 'second'\n")
    second = collect_repository_context(tmp_path, "onboarding step")

    assert "first" in first
    assert "second" in second
    assert "first" not in second


def test_repository_context_includes_nonstandard_surface_roots(tmp_path: Path) -> None:
    surface = tmp_path / "backend"
    surface.mkdir()
    (surface / "service.ts").write_text("export function restartService() { return 'ready'; }\n")

    context = collect_repository_context(tmp_path, "restart service")

    assert "backend/service.ts:1" in context
