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
    feature_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$")
    title: str = Field(min_length=1, max_length=200, pattern=r"^[^\r\n]+$")
    state: str = Field(min_length=1)
    run_id: str | None = None
    source_id: str | None = None
    pr_number: int | None = Field(default=None, ge=1)


class KanbanIdea(StrictModel):
    title: str
    notes: list[str]
    feature_id: str | None = None
    source_id: str


_STAGE_COLUMNS = {
    "ideas": "Ideas",
    "brainstorm": "Brainstorm",
    "spec": "Spec",
    "ready": "Ready to build",
    "building": "Building",
    "review": "Review",
    "fix": "Fix",
    "ship": "Ship",
    "shipped": "Shipped",
}


def _ideas(content: str, digest: str, headings: set[str]) -> list[KanbanIdea]:
    inside = False
    cards: list[KanbanIdea] = []
    for line_number, line in enumerate(content.splitlines(), 1):
        heading = re.match(r"^##\s+(.+?)\s*$", line)
        if heading:
            inside = heading.group(1) in headings
            continue
        if re.match(r"^#{1,2}\s", line):
            inside = False
        if not inside:
            continue
        card = re.match(r"^-\s+(?:\[[ xX]\]\s*)?(.+?)\s*$", line)
        if card:
            title = card.group(1).strip()
            tag = re.search(r"(?:^|\s)#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b", title)
            cards.append(
                KanbanIdea(
                    title=title,
                    notes=[],
                    feature_id=tag.group(1) if tag else None,
                    source_id=f"{digest}:{line_number}",
                )
            )
            continue
        note = re.match(r"^[ \t]+(?:[-*]\s+)?(.+?)\s*$", line)
        if note and cards:
            cards[-1].notes.append(note.group(1).strip())
    return cards


def list_ideas(config: KanbanConfig) -> list[KanbanIdea]:
    """Read V2-style cards from the configured Obsidian Ideas column."""
    if not config.enabled:
        return []
    _, board, _ = _paths(config)
    try:
        raw = board.read_bytes()
    except OSError as error:
        raise CohorteError(
            ErrorCode.PROJECTION_UNAVAILABLE,
            str(error),
            "Obsidian ideas could not be read",
            remediation="restore the configured board file",
        ) from error
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Kanban board exceeds 2 MiB")
    configured = config.columns.get("ideas")
    headings = {configured} if configured else {"Idea", "Ideas"}
    return _ideas(raw.decode("utf-8"), _sha(raw), headings)


def resolve_idea(config: KanbanConfig, source_id: str) -> KanbanIdea:
    if len(source_id) > 80:
        raise ValueError("Obsidian idea source is invalid")
    matches = [idea for idea in list_ideas(config) if idea.source_id == source_id]
    if len(matches) != 1:
        raise ValueError("Obsidian idea changed; refresh the idea list")
    return matches[0]


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


def _card_blocks(lines: list[str]) -> list[tuple[int, int, str]]:
    """Return the half-open span and column of each Obsidian Kanban card."""
    blocks: list[tuple[int, int, str]] = []
    column = ""
    for index, line in enumerate(lines):
        if line.startswith("%% kanban:settings"):
            column = ""
        elif line.startswith("## "):
            column = line[3:].strip()
        if not column or not re.match(r"^-\s+(?:\[[ xX]\]\s*)?\S", line):
            continue
        end = index + 1
        while end < len(lines) and lines[end][:1] in {" ", "\t"}:
            end += 1
        blocks.append((index, end, column))
    return blocks


def _has_tag(line: str, feature_id: str) -> bool:
    return bool(re.search(rf"(?<![\w#])#{re.escape(feature_id)}(?![\w-])", line))


