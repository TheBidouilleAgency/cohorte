from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol, cast

from pydantic import Field

from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import DesignConfig, RetrievalConfig, StrictModel


class DesignDocument(StrictModel):
    provider: Literal["file", "figma"]
    source: str
    version: str = Field(min_length=1)
    content: dict[str, object]


class DesignCapture(StrictModel):
    schema_version: Literal[1] = 1
    status: Literal["captured", "skipped", "blocked"]
    provider: Literal["none", "file", "figma"]
    source: str | None
    version: str | None
    sha256: str | None
    captured_at: datetime
    content: dict[str, object] | None
    error: str | None


class DesignDelta(StrictModel):
    key: str = Field(min_length=1)
    source_value: object | None
    code_value: object | None
    change: Literal["add", "update", "remove"]


class DesignAlignmentPlan(StrictModel):
    schema_version: Literal[1] = 1
    status: Literal["aligned", "changes", "skipped", "blocked"]
    provider: Literal["none", "file", "figma"]
    source_version: str | None
    source_sha256: str | None
    snapshot_path: str | None
    snapshot_sha256: str | None
    deltas: list[DesignDelta]
    error: str | None


def _flatten(value: object, prefix: str = "") -> dict[str, object]:
    if isinstance(value, dict):
        result: dict[str, object] = {}
        for key in sorted(value):
            child = f"{prefix}.{key}" if prefix else str(key)
            result.update(_flatten(value[key], child))
        return result
    if isinstance(value, list):
        return {f"{prefix}[{index}]": item for index, item in enumerate(value)}
    return {prefix: value}


def plan_design_alignment(
    repository: Path,
    config: DesignConfig,
    capture: DesignCapture,
) -> DesignAlignmentPlan:
    if capture.status == "skipped":
        return DesignAlignmentPlan(
            status="skipped",
            provider="none",
            source_version=None,
            source_sha256=None,
            snapshot_path=None,
            snapshot_sha256=None,
            deltas=[],
            error=None,
        )
    if capture.status == "blocked":
        return DesignAlignmentPlan(
            status="blocked",
            provider=capture.provider,
            source_version=None,
            source_sha256=None,
            snapshot_path=config.snapshot_path,
            snapshot_sha256=None,
            deltas=[],
            error=capture.error,
        )
    if not config.snapshot_path:
        return DesignAlignmentPlan(
            status="blocked",
            provider=capture.provider,
            source_version=capture.version,
            source_sha256=capture.sha256,
            snapshot_path=None,
            snapshot_sha256=None,
            deltas=[],
            error="design snapshot_path is not configured",
        )
    root = repository.resolve(strict=True)
    try:
        snapshot = (root / config.snapshot_path).resolve(strict=True)
        if root not in snapshot.parents and snapshot != root:
            raise ValueError("design snapshot path escapes repository")
        raw = snapshot.read_bytes()
        code_content = json.loads(raw)
        if not isinstance(code_content, dict):
            raise ValueError("code design snapshot must contain a JSON object")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return DesignAlignmentPlan(
            status="blocked",
            provider=capture.provider,
            source_version=capture.version,
            source_sha256=capture.sha256,
            snapshot_path=config.snapshot_path,
            snapshot_sha256=None,
            deltas=[],
            error=str(error),
        )
    source = _flatten(capture.content or {})
    code = _flatten(code_content)
    deltas: list[DesignDelta] = []
    for key in sorted(set(source) | set(code)):
        if key not in code:
            deltas.append(
                DesignDelta(
                    key=key,
                    source_value=source[key],
                    code_value=None,
                    change="add",
                )
            )
        elif key not in source:
            deltas.append(
                DesignDelta(
                    key=key,
                    source_value=None,
                    code_value=code[key],
                    change="remove",
                )
            )
        elif source[key] != code[key]:
            deltas.append(
                DesignDelta(
                    key=key,
                    source_value=source[key],
                    code_value=code[key],
                    change="update",
                )
            )
    return DesignAlignmentPlan(
        status="changes" if deltas else "aligned",
        provider=capture.provider,
        source_version=capture.version,
        source_sha256=capture.sha256,
        snapshot_path=config.snapshot_path,
        snapshot_sha256=hashlib.sha256(raw).hexdigest(),
        deltas=deltas,
        error=None,
    )


class DesignPort(Protocol):
    def fetch(self, source: str) -> DesignDocument: ...


class FileDesignPort:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)

    def fetch(self, source: str) -> DesignDocument:
        candidate = (self.root / source).resolve(strict=True)
        if self.root not in candidate.parents and candidate != self.root:
            raise ValueError("design source escapes configured root")
        raw = candidate.read_bytes()
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("design source exceeds 2 MiB")
        content = json.loads(raw)
        if not isinstance(content, dict):
            raise ValueError("design source must contain a JSON object")
        version = str(content.get("version") or hashlib.sha256(raw).hexdigest()[:16])
        return DesignDocument(
            provider="file",
            source=source,
            version=version,
            content=content,
        )


