from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import yaml  # type: ignore[import-untyped]
from pydantic import Field

from cohorte.domain.models import StrictModel
from cohorte.persistence.sqlite import Database

MigrationKind = Literal["pipeline", "config", "spec", "decision"]


class MigrationFile(StrictModel):
    path: str
    kind: MigrationKind
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size: int = Field(ge=0, le=2 * 1024 * 1024)
    historical: bool = True
    certified: bool = False
    requires_revalidation: bool = False


class MigrationMapping(StrictModel):
    source_path: str
    target_kind: str
    disposition: Literal["import", "exclude"]
    reason: str


class V2MigrationPlan(StrictModel):
    schema_version: Literal[1] = 1
    plan_id: str = Field(min_length=1)
    source_root: str
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    files: list[MigrationFile]
    mappings: list[MigrationMapping]
    excluded: list[str]
    losses: list[str]
    warnings: list[str]
    ambiguities: list[str]
    active_runs_imported: Literal[False] = False
    created_at: datetime


class MigrationResult(StrictModel):
    plan_id: str
    backup_path: str
    artifact_refs: list[dict[str, object]]
    imported_files: int
    active_runs_imported: Literal[False] = False
    rollback_verified: bool


_CANDIDATES: tuple[tuple[str, MigrationKind], ...] = (
    ("PIPELINE.md", "pipeline"),
    ("cohorte.config.yaml", "config"),
    ("cohorte.config.yml", "config"),
    (".cohorte/project.yaml", "config"),
    (".cohorte/project.yml", "config"),
)
_COLLECTIONS: tuple[tuple[str, MigrationKind], ...] = (
    ("specs", "spec"),
    (".cohorte/specs", "spec"),
    (".cohorte/decisions", "decision"),
)
_SECRET_NAMES = (
    ".env",
    ".cohorte/auth.json",
    ".cohorte/credentials.json",
    "auth.json",
)
_SECRET_KEYS = re.compile(r"(token|secret|password|api[_-]?key|credential)", re.I)
_SHELL_VALUE = re.compile(r"(&&|\|\||;|\$\()")


def _safe_file(root: Path, relative: str) -> Path:
    candidate = root / relative
    if candidate.is_symlink():
        raise ValueError(f"migration refuses symlink: {relative}")
    resolved = candidate.resolve(strict=True)
    if root not in resolved.parents:
        raise ValueError(f"migration path escapes source root: {relative}")
    if not resolved.is_file():
        raise ValueError(f"migration source is not a regular file: {relative}")
    return resolved


