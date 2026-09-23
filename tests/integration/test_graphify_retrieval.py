from __future__ import annotations

import json
from pathlib import Path

import pytest

from cohorte.adapters.graphify import GraphifyRetrievalPort, _validate_graph
from cohorte.application.context import retrieve_context
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import RetrievalConfig


def _graph(repository: Path, source: str) -> None:
    directory = repository / "graphify-out"
    directory.mkdir()
    (directory / "graph.json").write_text(
        json.dumps({"nodes": [{"source_file": source}], "edges": []})
    )


def test_graph_rejects_sources_outside_configured_roots(tmp_path: Path) -> None:
    (tmp_path / "allowed.py").write_text("allowed")
    (tmp_path / "other.py").write_text("other")
    _graph(tmp_path, "other.py")

    with pytest.raises(ValueError, match="outside retrieval roots"):
        _validate_graph(
            tmp_path.resolve(), ["allowed.py"], tmp_path / "graphify-out" / "graph.json"
        )


def test_missing_graph_blocks_without_implicit_file_fallback(tmp_path: Path) -> None:
    (tmp_path / "module.py").write_text("def needle():\n    pass\n")
    port = GraphifyRetrievalPort(tmp_path, ["module.py"])

    with pytest.raises(CohorteError) as caught:
        retrieve_context(
            tmp_path,
            RetrievalConfig(provider="graphify", roots=["module.py"]),
            "needle",
            port=port,
        )
    assert caught.value.code == ErrorCode.RETRIEVAL_UNAVAILABLE

    result = retrieve_context(
        tmp_path,
        RetrievalConfig(provider="graphify", roots=["module.py"], fallback_to_files=True),
        "needle",
        port=port,
    )
    assert result.status == "fallback"
    assert result.effective_provider == "files"
    assert result.hits[0].path == "module.py"
