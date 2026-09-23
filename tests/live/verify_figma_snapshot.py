"""Verify a real Figma file snapshot through the Cohorte CLI without printing content."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from cohorte.domain.redaction import redact_text


def _cli(base: Path, *args: str) -> dict[str, object]:
    process = subprocess.run(
        [
            sys.executable,
            "-m",
            "cohorte.cli.main",
            "--json",
            "--data-dir",
            str(base / "data"),
            *args,
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if process.returncode != 0:
        try:
            error = json.loads(process.stdout)["error"]
            detail = f"{error['code']}: {redact_text(str(error['message']))}"
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            detail = "Cohorte Figma snapshot CLI probe failed"
        raise RuntimeError(detail)
    return json.loads(process.stdout)["data"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Figma file or node URL, or file key")
    args = parser.parse_args()
    if not os.getenv("FIGMA_ACCESS_TOKEN"):
        if not sys.stdin.isatty():
            raise RuntimeError("FIGMA_ACCESS_TOKEN is unavailable")
        os.environ["FIGMA_ACCESS_TOKEN"] = getpass.getpass("Figma token: ")
    with tempfile.TemporaryDirectory(prefix="cohorte-ac23-figma-") as directory:
        base = Path(directory)
        repository = base / "project"
        repository.mkdir()
        (repository / "sample.py").write_text("def sample():\n    pass\n")
        profile = _cli(base, "init", str(repository))["profile"]
        if not isinstance(profile, dict):
            raise RuntimeError("Cohorte init returned no profile")
        profile["integrations"]["design"] = {
            "enabled": True,
            "provider": "figma",
            "source": args.source,
        }
        profile_path = base / "profile.json"
        profile_path.write_text(json.dumps(profile))
        result = _cli(
            base,
            "design-snapshot",
            "--profile",
            str(profile_path),
            "--repo",
            str(repository),
            "--output",
            str(base / "capture.json"),
        )["snapshot"]
        if (
            result["status"] != "captured"
            or result["provider"] != "figma"
            or not result["version"]
            or not result["sha256"]
        ):
            raise RuntimeError("Figma CLI did not capture a versioned design snapshot")
    print(json.dumps({"status": "passed", "provider": "figma", "cli_snapshot": True}))


if __name__ == "__main__":
    main()
