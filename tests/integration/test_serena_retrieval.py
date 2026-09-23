from __future__ import annotations

from pathlib import Path

import pytest

from cohorte.adapters.serena import SerenaRetrievalPort, _copy_snapshot
from cohorte.application.context import retrieve_context
from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import RetrievalConfig


def test_snapshot_rejects_symlink_outside_repository(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("secret")
    (source / "outside.py").symlink_to(outside)
    destination = tmp_path / "snapshot"
    destination.mkdir()

    with pytest.raises(ValueError, match="escapes repository"):
        _copy_snapshot(source.resolve(), ["."], destination)
    assert not (destination / "outside.py").exists()


def test_unavailable_serena_requires_explicit_file_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "module.py").write_text("def ac23_needle():\n    pass\n")
    monkeypatch.setattr("cohorte.adapters.serena.shutil.which", lambda _: None)
    port = SerenaRetrievalPort(tmp_path, ["."])

    with pytest.raises(CohorteError) as caught:
        retrieve_context(
            tmp_path,
            RetrievalConfig(provider="serena", roots=["."]),
            "ac23_needle",
            port=port,
        )
    assert caught.value.code == ErrorCode.RETRIEVAL_UNAVAILABLE

    result = retrieve_context(
        tmp_path,
        RetrievalConfig(provider="serena", roots=["."], fallback_to_files=True),
        "ac23_needle",
        port=port,
    )
    assert result.status == "fallback"
    assert result.effective_provider == "files"
    assert result.hits[0].path == "module.py"