def capture_design(config: DesignConfig, port: DesignPort | None = None) -> DesignCapture:
    now = datetime.now(UTC)
    if not config.enabled:
        return DesignCapture(
            status="skipped",
            provider="none",
            source=None,
            version=None,
            sha256=None,
            captured_at=now,
            content=None,
            error=None,
        )
    if port is None:
        return DesignCapture(
            status="blocked",
            provider=config.provider,
            source=config.source,
            version=None,
            sha256=None,
            captured_at=now,
            content=None,
            error=f"{config.provider} design connection is unavailable",
        )
    try:
        document = port.fetch(config.source or "")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return DesignCapture(
            status="blocked",
            provider=config.provider,
            source=config.source,
            version=None,
            sha256=None,
            captured_at=now,
            content=None,
            error=str(error),
        )
    if document.provider != config.provider:
        raise CohorteError(
            ErrorCode.DESIGN_UNAVAILABLE,
            "design adapter returned a different provider",
            "design snapshot was rejected",
            remediation="use the adapter configured by the project profile",
        )
    body = json.dumps(document.content, sort_keys=True, separators=(",", ":")).encode()
    return DesignCapture(
        status="captured",
        provider=document.provider,
        source=document.source,
        version=document.version,
        sha256=hashlib.sha256(body).hexdigest(),
        captured_at=now,
        content=document.content,
        error=None,
    )


class RetrievalHit(StrictModel):
    path: str
    line: int = Field(ge=1)
    excerpt: str


class RetrievalResult(StrictModel):
    schema_version: Literal[1] = 1
    query: str = Field(min_length=1)
    configured_provider: Literal["none", "files", "serena", "graphify"]
    effective_provider: Literal["files", "serena", "graphify"]
    status: Literal["ok", "fallback"]
    fallback_reason: str | None
    hits: list[RetrievalHit]
    captured_at: datetime


class RetrievalPort(Protocol):
    def search(self, query: str, limit: int) -> list[RetrievalHit]: ...


class FileRetrievalPort:
    def __init__(self, repository: Path, roots: list[str]) -> None:
        self.repository = repository.resolve(strict=True)
        self.roots = roots

    def search(self, query: str, limit: int) -> list[RetrievalHit]:
        needle = query.casefold()
        hits: list[RetrievalHit] = []
        inspected_bytes = 0
        for root_name in self.roots:
            root = (self.repository / root_name).resolve(strict=True)
            if self.repository not in root.parents and root != self.repository:
                raise ValueError("retrieval root escapes repository")
            paths = [root] if root.is_file() else sorted(root.rglob("*"))
            for path in paths:
                if len(hits) >= limit:
                    return hits
                if not path.is_file() or ".git" in path.parts:
                    continue
                try:
                    raw = path.read_bytes()
                except OSError:
                    continue
                inspected_bytes += len(raw)
                if inspected_bytes > 4 * 1024 * 1024:
                    return hits
                if b"\x00" in raw:
                    continue
                for number, line in enumerate(
                    raw.decode("utf-8", errors="replace").splitlines(), 1
                ):
                    if needle in line.casefold():
                        hits.append(
                            RetrievalHit(
                                path=path.relative_to(self.repository).as_posix(),
                                line=number,
                                excerpt=line[:500],
                            )
                        )
                        if len(hits) >= limit:
                            return hits
        return hits


def retrieve_context(
    repository: Path,
    config: RetrievalConfig,
    query: str,
    *,
    port: RetrievalPort | None = None,
    limit: int = 20,
) -> RetrievalResult:
    if not query.strip():
        raise ValueError("retrieval query cannot be blank")
    files = FileRetrievalPort(repository, config.roots)
    if config.provider in {"none", "files"}:
        return RetrievalResult(
            query=query,
            configured_provider=config.provider,
            effective_provider="files",
            status="ok",
            fallback_reason=None,
            hits=files.search(query, limit),
            captured_at=datetime.now(UTC),
        )
    if port is not None:
        try:
            return RetrievalResult(
                query=query,
                configured_provider=config.provider,
                effective_provider=cast(Literal["serena", "graphify"], config.provider),
                status="ok",
                fallback_reason=None,
                hits=port.search(query, limit),
                captured_at=datetime.now(UTC),
            )
        except (OSError, RuntimeError, ValueError) as error:
            failure = str(error)
    else:
        failure = f"{config.provider} retrieval connection is unavailable"
    if not config.fallback_to_files:
        raise CohorteError(
            ErrorCode.RETRIEVAL_UNAVAILABLE,
            failure,
            "configured retrieval produced no context",
            remediation="restore the configured provider or explicitly allow file fallback",
        )
    return RetrievalResult(
        query=query,
        configured_provider=config.provider,
        effective_provider="files",
        status="fallback",
        fallback_reason=failure,
        hits=files.search(query, limit),
        captured_at=datetime.now(UTC),
    )