def _project(
    content: str,
    card: KanbanCard,
    column: str,
    source_digest: str,
    ideas_headings: set[str],
) -> str:
    content = _without_card(content, card.feature_id)
    lines = content.splitlines()
    blocks = _card_blocks(lines)
    target = column.casefold()
    if not any(line.startswith("## ") and line[3:].strip().casefold() == target for line in lines):
        raise ValueError(f'Kanban column "{column}" not found in configured board')

    tagged = [block for block in blocks if _has_tag(lines[block[0]], card.feature_id)]
    selected: tuple[int, int, str] | None = None
    if card.source_id is not None:
        digest, separator, number = card.source_id.partition(":")
        if separator and digest == source_digest and number.isdigit():
            selected = next((block for block in blocks if block[0] + 1 == int(number)), None)
            if selected is None or selected[2].casefold() not in ideas_headings:
                raise ValueError("selected Obsidian idea is no longer in Ideas")
        elif not tagged:
            # An unrelated board edit may move the line. Recover only when the
            # selected title still identifies a single Ideas card.
            matches = [
                block
                for block in blocks
                if block[2].casefold() in ideas_headings
                and re.match(r"^-\s+(?:\[[ xX]\]\s*)?(.+?)\s*$", lines[block[0]])
                and re.sub(r"^-\s+(?:\[[ xX]\]\s*)?", "", lines[block[0]]).strip() == card.title
            ]
            if len(matches) != 1:
                raise ValueError("Obsidian idea changed; refresh the idea list")
            selected = matches[0]
    selected = selected or (tagged[0] if tagged else None)
    if selected is not None:
        moved = lines[selected[0] : selected[1]]
        if not _has_tag(moved[0], card.feature_id):
            parsed = re.match(r"^-\s+(?:\[[ xX]\]\s*)?(.+?)\s*$", moved[0])
            if parsed is None or parsed.group(1).strip() != card.title:
                raise ValueError("selected Obsidian idea title changed")
            moved[0] = f"- [ ] {parsed.group(1).strip()}  #{card.feature_id}"
    else:
        moved = [f"- [ ] {card.title}  #{card.feature_id}"]
    if card.pr_number is not None and not re.search(r"\bPR #\d+\b", moved[0]):
        moved[0] += f" — PR #{card.pr_number}"

    removed = [block for block in blocks if block in tagged or block == selected]
    if (
        len(removed) == 1
        and selected is not None
        and selected[2].casefold() == target
        and moved == lines[selected[0] : selected[1]]
    ):
        return content
    skip = {index for start, end, _ in removed for index in range(start, end)}
    remaining = [line for index, line in enumerate(lines) if index not in skip]
    in_target = False
    insert_at: int | None = None
    for index, line in enumerate(remaining):
        if line.startswith("## "):
            if in_target:
                insert_at = index
                break
            in_target = line[3:].strip().casefold() == target
        elif in_target and line.startswith("%% kanban:settings"):
            insert_at = index
            break
    if insert_at is None:
        insert_at = len(remaining)
    before = remaining[:insert_at]
    after = remaining[insert_at:]
    if before and before[-1] != "":
        before.append("")
    before.extend(moved)
    if after and after[0] != "":
        before.append("")
    return "\n".join([*before, *after]).rstrip("\n") + "\n"


def plan_projection(config: KanbanConfig, card: KanbanCard) -> KanbanProjectionPlan:
    if not config.enabled or config.read_only:
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
    column = config.columns.get(card.state) or _STAGE_COLUMNS.get(card.state)
    if column is None:
        raise ValueError(f"no Kanban column configured for state {card.state}")
    configured_ideas = config.columns.get("ideas")
    ideas_headings = {configured_ideas.casefold()} if configured_ideas else {"idea", "ideas"}
    projected = _project(raw.decode("utf-8"), card, column, _sha(raw), ideas_headings)
    return KanbanProjectionPlan(
        status="ready",
        board_path=config.board_path,
        observed_sha256=_sha(raw),
        projected_sha256=_sha(projected.encode()),
        card=card,
        content=projected,
    )


def apply_projection(config: KanbanConfig, plan: KanbanProjectionPlan) -> KanbanProjectionResult:
    if plan.status == "skipped" or config.read_only:
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
