from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.release_meta import discord_payload, notify_discord, project_version, release_notes


def test_release_notes_match_exact_version_and_do_not_use_stale_notes() -> None:
    changelog = """# Changelog

## 0.1.0a3 — 2026-09-23

- Scoped Python preview.
- François UI proof still open.

## 0.1.0a2 — 2026-09-22

- Older notes.
"""
    assert release_notes("0.1.0a3", changelog) == (
        "- Scoped Python preview.\n- François UI proof still open.\n"
    )
    with pytest.raises(ValueError, match=r"0\.1\.0a4"):
        release_notes("0.1.0a4", changelog)


@pytest.mark.parametrize("notes", ["", "Some prose only", "- TODO: add release notes"])
def test_release_notes_reject_empty_or_placeholder_content(notes: str) -> None:
    with pytest.raises(ValueError):
        release_notes("0.1.0a3", f"## 0.1.0a3 — 2026-09-23\n\n{notes}\n")


def test_project_version_comes_from_python_metadata(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "1.0.0a1"\n')
    (tmp_path / "src/cohorte").mkdir(parents=True)
    (tmp_path / "src/cohorte/__init__.py").write_text('__version__ = "1.0.0a1"\n')
    assert project_version(tmp_path) == "1.0.0a1"


def test_release_rejects_runtime_version_drift(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "1.0.0a1"\n')
    (tmp_path / "src/cohorte").mkdir(parents=True)
    (tmp_path / "src/cohorte/__init__.py").write_text('__version__ = "0.1.0a2"\n')
    with pytest.raises(ValueError, match="runtime version"):
        project_version(tmp_path)


def test_discord_payload_uses_release_notes_and_link_without_webhook() -> None:
    with patch.dict("os.environ", {"DISCORD_FORUM_WEBHOOK": "secret"}):
        payload = json.loads(
            discord_payload("0.1.0a3", "- Scoped preview\n", "https://github.com/example/release")
        )
    assert payload["embeds"][0] == {
        "title": "Cohorte 0.1.0a3",
        "description": "- Scoped preview",
        "url": "https://github.com/example/release",
        "color": 3066993,
    }
    assert "secret" not in json.dumps(payload)


def test_discord_notification_targets_configured_thread_without_network() -> None:
    with (
        patch.dict(
            "os.environ",
            {
                "DISCORD_FORUM_WEBHOOK": "https://discord.com/api/webhooks/123/private",
                "DISCORD_THREAD_ID": "456",
            },
        ),
        patch("scripts.release_meta.urllib.request.urlopen") as open_url,
    ):
        open_url.return_value.__enter__.return_value.status = 200
        notify_discord("0.1.0a3", "- Preview\n", "https://github.com/example/release")
    request = open_url.call_args.args[0]
    assert parse_qs(urlsplit(request.full_url).query) == {"thread_id": ["456"], "wait": ["true"]}
    assert request.get_method() == "POST"
    assert json.loads(request.data)["embeds"][0]["description"] == "- Preview"
