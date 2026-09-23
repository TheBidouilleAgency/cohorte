"""Probe the installed Serena MCP server against a disposable project."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from cohorte.adapters.serena import SerenaRetrievalPort
from cohorte.application.context import retrieve_context
from cohorte.domain.models import RetrievalConfig


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cohorte-ac23-serena-") as directory:
        base = Path(directory)
        repository = base / "project"
        repository.mkdir()
        (repository / "sample.py").write_text("def ac23_needle():\n    return 23\n")
        result = retrieve_context(
            repository,
            RetrievalConfig(provider="serena", roots=["."]),
            "ac23_needle",
            port=SerenaRetrievalPort(repository, ["."]),
        )
        expected = (
            result.status == "ok"
            and result.effective_provider == "serena"
            and len(result.hits) == 1
            and result.hits[0].path == "sample.py"
            and result.hits[0].line == 1
        )
        source_unchanged = sorted(path.name for path in repository.iterdir()) == ["sample.py"]
        if not expected or not source_unchanged:
            raise RuntimeError(
                "Serena retrieval did not return the expected hit without source writes"
            )

        def cli(*args: str) -> dict[str, object]:
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
                raise RuntimeError("Cohorte CLI retrieval probe failed")
            return json.loads(process.stdout)["data"]

        profile = cli("init", str(repository))["profile"]
        if not isinstance(profile, dict):
            raise RuntimeError("Cohorte init returned no project profile")
        profile["integrations"]["retrieval"] = {
            "provider": "serena",
            "fallback_to_files": False,
            "roots": ["sample.py"],
        }
        profile_path = base / "profile.json"
        profile_path.write_text(json.dumps(profile))
        cli_result = cli(
            "retrieve",
            "ac23_needle",
            "--profile",
            str(profile_path),
            "--repo",
            str(repository),
        )["result"]
        if cli_result["status"] != "ok" or cli_result["effective_provider"] != "serena":
            raise RuntimeError("Cohorte CLI did not use Serena retrieval")
    print(
        json.dumps(
            {
                "status": "passed",
                "provider": "serena",
                "transport": "MCP stdio",
                "result_path": "sample.py",
                "result_line": 1,
                "source_unchanged": True,
                "cli_effective_provider": "serena",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
