"""Read-only, actionable project profile diagnostics."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from cohorte.application.discovery import discovery_report
from cohorte.domain.models import ProjectProfile


def inspect_project(root: Path, profile: ProjectProfile) -> dict[str, Any]:
    root = root.resolve(strict=True)
    findings: list[dict[str, str]] = []

    def report(code: str, status: str, message: str, fix: str) -> None:
        findings.append({"code": code, "status": status, "message": message, "fix": fix})

    for surface in profile.surfaces:
        for relative in surface.paths:
            if not (root / relative).exists():
                report(
                    "SURFACE_PATH_MISSING",
                    "error",
                    f"{surface.id}: {relative} is missing",
                    f"Run cohorte init . --refresh or correct surface {surface.id} in cohorte profile edit.",
                )
    for check in profile.checks:
        if not (root / check.cwd).is_dir():
            report(
                "CHECK_CWD_MISSING",
                "error",
                f"{check.id}: cwd {check.cwd} is missing",
                f"Correct check {check.id} with cohorte profile edit.",
            )
        if check.argv and shutil.which(check.argv[0]) is None:
            report(
                "CHECK_EXECUTABLE_MISSING",
                "warning",
                f"{check.id}: {check.argv[0]} is not on PATH",
                f"Install {check.argv[0]} or correct check {check.id} with cohorte profile edit.",
            )
    if profile.contract.enabled:
        for relative in profile.contract.paths:
            if not (root / relative).exists():
                report(
                    "CONTRACT_PATH_MISSING",
                    "error",
                    f"contract path {relative} is missing",
                    "Correct contract.paths with cohorte profile edit.",
                )
    design = profile.integrations.design
    if design.enabled:
        if design.provider == "file" and design.source and not (root / design.source).is_file():
            report(
                "DESIGN_SOURCE_MISSING",
                "error",
                f"design source {design.source} is missing",
                "Correct integrations.design.source with cohorte profile edit.",
            )
        if not design.snapshot_path or not (root / design.snapshot_path).is_file():
            report(
                "DESIGN_SNAPSHOT_MISSING",
                "error",
                "design snapshot is missing",
                "Set integrations.design.snapshot_path to a committed JSON file.",
            )
    signals = discovery_report(profile, [], root)["signals"]
    retrieval = profile.integrations.retrieval.provider
    if retrieval in {"serena", "graphify"} and not any(
        retrieval in source.casefold() for source in signals["retrieval"]
    ):
        report(
            "RETRIEVAL_SERVER_UNCONFIRMED",
            "warning",
            f"{retrieval} is selected but no matching project MCP server was detected",
            "Verify the MCP connection, or use cohorte profile edit to select files retrieval.",
        )
    if profile.execution.mode == "container" and not signals["isolation"]:
        report(
            "ISOLATION_CONFIG_MISSING",
            "warning",
            "container execution is selected but no container configuration was detected",
            "Add Docker or devcontainer configuration, or select local execution in cohorte profile edit.",
        )
    return {
        "project_id": profile.project_id,
        "root": str(root),
        "ok": not any(item["status"] == "error" for item in findings),
        "findings": findings,
        "surfaces": len(profile.surfaces),
        "checks": len(profile.checks),
        "signals": signals,
    }
