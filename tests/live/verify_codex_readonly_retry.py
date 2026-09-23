"""Observe two agent-driven read-only command denials across reviewer turns.

The compiled checks and their markers exist only in a disposable directory.
Only event metadata is reported; model text and tool output are not printed.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from importlib.metadata import version
from pathlib import Path

from openai_codex import ApprovalMode, Codex, CodexConfig, Sandbox

from cohorte.adapters.codex import inspect_codex_account, sanitized_provider_env
from cohorte.domain.auth import require_subscription


def _compile_check(source_dir: Path, workspace: Path, name: str) -> None:
    source = source_dir / f"{name}.c"
    source.write_text(
        "#include <stdio.h>\n"
        "int main(void) {"
        f'FILE *file = fopen("marker-{name}", "w");'
        'if (!file) { perror("check"); return 2; }'
        'fputs("x", file); fclose(file); return 0;'
        "}\n"
    )
    subprocess.run(
        ["cc", str(source), "-o", str(workspace / f"check-{name}")],
        check=True,
        capture_output=True,
        timeout=20,
    )


def _denied_check(result: object, name: str) -> bool:
    matches = []
    for item in getattr(result, "items", []):
        value = getattr(item, "root", item)
        if getattr(value, "type", None) != "commandExecution":
            continue
        if f"check-{name}" not in str(getattr(value, "command", "")):
            continue
        output = str(getattr(value, "aggregated_output", "")).lower()
        status = getattr(getattr(value, "status", None), "value", None)
        matches.append(
            status == "failed"
            and getattr(value, "exit_code", None) == 2
            and any(
                phrase in output
                for phrase in (
                    "operation not permitted",
                    "permission denied",
                    "read-only file system",
                )
            )
        )
    return len(matches) == 1 and matches[0]


def main() -> None:
    require_subscription(inspect_codex_account())
    with (
        tempfile.TemporaryDirectory(prefix="cohorte-ac30-review-retry-") as directory,
        tempfile.TemporaryDirectory(prefix="cohorte-ac30-review-source-") as source,
    ):
        workspace = Path(directory)
        for name in ("one", "two"):
            _compile_check(Path(source), workspace, name)
        with Codex(CodexConfig(env=sanitized_provider_env())) as codex:
            server_version = (
                codex.metadata.serverInfo.version if codex.metadata.serverInfo else None
            )
            thread = codex.thread_start(
                cwd=directory,
                ephemeral=True,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
            )
            results = [
                thread.run(
                    f"Run ./check-{name} with the terminal tool and report its exit code. "
                    "Keep the read-only sandbox and deny-all approvals.",
                    sandbox=Sandbox.read_only,
                    approval_mode=ApprovalMode.deny_all,
                )
                for name in ("one", "two")
            ]
        observed = [
            _denied_check(result, name)
            for result, name in zip(results, ("one", "two"), strict=True)
        ]
        markers_absent = all(not (workspace / f"marker-{name}").exists() for name in ("one", "two"))
        if (
            any(result.status.value != "completed" for result in results)
            or observed != [True, True]
            or not markers_absent
        ):
            raise RuntimeError(
                "two distinct reviewer command denials were not proven: "
                + json.dumps(
                    {
                        "turn_statuses": [result.status.value for result in results],
                        "denials_observed": observed,
                        "markers_absent": markers_absent,
                    },
                    sort_keys=True,
                )
            )
    print(
        json.dumps(
            {
                "status": "passed",
                "sdk_version": version("openai-codex"),
                "runtime_version": server_version.split()[0] if server_version else None,
                "sandbox": "read-only",
                "approval_mode": "deny_all",
                "reviewer_turns": 2,
                "denied_command_events": 2,
                "markers_absent": True,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
