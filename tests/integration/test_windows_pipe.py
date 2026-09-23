from __future__ import annotations

import os
from pathlib import Path

import pytest

from cohorte.service.host import service_status, start_service, stop_service
from cohorte.service.windows_pipe import current_user_sid, pipe_name


def test_windows_pipe_name_is_stable_and_local(tmp_path: Path) -> None:
    first = pipe_name(tmp_path)
    assert first == pipe_name(tmp_path)
    assert first.startswith(r"\\.\pipe\cohorte-")
    assert len(first) < 256


@pytest.mark.skipif(os.name != "nt", reason="Windows named-pipe test")
def test_windows_named_pipe_start_status_stop_uses_current_user_acl(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    assert current_user_sid().startswith("S-")
    try:
        started = start_service(data_dir)
        assert started["running"] is True
        assert started["transport"] == "windows-named-pipe"
        assert started["pipe"] == pipe_name(data_dir)
        assert service_status(data_dir)["health"]["database"]["ok"] is True
    finally:
        stopped = stop_service(data_dir)
    assert stopped == {"running": False, "stopped": True}
