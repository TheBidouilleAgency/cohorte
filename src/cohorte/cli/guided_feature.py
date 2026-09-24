from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from cohorte.application.preparation import (
    BrainstormBrief,
    SpecFreezer,
    canonical_model_bytes,
    model_hash,
)
from cohorte.application.repository_context import collect_repository_context
from cohorte.domain.models import (
    ArtifactRef,
    Criterion,
    DefinitionOfDone,
    FeatureSpec,
    ProjectProfile,
    RequirementPlan,
    Scenario,
    SpecStatus,
)
from cohorte.persistence.sqlite import Database


def _ask(label: str, default: str = "", *, required: bool = True) -> str:
    while True:
        suffix = f" [{default}]" if default else ""
        answer = input(f"{label}{suffix}: ").strip() or default
        if answer or not required:
            return answer
        print("Une réponse est nécessaire.", file=sys.stderr)


def _yes(label: str) -> bool:
    return input(f"{label} (taper oui) : ").strip().lower() == "oui"


def _save(path: Path, document: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_bytes(document)
    temporary.replace(path)


def _feature_id(database: Database, project_id: str, supplied: str | None, status: str) -> str:
    if supplied:
        feature = database.get_feature(supplied)
        if feature["project_id"] != project_id:
            raise ValueError("feature belongs to another project")
        return supplied
    features = [item for item in database.list_features(project_id) if item["status"] == status]
    if not features:
        raise ValueError(f"no {status} feature in this project")
    print("Fonctionnalités :")
    for item in features:
        print(f"  {item['id']} · {item['title']}")
    selected = _ask("Identifiant", features[-1]["id"])
    if selected not in {item["id"] for item in features}:
        raise ValueError("unknown feature for this project")
    return selected


def _new_draft(
    brief: BrainstormBrief,
    brief_ref: ArtifactRef,
    profile: ProjectProfile,
    database: Database,
    repository: Path,
) -> FeatureSpec:
    synthesis = brief.synthesis
    print(f"\nIdée : {brief.idea}\nProblème : {synthesis.problem}")
    print(f"Piste du panel (pas une décision) : {synthesis.recommendation}")
    if synthesis.strong_objections:
        print("Objections :")
        for objection in synthesis.strong_objections:
            print(f"  • {objection}")
    current_context = collect_repository_context(repository, f"{brief.idea} {synthesis.problem}")
    references: list[str] = []
    seen_paths: set[str] = set()
    for context in (current_context, brief.project_context):
        for line in context.splitlines():
            match = re.match(r"^(.{1,240}):([1-9][0-9]{0,6}): ", line)
            if match is not None and match.group(1) not in seen_paths:
                seen_paths.add(match.group(1))
                references.append(f"{match.group(1)}:{match.group(2)}")
            if len(references) >= 6:
                break
    if references:
        print("Pistes du dépôt à vérifier avant de geler la spec :")
        for reference in references[:6]:
            print(f"  • {reference}")
    decisions: list[str] = []
    open_questions: list[str] = []
    for question in synthesis.blocking_questions:
        answer = _ask(f"{question} (Entrée = encore ouvert)", required=False)
        if answer:
            decisions.append(f"{question} {answer}")
        else:
            open_questions.append(question)
    print("Surfaces disponibles :")
    for surface in profile.surfaces:
        print(f"  {surface.id} · {', '.join(surface.paths)}")
    suggested_surface = profile.surfaces[0].id if len(profile.surfaces) == 1 else ""
    selected = _ask("Surfaces à modifier (IDs séparés par des virgules)", suggested_surface)
    surface_ids = [item.strip() for item in selected.split(",") if item.strip()]
    surfaces = {item.id: item for item in profile.surfaces}
    if (
        not surface_ids
        or len(surface_ids) != len(set(surface_ids))
        or not set(surface_ids) <= surfaces.keys()
    ):
        raise ValueError("choose distinct surface IDs from the stored profile")
    check_ids = list(
        dict.fromkeys(check for sid in surface_ids for check in surfaces[sid].check_ids)
    )
    contract_refs: list[ArtifactRef] = []
    if len(surface_ids) > 1:
        contract_path = Path(_ask("Chemin du contrat partagé dans le dépôt"))
        resolved = (repository / contract_path).resolve(strict=True)
        if not resolved.is_relative_to(repository) or not resolved.is_file():
            raise ValueError("contract must be a file in the registered repository")
        contract_refs.append(
            ArtifactRef.model_validate(database.put_artifact("contract", resolved.read_bytes()))
        )
    title = _ask("Titre", brief.idea[:200])
    problem = _ask("Problème à résoudre", synthesis.problem)
    scope = _ask("Résultat dans le périmètre", synthesis.in_scope[0] if synthesis.in_scope else "")
    outside = _ask(
        "Hors périmètre (facultatif)",
        synthesis.out_of_scope[0] if synthesis.out_of_scope else "",
        required=False,
    )
    given = _ask("Scénario — étant donné")
    when = _ask("Scénario — quand")
    then = _ask("Scénario — alors")
    scenarios = [Scenario(id="primary", given=given, when=when, then=then)]
    while _yes("Ajouter un autre scénario ?"):
        index = len(scenarios) + 1
        scenarios.append(
            Scenario(
                id=f"scenario-{index}",
                given=_ask(f"Scénario {index} — étant donné"),
                when=_ask(f"Scénario {index} — quand"),
                then=_ask(f"Scénario {index} — alors"),
            )
        )
    if synthesis.criterion_leads:
        print(f"Piste de critère du panel : {synthesis.criterion_leads[0]}")
    statement = _ask("Critère d'acceptation observable et vérifiable")
    if surfaces[surface_ids[0]].check_ids:
        print(f"Checks de {surface_ids[0]} : {', '.join(surfaces[surface_ids[0]].check_ids)}")
    check_id = _ask(
        "Check qui prouve ce critère (Entrée = revue)",
        required=False,
    )
    if check_id and check_id not in surfaces[surface_ids[0]].check_ids:
        raise ValueError("criterion check must belong to the chosen surface")
    acceptance = [
        Criterion(
            id="primary",
            statement=statement,
            verification="automatic" if check_id else "review",
            check_ids=[check_id] if check_id else [],
            surface_ids=[surface_ids[0]],
        )
    ]
    for surface_id in surface_ids[1:]:
        statement = _ask(f"Critère observable pour {surface_id}")
        print(f"Checks de {surface_id} : {', '.join(surfaces[surface_id].check_ids) or 'aucun'}")
        check_id = _ask("Check qui prouve ce critère (Entrée = revue)", required=False)
        if check_id and check_id not in surfaces[surface_id].check_ids:
            raise ValueError("criterion check must belong to the chosen surface")
        acceptance.append(
            Criterion(
                id=f"criterion-{surface_id}",
                statement=statement,
                verification="automatic" if check_id else "review",
                check_ids=[check_id] if check_id else [],
                surface_ids=[surface_id],
            )
        )
    while _yes("Ajouter un autre critère ?"):
        index = len(acceptance) + 1
        target = _ask("Surface du critère", surface_ids[0])
        if target not in surface_ids:
            raise ValueError("criterion surface must be in the selected scope")
        statement = _ask("Critère observable")
        check_id = _ask("Check qui prouve ce critère (Entrée = revue)", required=False)
        if check_id and check_id not in surfaces[target].check_ids:
            raise ValueError("criterion check must belong to the chosen surface")
        acceptance.append(
            Criterion(
                id=f"criterion-{index}",
                statement=statement,
                verification="automatic" if check_id else "review",
                check_ids=[check_id] if check_id else [],
                surface_ids=[target],
            )
        )
    test_strategy = _ask("Stratégie de test")
    error_case = _ask("Cas d'erreur à vérifier")
    migrations = _ask("Migration nécessaire ? Si non, indiquer pourquoi", "Aucune migration prévue")
    rollback = _ask("Plan de retour arrière")
    return FeatureSpec(
        feature_id=brief.feature_id,
        revision=1,
        status=SpecStatus.DRAFT,
        title=title,
        brief_ref=brief_ref,
        problem="\n".join([problem, *decisions]),
        in_scope=[scope],
        out_of_scope=[outside] if outside else [],
        surfaces=surface_ids,
        scenarios=scenarios,
        acceptance=acceptance,
        dod=DefinitionOfDone(required_checks=check_ids),
        test_strategy=[test_strategy],
        error_cases=[error_case],
        contract_refs=contract_refs,
        dependencies=[],
        migrations=RequirementPlan(
            required=migrations != "Aucune migration prévue", plan=migrations
        ),
        rollback=RequirementPlan(required=True, plan=rollback),
        design_refs=[],
        rbac_requirements=[],
        open_questions=open_questions,
    )


def guided_spec(
    database: Database,
    data_dir: Path,
    project: dict[str, Any],
    feature_id: str | None,
    refresh: bool,
) -> dict[str, Any]:
    if not sys.stdin.isatty():
        raise ValueError(
            "spec requires an interactive terminal; use spec-freeze-request for scripts"
        )
    selected = _feature_id(database, project["id"], feature_id, "draft")
    if database.get_feature(selected)["status"] == "frozen":
        raise ValueError("feature is already frozen; use cohorte start")
    profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
    repository = Path(project["root_path"]).resolve(strict=True)
    location = data_dir / "guided" / project["id"] / selected
    draft_path = location / "draft.json"
    if draft_path.exists() and not refresh:
        draft = FeatureSpec.model_validate_json(draft_path.read_text(encoding="utf-8"))
        print(f"Brouillon existant : {draft_path}")
        latest = database.latest_artifact(f"brief:{selected}")
        latest_ref = ArtifactRef.model_validate(
            {key: latest[key] for key in ("id", "revision", "sha256")}
        )
        if draft.brief_ref != latest_ref:
            print(
                f"Nouveau brief disponible : révision {latest_ref.revision}. "
                "Le brouillon reste inchangé tant que tu ne le rattaches pas."
            )
            if _yes("Rattacher ce brief en conservant le brouillon ?"):
                newer_brief = BrainstormBrief.model_validate_json(latest["content"])
                if newer_brief.feature_id != selected:
                    raise ValueError("newer brief belongs to another feature")
                newly_open = [
                    question
                    for question in newer_brief.synthesis.blocking_questions
                    if question not in draft.open_questions and question not in draft.problem
                ]
                draft = draft.model_copy(
                    update={
                        "brief_ref": latest_ref,
                        "open_questions": [*draft.open_questions, *newly_open],
                        "revision": draft.revision + 1,
                    }
                )
                print(f"Brief rattaché ; {len(newly_open)} nouvelle(s) question(s) à trancher.")
        if draft.open_questions:
            remaining: list[str] = []
            decisions: list[str] = []
            for question in draft.open_questions:
                answer = _ask(f"{question} (Entrée = encore ouvert)", required=False)
                if answer:
                    decisions.append(f"{question} {answer}")
                else:
                    remaining.append(question)
            draft = draft.model_copy(
                update={
                    "problem": "\n".join([draft.problem, *decisions]),
                    "open_questions": remaining,
                    "revision": draft.revision + (1 if decisions else 0),
                }
            )
    else:
        stored = database.latest_artifact(f"brief:{selected}")
        brief = BrainstormBrief.model_validate_json(stored["content"])
        if brief.feature_id != selected:
            raise ValueError("brief does not belong to the selected feature")
        brief_ref = ArtifactRef.model_validate(
            {key: stored[key] for key in ("id", "revision", "sha256")}
        )
        draft = _new_draft(brief, brief_ref, profile, database, repository)
        _save(draft_path, canonical_model_bytes(draft))
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR")
    if editor and _yes("Ouvrir le brouillon JSON dans l'éditeur pour le compléter ?"):
        if subprocess.run([*shlex.split(editor), str(draft_path)], check=False).returncode != 0:
            raise ValueError("spec editor exited with an error")
        draft = FeatureSpec.model_validate_json(draft_path.read_text(encoding="utf-8"))
    if draft.feature_id != selected or draft.status != SpecStatus.DRAFT:
        raise ValueError("edited draft must keep its feature ID and draft status")
    _save(draft_path, canonical_model_bytes(draft))
    database.put_artifact(
        "feature-spec-draft", canonical_model_bytes(draft), artifact_id=f"draft:{selected}"
    )
    print(f"\nSpec : {draft.title}\nProblème : {draft.problem}")
    print(f"Périmètre : {', '.join(draft.in_scope)}")
    print(f"Hors périmètre : {', '.join(draft.out_of_scope) or 'aucun'}")
    print(
        f"Surface : {', '.join(draft.surfaces)} · checks : {', '.join(draft.dod.required_checks)}"
    )
    for scenario in draft.scenarios:
        print(f"Scénario : {scenario.given} / {scenario.when} / {scenario.then}")
    for criterion in draft.acceptance:
        print(f"Critère ({criterion.verification}) : {criterion.statement}")
    print(f"Test : {'; '.join(draft.test_strategy)} · Erreur : {'; '.join(draft.error_cases)}")
    print(f"Migration : {draft.migrations.plan} · Retour arrière : {draft.rollback.plan}")
    print(f"Dépendances : {', '.join(draft.dependencies) or 'aucune'}")
    print(f"Design : {', '.join(draft.design_refs) or 'aucun'}")
    print(f"RBAC : {', '.join(draft.rbac_requirements) or 'aucune exigence'}")
    print(f"Validations manuelles : {', '.join(draft.dod.manual_validations) or 'aucune'}")
    if draft.open_questions:
        print("Questions encore ouvertes :")
        for question in draft.open_questions:
            print(f"  • {question}")
        print(f"Brouillon conservé : {draft_path}")
        return {"status": "draft", "draft": str(draft_path), "open_questions": draft.open_questions}
    prepared = SpecFreezer(database).prepare(draft, profile, repository_head(repository))
    print(f"Brouillon : {draft_path}")
    print(f"Profil approuvé : {profile.project_id} · révision {profile.revision}")
    print(f"Approbation exacte : spec {prepared.spec_hash} · profil {prepared.profile_hash}")
    previous_approval = database.approval_for_request(prepared.request_id)
    if previous_approval is not None:
        if previous_approval["answer"] != {"approved": True}:
            raise ValueError("the exact spec freeze request was denied")
        decision_id = previous_approval["id"]
        print("Approbation exacte déjà enregistrée ; reprise du gel.")
    else:
        if not _yes("Approuver cette spec et ce profil pour le gel ?"):
            return {"status": "draft", "draft": str(draft_path), "request_id": prepared.request_id}
        decision = database.respond_request(
            prepared.request_id, str(uuid4()), {"approved": True}, prepared.spec_hash
        )
        decision_id = decision["decision_id"]
    frozen = SpecFreezer(database).freeze(draft, profile, repository_head(repository), decision_id)
    spec_bytes = canonical_model_bytes(frozen.spec)
    profile_bytes = canonical_model_bytes(profile)
    spec_ref = database.put_artifact("feature-spec", spec_bytes, artifact_id=f"frozen:{selected}")
    profile_ref = database.put_artifact(
        "project-profile", profile_bytes, artifact_id=f"frozen-profile:{selected}"
    )
    database.put_artifact(
        "feature-ready",
        json.dumps({"spec_ref": spec_ref, "profile_ref": profile_ref}, sort_keys=True).encode(),
        artifact_id=f"ready:{selected}",
    )
    _save(location / "frozen.json", spec_bytes)
    _save(location / "profile.json", profile_bytes)
    database.set_feature_status(selected, "frozen")
    print(f"Spec gelée : {location / 'frozen.json'}")
    print(f"Prochaine étape : cohorte start {selected}")
    return {"status": "frozen", "feature_id": selected, "spec_ref": spec_ref}


def repository_head(repository: Path) -> str:
    from cohorte.adapters.git import GitRepository

    return GitRepository(repository).head


def guided_start(
    database: Database,
    data_dir: Path,
    project: dict[str, Any],
    feature_id: str | None,
) -> tuple[Path, Path, Path, str]:
    if not sys.stdin.isatty():
        raise ValueError("start requires an interactive terminal; use loop for scripts")
    selected = _feature_id(database, project["id"], feature_id, "frozen")
    if database.get_feature(selected)["status"] != "frozen":
        raise ValueError("feature is not frozen; run cohorte spec first")
    ready = database.latest_artifact(f"ready:{selected}")
    refs = json.loads(ready["content"])
    location = data_dir / "guided" / project["id"] / selected
    spec_path = location / "frozen.json"
    profile_path = location / "profile.json"
    spec_ref = ArtifactRef.model_validate(refs["spec_ref"])
    profile_ref = ArtifactRef.model_validate(refs["profile_ref"])
    for path, reference in ((spec_path, spec_ref), (profile_path, profile_ref)):
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != reference.sha256:
            raise ValueError(f"guided artifact changed after freeze: {path}")
        stored = database.get_artifact(reference.id, reference.revision, limit=2 * 1024 * 1024)
        if stored["sha256"] != reference.sha256 or stored["content"].encode() != content:
            raise ValueError("guided artifact no longer matches the approved database snapshot")
    profile = ProjectProfile.model_validate_json(profile_path.read_text(encoding="utf-8"))
    spec = FeatureSpec.model_validate_json(spec_path.read_text(encoding="utf-8"))
    if profile.project_id != project["id"] or spec.feature_id != selected:
        raise ValueError("guided spec and profile do not belong to this project")
    current_profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
    if model_hash(current_profile) != model_hash(profile):
        raise ValueError("project profile changed after freeze; review and freeze the spec again")
    repository = Path(project["root_path"]).resolve(strict=True)
    print(f"Exécution réelle · {spec.title} · {', '.join(spec.surfaces)}")
    print(f"Dépôt : {repository}\nChecks : {', '.join(spec.dod.required_checks)}")
    if not _yes("Créer le worktree et démarrer les agents ?"):
        raise ValueError("start cancelled before creating a run")
    run_id = f"{selected[:48]}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:6]}"
    worktrees = data_dir / "worktrees"
    worktrees.mkdir(parents=True, exist_ok=True)
    return spec_path, profile_path, worktrees, run_id
