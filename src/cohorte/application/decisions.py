from __future__ import annotations

from datetime import date
from pathlib import Path


def decision_journal(repository: Path) -> Path:
    root = repository.resolve(strict=True)
    path = root / "specs" / "_decisions.md"
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("decision journal must not be a symlink")
    return path


def live_decisions(repository: Path) -> list[str]:
    path = decision_journal(repository)
    if not path.exists():
        return []
    section = ""
    decisions: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].strip().casefold()
        elif section == "live" and line.startswith("- "):
            decisions.append(line[2:].strip())
    return decisions


def add_live_decision(
    repository: Path, *, area: str, decision: str, reason: str, feature_id: str
) -> str:
    if any(not value.strip() or "\n" in value for value in (area, decision, reason, feature_id)):
        raise ValueError("decision fields must be non-empty single lines")
    path = decision_journal(repository)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = f"{date.today().isoformat()} · {area.strip()} · {decision.strip()} — because {reason.strip()} · {feature_id.strip()}"
    if entry in live_decisions(repository):
        return entry
    if path.exists():
        content = path.read_text(encoding="utf-8")
        lines = content.splitlines(keepends=True)
        live = next((index for index, line in enumerate(lines) if line.strip() == "## Live"), None)
        if live is None:
            raise ValueError("decision journal has no ## Live section")
        following = next(
            (index for index in range(live + 1, len(lines)) if lines[index].startswith("## ")),
            len(lines),
        )
        before = "".join(lines[:following]).rstrip()
        after = "".join(lines[following:])
        updated = before + f"\n- {entry}\n\n" + after
    else:
        updated = f"# Project decisions\n\n## Live\n\n- {entry}\n\n## Superseded\n"
    temporary = path.with_name("._decisions.md.cohorte.tmp")
    temporary.write_text(updated, encoding="utf-8")
    temporary.replace(path)
    return entry
