"""Qualify direct Codex app-server command sandbox refusals on a live local runtime.

This does not certify agent-driven permission retries (AC30).
"""

from __future__ import annotations

import json
import tempfile
from importlib.metadata import version
from pathlib import Path
from uuid import uuid4

from openai_codex import Codex, CodexConfig
from openai_codex.generated.v2_all import CommandExecResponse

from cohorte.adapters.codex import inspect_codex_account, sanitized_provider_env
from cohorte.domain.auth import require_subscription


def main() -> None:
    require_subscription(inspect_codex_account())
    with tempfile.TemporaryDirectory(prefix="cohorte-ac30-runtime-") as directory:
        root = Path(directory)
        markers = [f"ac30-{uuid4().hex}" for _ in range(2)]
        commands = [
            ["touch", markers[0]],
            ["python3", "-c", f"from pathlib import Path; Path('{markers[1]}').write_text('x')"],
        ]
        exit_codes: list[int] = []
        with Codex(CodexConfig(env=sanitized_provider_env())) as codex:
            runtime_version = (
                codex.metadata.serverInfo.version.split()[0] if codex.metadata.serverInfo else None
            )
            for command in commands:
                result = codex._client.request(
                    "command/exec",
                    {
                        "command": command,
                        "cwd": directory,
                        "sandboxPolicy": {"type": "readOnly"},
                        "timeoutMs": 10_000,
                    },
                    response_model=CommandExecResponse,
                )
                denied = result.exit_code != 0 and any(
                    phrase in result.stderr.lower()
                    for phrase in (
                        "operation not permitted",
                        "permission denied",
                        "read-only file system",
                    )
                )
                if not denied:
                    raise RuntimeError("a read-only command was not denied by the runtime")
                exit_codes.append(result.exit_code)
        if any((root / marker).exists() for marker in markers):
            raise RuntimeError("a forbidden marker was created")
    print(
        json.dumps(
            {
                "status": "passed",
                "sdk_version": version("openai-codex"),
                "runtime_version": runtime_version,
                "sandbox": "readOnly",
                "command_exit_codes": exit_codes,
                "markers_absent": True,
                "agent_retry_verified": False,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