def _inspect_yaml(content: bytes, relative: str) -> tuple[bool, list[str]]:
    suffix = Path(relative).suffix
    yaml_content = content
    if suffix in {".md", ".markdown"} and content.startswith(b"---\n"):
        end = content.find(b"\n---\n", 4)
        if end < 0:
            return False, [f"{relative} has unterminated YAML frontmatter; imported as text"]
        yaml_content = content[4:end]
    elif suffix not in {".yaml", ".yml"}:
        return False, []
    parsed = yaml.safe_load(yaml_content)
    warnings: list[str] = []
    has_secret = False

    def walk(value: object, path: str = "") -> None:
        nonlocal has_secret
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = f"{path}.{key}" if path else str(key)
                if _SECRET_KEYS.search(str(key)):
                    has_secret = True
                walk(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{path}[{index}]")
        elif isinstance(value, str) and _SHELL_VALUE.search(value):
            warnings.append(f"{relative}:{path} contains a shell-like value; imported as data only")

    walk(parsed)
    return has_secret, warnings


def plan_v2_migration(source_root: Path) -> V2MigrationPlan:
    root = source_root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("V2 migration source must be a directory")
    discovered: list[tuple[str, MigrationKind]] = []
    for relative, kind in _CANDIDATES:
        if (root / relative).exists():
            discovered.append((relative, kind))
    for directory, kind in _COLLECTIONS:
        collection = root / directory
        if not collection.exists():
            continue
        if collection.is_symlink():
            raise ValueError(f"migration refuses symlink: {directory}")
        for path in sorted(collection.rglob("*")):
            if path.is_file() or path.is_symlink():
                discovered.append((path.relative_to(root).as_posix(), kind))
    excluded = [name for name in _SECRET_NAMES if (root / name).exists()]
    files: list[MigrationFile] = []
    mappings: list[MigrationMapping] = []
    warnings: list[str] = []
    digest = hashlib.sha256()
    for relative, raw_kind in sorted(set(discovered)):
        path = _safe_file(root, relative)
        content = path.read_bytes()
        if len(content) > 2 * 1024 * 1024:
            raise ValueError(f"migration file exceeds 2 MiB: {relative}")
        has_secret, file_warnings = _inspect_yaml(content, relative)
        warnings.extend(file_warnings)
        if has_secret:
            excluded.append(relative)
            warnings.append(f"{relative} excluded because it contains credential-like keys")
            mappings.append(
                MigrationMapping(
                    source_path=relative,
                    target_kind="none",
                    disposition="exclude",
                    reason="credential-like key detected",
                )
            )
            continue
        file_hash = hashlib.sha256(content).hexdigest()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(file_hash.encode())
        files.append(
            MigrationFile(
                path=relative,
                kind=raw_kind,
                sha256=file_hash,
                size=len(content),
                requires_revalidation=raw_kind == "spec",
            )
        )
        mappings.append(
            MigrationMapping(
                source_path=relative,
                target_kind=f"v2-historical-{raw_kind}",
                disposition="import",
                reason=(
                    "historical spec; new validators required before build"
                    if raw_kind == "spec"
                    else "historical non-certified metadata"
                ),
            )
        )
    for relative in excluded:
        if not any(mapping.source_path == relative for mapping in mappings):
            mappings.append(
                MigrationMapping(
                    source_path=relative,
                    target_kind="none",
                    disposition="exclude",
                    reason="credential file excluded by policy",
                )
            )
    ambiguities = []
    if not any(file.kind == "pipeline" for file in files):
        ambiguities.append("No PIPELINE.md was found.")
    if not files:
        ambiguities.append("No supported V2 metadata file was found.")
    source_hash = digest.hexdigest()
    return V2MigrationPlan(
        plan_id=f"v2-{source_hash[:16]}",
        source_root=str(root),
        source_hash=source_hash,
        files=files,
        mappings=sorted(mappings, key=lambda mapping: mapping.source_path),
        excluded=sorted(set(excluded)),
        losses=[
            "V2 active run and provider session state is not converted.",
            "Imported reports and metadata are historical and not certified by the V3 engine.",
            "V2 shell commands remain inert data and require explicit argv conversion.",
        ],
        warnings=warnings,
        ambiguities=ambiguities,
        created_at=datetime.now(UTC),
    )


def apply_v2_migration(
    database: Database, plan: V2MigrationPlan, backup_dir: Path
) -> MigrationResult:
    root = Path(plan.source_root).resolve(strict=True)
    payloads: list[tuple[str, str, bytes]] = []
    digest = hashlib.sha256()
    for item in plan.files:
        path = _safe_file(root, item.path)
        content = path.read_bytes()
        current_hash = hashlib.sha256(content).hexdigest()
        if current_hash != item.sha256:
            raise ValueError(f"migration source changed after planning: {item.path}")
        digest.update(item.path.encode())
        digest.update(b"\0")
        digest.update(current_hash.encode())
        payloads.append((item.path, f"v2-historical-{item.kind}", content))
    if digest.hexdigest() != plan.source_hash:
        raise ValueError("migration source hash changed after planning")
    backup = backup_dir.resolve() / (
        f"{database.path.name}.pre-v2-import-{datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ')}.bak"
    )
    database.backup(backup)
    refs = database.apply_import(plan.plan_id, plan.source_hash, str(backup), payloads)
    check = sqlite3.connect(backup)
    try:
        rollback_verified = check.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        check.close()
    return MigrationResult(
        plan_id=plan.plan_id,
        backup_path=str(backup),
        artifact_refs=refs,
        imported_files=len(payloads),
        rollback_verified=rollback_verified,
    )


def rollback_database(database: Database, backup_path: Path) -> Path:
    backup = backup_path.resolve(strict=True)
    check = sqlite3.connect(backup)
    try:
        if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("rollback backup failed integrity check")
    finally:
        check.close()
    database.close()
    safety = database.path.with_name(
        f"{database.path.name}.pre-rollback-{datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ')}.bak"
    )
    shutil.copy2(database.path, safety)
    temporary = database.path.with_name(f".{database.path.name}.rollback-{os.getpid()}.tmp")
    shutil.copy2(backup, temporary)
    os.replace(temporary, database.path)
    return safety
