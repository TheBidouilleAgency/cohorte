"""Bounded, read-only context from a card's direct Obsidian wiki links."""

from __future__ import annotations

import os
import re
from pathlib import Path

_LINK = re.compile(r"\[\[([^\[\]\n]+)\]\]")
_MAX_ENTRIES = 10_000
_MAX_BYTES = 65_536
_MAX_CONTEXT = 6_000
_MAX_LINKS = 8


def _index(vault: Path) -> list[Path]:
    paths: list[Path] = []
    count = 0

    def failed(error: OSError) -> None:
        raise error

    for root, directories, files in os.walk(vault, followlinks=False, onerror=failed):
        count += len(directories) + len(files)
        if count > _MAX_ENTRIES:
            raise ValueError("index du vault trop volumineux")
        directories[:] = sorted(
            name
            for name in directories
            if not name.startswith(".") and not (Path(root) / name).is_symlink()
        )
        paths.extend(
            Path(root) / name
            for name in sorted(files)
            if not name.startswith(".")
            and name.lower().endswith(".md")
            and not (Path(root) / name).is_symlink()
        )
    return paths


def _resolve(target: str, vault: Path, board: Path, paths: list[Path]) -> Path:
    # Anchors select the linked note; include its bounded full text for context.
    name = target.split("|", 1)[0].split("#", 1)[0].strip()
    if not name:
        raise ValueError("lien sans nom de fiche")
    name = name.replace("\\", "/")
    relative = Path(name)
    if (
        relative.is_absolute()
        or ":" in name
        or any(part.startswith(".") for part in relative.parts)
    ):
        raise ValueError("chemin non autorisé")
    if relative.suffix and relative.suffix.lower() != ".md":
        raise ValueError("seules les fiches Markdown sont prises en charge")
    if relative.suffix.lower() != ".md":
        relative = Path(f"{name}.md")
    # Prefer a note beside the board, then a vault-relative path, then a unique suffix.
    for candidate in (board.parent / relative, vault / relative):
        if candidate in paths:
            return candidate
    matches = [
        p for p in paths if p.relative_to(vault).as_posix().endswith("/" + relative.as_posix())
    ]
    if len(matches) != 1:
        raise ValueError("fiche introuvable" if not matches else "lien ambigu : préciser le chemin")
    return matches[0]


def linked_context(vault: Path, board: Path, cards: list[tuple[str, list[str]]]) -> list[list[str]]:
    """Return additions to each card's notes, keeping wire format and board identity intact."""
    links = [
        list(dict.fromkeys(_LINK.findall("\n".join([title, *notes])))) for title, notes in cards
    ]
    if not any(links):
        return [[] for _ in cards]
    try:
        paths = _index(vault)
    except (OSError, ValueError):
        return [
            ["Obsidian : lecture des liens indisponible (index incomplet ou trop volumineux)."]
            if targets
            else []
            for targets in links
        ]
    results: list[list[str]] = []
    for targets in links:
        additions: list[str] = []
        seen: set[Path] = set()
        remaining = _MAX_CONTEXT
        for target in targets[:_MAX_LINKS]:
            try:
                path = _resolve(target, vault, board, paths)
                if path in seen:
                    continue
                seen.add(path)
                # Recheck confinement in case the filesystem changed since indexing.
                if path.resolve() != path or vault not in path.resolve().parents:
                    raise ValueError("chemin non autorisé")
                with path.open("rb") as stream:
                    raw = stream.read(_MAX_BYTES + 1)
                content = raw[:_MAX_BYTES].decode("utf-8", errors="replace")
                entry = f"Fiche Obsidian : {path.relative_to(vault).as_posix()}\n{content}"
                if len(raw) > _MAX_BYTES or len(entry) > remaining:
                    suffix = "\n[Contexte tronqué : limite de lecture des fiches Obsidian.]"
                    entry = entry[: max(0, remaining - len(suffix))] + suffix
                additions.append(entry)
                remaining -= len(entry)
                if remaining < 160:
                    if target != targets[-1]:
                        additions.append(
                            "Obsidian : autres liens omis, limite de contexte atteinte."
                        )
                    break
            except (OSError, ValueError) as error:
                reason = str(error) if isinstance(error, ValueError) else "fiche illisible"
                warning = f"Obsidian [[{target[:160]}]] : {reason}."
                additions.append(warning)
                remaining -= len(warning)
        if len(targets) > _MAX_LINKS:
            additions.append("Obsidian : seuls les 8 premiers liens directs sont lus.")
        results.append(additions)
    return results
