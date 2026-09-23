"""Probe Graphify-Labs local extraction and MCP retrieval through the Cohorte CLI."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path


def _run(command: list[str], *, env: dict[str, str]) -> str:
    process = subprocess.run(
        command, capture_output=True, text=True, timeout=60, check=False, env=env
    )
    if process.returncode != 0:
        raise RuntimeError("Graphify AC23 live probe subprocess failed")
    return process.stdout


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cohorte-ac23-graphify-") as directory:
        base = Path(directory)
        repository = base / "project"
        repository.mkdir()
        source = repository / "sample.py"
        original = "def ac23_needle():\n    return 23\n"
        source.write_text(original)
        env = dict(os.environ)
        for name in (
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_KEY",
            "MOONSHOT_API_KEY",
            "DEEPSEEK_API_KEY",
        ):
            env.pop(name, None)
        _run(
            [
                str(Path(sys.executable).with_name("graphify")),
                "extract",
                str(repository),
                "--code-only",
                "--no-cluster",
                "--out",
                str(repository),
            ],
            env=env,
        )

        def cli(*args: str) -> dict[str, object]:
            return json.loads(
                _run(
                    [
                        sys.executable,
                        "-m",
                        "cohorte.cli.main",
                        "--json",
                        "--data-dir",
                        str(base / "data"),
                        *args,
                    ],
                    env=env,
                )
            )["data"]

        profile = cli("init", str(repository))["profile"]
        if not isinstance(profile, dict):
            raise RuntimeError("Cohorte init returned no profile")
        profile["integrations"]["retrieval"] = {
            "provider": "graphify",
            "fallback_to_files": False,
            "roots": ["sample.py"],
        }
        profile_path = base / "profile.json"
        profile_path.write_text(json.dumps(profile))
        result = cli(
            "retrieve",
            "ac23_needle",
            "--profile",
            str(profile_path),
            "--repo",
            str(repository),
        )["result"]
        if (
            result["status"] != "ok"
            or result["effective_provider"] != "graphify"
            or not any(hit["path"] == "sample.py" and hit["line"] == 1 for hit in result["hits"])
            or source.read_text() != original
        ):
            raise RuntimeError("Graphify CLI retrieval did not return the expected source hit")
    print(
        json.dumps(
            {
                "status": "passed",
                "provider": "graphify-labs",
                "version": version("graphifyy"),
                "transport": "MCP stdio",
                "mode": "code-only extraction without model credentials",
                "cli_effective_provider": "graphify",
                "source_unchanged": True,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
