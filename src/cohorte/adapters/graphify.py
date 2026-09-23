"""Read a prebuilt local Graphify-Labs graph through its MCP stdio server."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from cohorte.application.context import RetrievalHit
from cohorte.domain.redaction import redact_text

MAX_GRAPH_BYTES = 64 * 1024 * 1024
_NODE = re.compile(r"^NODE\s+(.+?)\s+\[src=(.*?)\s+loc=L(\d+)\b")


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _validate_graph(repository: Path, roots: list[str], graph_path: Path) -> None:
    resolved = graph_path.resolve(strict=True)
    if not _within(resolved, repository):
        raise ValueError("Graphify graph escapes repository")
    if resolved.stat().st_size > MAX_GRAPH_BYTES:
        raise ValueError("Graphify graph exceeds 64 MiB")
    allowed = [(repository / name).resolve(strict=True) for name in roots]
    if any(not _within(root, repository) for root in allowed):
        raise ValueError("Graphify retrieval root escapes repository")
    graph = json.loads(resolved.read_bytes())
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        raise ValueError("Graphify graph has no nodes")
    extracted = graph.get("extracted_sources", [])
    if not isinstance(extracted, list):
        raise ValueError("Graphify graph has invalid source references")
    for source in extracted:
        if not isinstance(source, str):
            raise ValueError("Graphify graph has invalid source references")
        path = (repository / source).resolve(strict=False)
        if not _within(path, repository) or not any(_within(path, root) for root in allowed):
            raise ValueError("Graphify graph contains a source outside retrieval roots")
    for node in graph["nodes"]:
        if not isinstance(node, dict):
            raise ValueError("Graphify graph has an invalid node")
        source = node.get("source_file")
        if not isinstance(source, str) or not source:
            continue
        path = (repository / source).resolve(strict=False)
        if not _within(path, repository) or not any(_within(path, root) for root in allowed):
            raise ValueError("Graphify graph contains a source outside retrieval roots")


def _parse_hits(
    content: list[Any], repository: Path, roots: list[str], limit: int
) -> list[RetrievalHit]:
    allowed = [(repository / name).resolve(strict=True) for name in roots]
    hits: list[RetrievalHit] = []
    seen: set[tuple[str, int]] = set()
    for block in content:
        raw = getattr(block, "text", None)
        if not isinstance(raw, str):
            continue
        for line in raw.splitlines():
            match = _NODE.match(line)
            if match is None:
                continue
            path = (repository / match.group(2)).resolve(strict=False)
            if not _within(path, repository) or not any(_within(path, root) for root in allowed):
                raise ValueError("Graphify returned a source outside retrieval roots")
            relative = path.relative_to(repository).as_posix()
            number = int(match.group(3))
            if (relative, number) in seen:
                continue
            seen.add((relative, number))
            hits.append(
                RetrievalHit(
                    path=relative,
                    line=number,
                    excerpt=redact_text(match.group(1)[:500]),
                )
            )
            if len(hits) >= limit:
                return hits
    return hits


class GraphifyRetrievalPort:
    def __init__(
        self, repository: Path, roots: list[str], *, python_executable: str | None = None
    ) -> None:
        self.repository = repository.resolve(strict=True)
        self.roots = roots
        self.python_executable = python_executable

    def search(self, query: str, limit: int) -> list[RetrievalHit]:
        if not 1 <= limit <= 100:
            raise ValueError("Graphify retrieval limit must be between 1 and 100")
        graph_path = self.repository / "graphify-out" / "graph.json"
        _validate_graph(self.repository, self.roots, graph_path)
        if self.python_executable is None and importlib.util.find_spec("graphify") is None:
            raise RuntimeError("Graphify retrieval requires the cohorte-local[graphify] extra")
        try:
            return asyncio.run(self._search_mcp(graph_path, query, limit))
        except Exception as error:
            if isinstance(error, RuntimeError):
                raise
            raise RuntimeError("Graphify MCP request failed") from error

    async def _search_mcp(self, graph_path: Path, query: str, limit: int) -> list[RetrievalHit]:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        env = dict(os.environ)
        for key in (
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_KEY",
            "MOONSHOT_API_KEY",
            "DEEPSEEK_API_KEY",
        ):
            env.pop(key, None)
        env["GRAPHIFY_QUERY_LOG_DISABLE"] = "1"
        params = StdioServerParameters(
            command=self.python_executable or sys.executable,
            args=["-m", "graphify.serve", str(graph_path)],
            cwd=str(self.repository),
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
                        "query_graph",
                        {"question": query, "mode": "bfs", "depth": 3, "token_budget": 2000},
                    )
                    if result.is_error:
                        raise RuntimeError("Graphify query tool rejected the request")
                    return _parse_hits(result.content, self.repository, self.roots, limit)

        try:
            return await asyncio.wait_for(call(), timeout=45)
        except TimeoutError as error:
            raise RuntimeError("Graphify query timed out") from error
