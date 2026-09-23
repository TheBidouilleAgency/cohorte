"""Bounded Serena MCP retrieval without writing project-local Serena state."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from cohorte.application.context import RetrievalHit
from cohorte.domain.redaction import redact_text

MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
MAX_SNAPSHOT_FILES = 1000
MAX_ANSWER_CHARS = 32 * 1024
_LINE = re.compile(r"^\s*>\s*(\d+):(.*)$")
_SKIP_DIRECTORIES = {
    ".git",
    ".serena",
    ".venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    "target",
}


def _copy_snapshot(repository: Path, roots: list[str], target: Path) -> None:
    copied_bytes = 0
    copied_files = 0
    for root_name in roots:
        root = repository / root_name
        resolved = root.resolve(strict=True)
        if resolved != repository and repository not in resolved.parents:
            raise ValueError("retrieval root escapes repository")
        paths = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in paths:
            if not path.is_file() or _SKIP_DIRECTORIES.intersection(
                path.relative_to(repository).parts
            ):
                continue
            resolved_path = path.resolve(strict=True)
            if repository not in resolved_path.parents:
                raise ValueError("retrieval file escapes repository")
            relative = path.relative_to(repository)
            if (target / relative).exists():
                continue
            size = resolved_path.stat().st_size
            copied_bytes += size
            copied_files += 1
            if copied_bytes > MAX_SNAPSHOT_BYTES or copied_files > MAX_SNAPSHOT_FILES:
                raise ValueError("Serena retrieval snapshot exceeds bounded file or byte limit")
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(resolved_path, destination)


def _parse_hits(content: list[Any], repository: Path, limit: int) -> list[RetrievalHit]:
    hits: list[RetrievalHit] = []
    for block in content:
        raw = getattr(block, "text", None)
        if not isinstance(raw, str):
            continue
        document = json.loads(raw)
        if not isinstance(document, dict):
            raise ValueError("Serena returned an invalid search document")
        for relative, lines in document.items():
            if not isinstance(relative, str) or not isinstance(lines, list):
                raise ValueError("Serena returned invalid search hits")
            path = (repository / relative).resolve(strict=False)
            if repository not in path.parents:
                raise ValueError("Serena returned a path outside the repository")
            for line in lines:
                match = _LINE.match(line) if isinstance(line, str) else None
                if match is None:
                    raise ValueError("Serena returned an invalid line reference")
                hits.append(
                    RetrievalHit(
                        path=path.relative_to(repository).as_posix(),
                        line=int(match.group(1)) + 1,
                        excerpt=redact_text(match.group(2).strip()[:500]),
                    )
                )
                if len(hits) >= limit:
                    return hits
    return hits


class SerenaRetrievalPort:
    def __init__(self, repository: Path, roots: list[str]) -> None:
        self.repository = repository.resolve(strict=True)
        self.roots = roots

    def search(self, query: str, limit: int) -> list[RetrievalHit]:
        executable = shutil.which("serena")
        if executable is None:
            raise RuntimeError("Serena MCP executable is unavailable")
        if not 1 <= limit <= 100:
            raise ValueError("Serena retrieval limit must be between 1 and 100")
        with tempfile.TemporaryDirectory(prefix="cohorte-serena-snapshot-") as directory:
            snapshot = (Path(directory) / "project").resolve()
            snapshot.mkdir()
            _copy_snapshot(self.repository, self.roots, snapshot)
            try:
                return asyncio.run(self._search_mcp(executable, snapshot, query, limit))
            except Exception as error:
                if isinstance(error, RuntimeError):
                    raise
                raise RuntimeError("Serena MCP request failed") from error

    async def _search_mcp(
        self, executable: str, snapshot: Path, query: str, limit: int
    ) -> list[RetrievalHit]:
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
        except ImportError as error:
            raise RuntimeError(
                "Serena retrieval requires the cohorte-engine[serena] extra"
            ) from error

        env = dict(os.environ)
        for key in (
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
        ):
            env.pop(key, None)
        env["SERENA_HOME"] = str(snapshot.parent / "serena-home")
        params = StdioServerParameters(
            command=executable,
            args=[
                "start-mcp-server",
                "--project",
                str(snapshot),
                "--transport",
                "stdio",
                "--enable-web-dashboard",
                "false",
                "--open-web-dashboard",
                "false",
                "--log-level",
                "ERROR",
            ],
            cwd=str(snapshot),
            env=env,
        )

        async def call() -> list[RetrievalHit]:
            with open(os.devnull, "w") as errors:
                async with (
                    stdio_client(params, errlog=errors) as (read, write),
                    ClientSession(read, write, read_timeout_seconds=20) as session,
                ):
                    await session.initialize()
                    result = await session.call_tool(
                        "search_for_pattern",
                        {
                            "substring_pattern": re.escape(query),
                            "relative_path": ".",
                            "restrict_search_to_code_files": False,
                            "max_answer_chars": MAX_ANSWER_CHARS,
                        },
                    )
                    if result.is_error:
                        raise RuntimeError("Serena search tool rejected the request")
                    return _parse_hits(result.content, snapshot, limit)

        try:
            return await asyncio.wait_for(call(), timeout=45)
        except TimeoutError as error:
            raise RuntimeError("Serena search timed out") from error
