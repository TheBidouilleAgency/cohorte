from __future__ import annotations

import hashlib
import os
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import Field

from cohorte.domain.errors import CohorteError, ErrorCode
from cohorte.domain.models import KanbanConfig, StrictModel


class KanbanCard(StrictModel):
    feature_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=200)
    state: str = Field(min_length=1)
    run_id: str | None = None


class KanbanProjectionPlan(StrictModel):
    schema_version: Literal[1] = 1
    status: Literal["ready", "skipped"]
    board_path: str | None
    observed_sha256: str | None
    projected_sha256: str | None
    card: KanbanCard | None
    content: str | None


class KanbanProjectionResult(StrictModel):
    status: Literal["applied", "unchanged", "skipped"]
    board_path: str | None
    sha256: str | None
    backup_path: str | None


def _sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _paths(config: KanbanConfig) -> tuple[Path, Path, Path]:
    if not config.vault_path or not config.board_path:
        raise ValueError("Obsidian vault and board are not configured")
    vault = Path(config.vault_path).expanduser().resolve(strict=True)
    board = (vault / config.board_path).resolve()
    backup = (vault / config.backup_path).resolve()
    for path in (board, backup):
        if vault not in path.parents:
            raise ValueError("Kanban path escapes configured vault")
    return vault, board, backup


def _without_card(content: str, feature_id: str) -> str:
    escaped = re.escape(feature_id)
    pattern = re.compile(
        rf"\n?<!-- cohorte:feature:{escaped} -->.*?<!-- /cohorte:feature:{escaped} -->\n?",
        re.DOTALL,
    )
    return pattern.sub("\n", content)


def _project(content: str, card: KanbanCard, column: str) -> str:
    content = _without_card(content, card.feature_id)
    heading = f"## {column}"
    marker = f"<!-- cohorte:feature:{card.feature_id} -->"
    end = f"<!-- /cohorte:feature:{card.feature_id} -->"
    run = f" · run `{card.run_id}`" if card.run_id else ""
    block = f"{marker}\n- **{card.title}** · `{card.state}`{run}\n{end}\n"
    match = re.search(rf"(?m)^{re.escape(heading)}\s*$", content)
    if match is None:
        suffix = "" if content.endswith("\n") else "\n"
        return f"{content}{suffix}\n{heading}\n\n{block}"
    insert_at = match.end()
    prefix = content[:insert_at].rstrip("\n")
    suffix = content[insert_at:].lstrip("\n")
    return f"{prefix}\n\n{block}{suffix}"


def plan_projection(config: KanbanConfig, card: KanbanCard) -> KanbanProjectionPlan:
    if not config.enabled:
        return KanbanProjectionPlan(
            status="skipped",
            board_path=None,
            observed_sha256=None,
            projected_sha256=None,
            card=None,
            content=None,
        )
    _, board, _ = _paths(config)
    try:
        raw = board.read_bytes()
    except OSError as error:
        raise CohorteError(
            ErrorCode.PROJECTION_UNAVAILABLE,
            str(error),
            "Kanban projection was not planned",
            remediation="restore the configured board file",
        ) from error
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Kanban board exceeds 2 MiB")
    column = config.columns.get(card.state)
    if column is None:
        raise ValueError(f"no Kanban column configured for state {card.state}")
    projected = _project(raw.decode("utf-8"), card, column)
    return KanbanProjectionPlan(
        status="ready",
        board_path=config.board_path,
        observed_sha256=_sha(raw),
        projected_sha256=_sha(projected.encode()),
        card=card,
        content=projected,
    )


def apply_projection(config: KanbanConfig, plan: KanbanProjectionPlan) -> KanbanProjectionResult:
    if plan.status == "skipped":
        return KanbanProjectionResult(
            status="skipped", board_path=None, sha256=None, backup_path=None
        )
    vault, board, backup_root = _paths(config)
    current = board.read_bytes()
    if _sha(current) != plan.observed_sha256:
        raise CohorteError(
            ErrorCode.VERSION_CONFLICT,
            "Kanban board changed after projection planning",
            "projection was not written",
            remediation="refresh the board and create a new projection plan",
        )
    if plan.content is None or plan.projected_sha256 is None:
        raise ValueError("ready projection has no content")
    if _sha(current) == plan.projected_sha256:
        return KanbanProjectionResult(
            status="unchanged",
            board_path=config.board_path,
            sha256=plan.projected_sha256,
            backup_path=None,
        )
    backup_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    backup = backup_root / f"{hashlib.sha256(str(board).encode()).hexdigest()[:12]}-{timestamp}.md"
    shutil.copy2(board, backup)
    temporary = board.with_name(f".{board.name}.cohorte-{os.getpid()}.tmp")
    temporary.write_text(plan.content, encoding="utf-8", newline="\n")
    os.replace(temporary, board)
    return KanbanProjectionResult(
        status="applied",
        board_path=config.board_path,
        sha256=plan.projected_sha256,
        backup_path=backup.relative_to(vault).as_posix(),
    )
