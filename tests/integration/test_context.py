from __future__ import annotations

from pathlib import Path

import pytest

from cohorte.application.context import (
    FileDesignPort,
    RetrievalHit,
    capture_design,
    retrieve_context,
)
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import DesignConfig, RetrievalConfig


class BrokenRetrievalPort:
    def search(self, query: str, limit: int) -> list[RetrievalHit]:
        raise RuntimeError("graph index offline")


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
    assert result.fallback_reason == "graph index offline"
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
