from __future__ import annotations

import errno
import hashlib
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cohorte.domain.errors import ErrorCode
from cohorte.domain.models import CheckDefinition
from cohorte.domain.redaction import redact_text


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
    error_code: str | None = None
    environment_issue: str | None = None


_NETWORK_FAILURE = re.compile(
    r"network is unreachable|temporary failure in name resolution|could not resolve host|"
    r"name or service not known|connection timed out",
    re.IGNORECASE,
)
_CONTAINER_FAILURE = re.compile(
    r"cannot connect to the docker daemon|is the docker daemon running|"
    r"no such container|podman.*(?:unavailable|not running)",
    re.IGNORECASE,
)


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
        environment_issue: str | None = None
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
            decoded = raw.decode("utf-8", errors="replace")
            if result.returncode != 0 and _NETWORK_FAILURE.search(decoded):
                status, environment_issue = "errored", "network_unavailable"
            elif result.returncode != 0 and _CONTAINER_FAILURE.search(decoded):
                status, environment_issue = "errored", "container_unavailable"
        except FileNotFoundError as error:
            raw, status, exit_code = str(error).encode(), "errored", None
            executable = Path(definition.argv[0]).name.casefold()
            environment_issue = (
                "container_unavailable"
                if executable in {"docker", "podman"}
                else "dependency_missing"
            )
        except subprocess.TimeoutExpired as error:
            raw = (error.stdout or b"") + (error.stderr or b"")
            status, exit_code = "errored", None
            environment_issue = "check_timeout"
        except OSError as error:
            raw, status, exit_code = str(error).encode(), "errored", None
            environment_issue = "disk_full" if error.errno == errno.ENOSPC else "os_error"
        sanitized = redact_text(raw.decode("utf-8", errors="replace")).encode()
        truncated = len(sanitized) > self.output_limit
        sanitized = sanitized[: self.output_limit]
        return CheckExecution(
            definition.id,
            status,
            exit_code,
            started.isoformat(),
            datetime.now(UTC).isoformat(),
            digest,
            sanitized.decode("utf-8", errors="replace"),
            truncated,
            ErrorCode.CHECK_ENVIRONMENT.value if environment_issue else None,
            environment_issue,
        )
