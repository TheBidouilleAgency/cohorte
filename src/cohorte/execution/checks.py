from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cohorte.domain.models import CheckDefinition


@dataclass(frozen=True, slots=True)
class CheckExecution:
    check_id: str
    status: str
    exit_code: int | None
    started_at: str
    ended_at: str
    environment_digest: str
    output: str
    truncated: bool


class CheckRunner:
    def __init__(self, root: Path, output_limit: int = 256 * 1024) -> None:
        self.root = root.resolve(strict=True)
        self.output_limit = output_limit

    def run(self, definition: CheckDefinition) -> CheckExecution:
        cwd = (self.root / definition.cwd).resolve()
        if not cwd.is_relative_to(self.root) or not cwd.is_dir():
            raise ValueError("check cwd escapes project or does not exist")
        allowed = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"}
        }
        digest = hashlib.sha256(
            "\0".join(f"{k}={allowed[k]}" for k in sorted(allowed)).encode()
        ).hexdigest()
        started = datetime.now(UTC)
        try:
            result = subprocess.run(
                definition.argv,
                cwd=cwd,
                env=allowed,
                capture_output=True,
                timeout=definition.timeout_seconds,
            )
            raw = result.stdout + result.stderr
            status = "passed" if result.returncode == 0 else "failed"
            exit_code: int | None = result.returncode
        except FileNotFoundError as error:
            raw, status, exit_code = str(error).encode(), "errored", None
        except subprocess.TimeoutExpired as error:
            raw = (error.stdout or b"") + (error.stderr or b"")
            status, exit_code = "errored", None
        truncated = len(raw) > self.output_limit
        raw = raw[: self.output_limit]
        return CheckExecution(
            definition.id,
            status,
            exit_code,
            started.isoformat(),
            datetime.now(UTC).isoformat(),
            digest,
            raw.decode("utf-8", errors="replace"),
            truncated,
        )
