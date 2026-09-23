from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from cohorte.application.intake import IntakeReport, IntakeTriage
from cohorte.application.patch import PatchSpec, RegressionMode, patch_profile
from cohorte.domain.models import ArtifactRef, ProjectProfile
from cohorte.persistence.sqlite import Database


def _ask(label: str, default: str = "") -> str:
    while True:
        response = input(f"{label}{f' [{default}]' if default else ''}: ").strip() or default
        if response:
            return response
        print("Une réponse est nécessaire.", file=sys.stderr)


def _split(value: str) -> list[str]:
    result = [item.strip() for item in value.split(",") if item.strip()]
    if len(result) != len(set(result)):
        raise ValueError("duplicate selection")
    return result


def guided_patch_spec(
    database: Database, project: dict[str, Any], data_dir: Path, feature_id: str
) -> tuple[PatchSpec, Path]:
    if not sys.stdin.isatty():
        raise ValueError("patch-spec --from-intake requires an interactive terminal")
    feature = database.get_feature(feature_id)
    if feature["project_id"] != project["id"]:
        raise ValueError("intake belongs to another project")
    source = database.latest_intake_report(feature_id)
    report = IntakeReport.model_validate_json(source["content"])
    if report.triage != IntakeTriage.PATCH:
        raise ValueError("intake must be routed to patch before patch-spec")
    profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
    output = data_dir / "guided" / project["id"] / feature_id / "patch.json"
    if output.exists():
        raise ValueError(f"patch spec already exists; review or edit it at {output}")
    answered = {item.question: item.answer for item in report.answers}
    reproduction_hint = next(
        (answer for question, answer in answered.items() if "reproduc" in question.lower()), ""
    )
    expected_hint = next(
        (answer for question, answer in answered.items() if "completion" in question.lower()), ""
    )
    print(f"Correctif · {report.title}")
    print(f"Source : {report.source_type.value} · {report.locator}")
    for item in profile.surfaces:
        print(f"Surface {item.id} : {', '.join(item.paths)}")
    reproduction = _ask("Étapes pour reproduire", reproduction_hint or report.content[:500])
    observed = _ask("Comportement observé", report.title)
    expected = _ask("Comportement attendu", expected_hint)
    surfaces = _split(_ask("Surfaces affectées (IDs séparés par des virgules)"))
    if not set(surfaces) <= {item.id for item in profile.surfaces}:
        raise ValueError("unknown patch surface")
    paths = _split(_ask("Chemins à modifier (séparés par des virgules)"))
    available_checks = list(
        dict.fromkeys(
            check for item in profile.surfaces if item.id in surfaces for check in item.check_ids
        )
    )
    if available_checks:
        print(f"Checks disponibles : {', '.join(available_checks)}")
        checks = _split(_ask("Check de régression (ID, ou 'manuel')", available_checks[0]))
    else:
        checks = _split(_ask("Check de régression (ID, ou 'manuel')", "manuel"))
    manual = checks == ["manuel"]
    if not manual and not set(checks) <= set(available_checks):
        raise ValueError("regression check must belong to the selected surfaces")
    scope = _ask("Correctif dans le périmètre", expected)
    rollback = _ask("Plan de retour arrière")
    document = PatchSpec(
        patch_id=feature_id,
        title=report.title,
        source_ref=ArtifactRef.model_validate(
            {key: source[key] for key in ("id", "revision", "sha256")}
        ),
        reproduction=reproduction,
        observed_behavior=observed,
        expected_behavior=expected,
        surfaces=surfaces,
        write_paths=paths,
        regression_mode=RegressionMode.MANUAL if manual else RegressionMode.AUTOMATIC,
        regression_check_ids=[] if manual else checks,
        in_scope=[scope],
        out_of_scope=[],
        rollback=rollback,
    )
    patch_profile(profile, document)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(document.model_dump_json(indent=2) + "\n")
    print(f"Patch préparé : {output}")
    print("Relisez le fichier et exécutez patch avec un run explicite.")
    return document, output
