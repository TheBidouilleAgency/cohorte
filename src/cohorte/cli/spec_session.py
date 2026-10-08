"""JSON spec conversation for clients that cannot host the guided terminal flow."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from cohorte.application.decisions import add_live_decision, live_decisions
from cohorte.application.kanban_mirror import sync_feature
from cohorte.application.preparation import (
    BrainstormBrief,
    SpecFreezer,
    SpecProposal,
    canonical_model_bytes,
)
from cohorte.cli.guided_feature import _propose_spec, _save, draft_from_proposal, repository_head
from cohorte.domain.models import ArtifactRef, FeatureSpec, ProjectProfile
from cohorte.persistence.sqlite import Database


def _ref(stored: dict[str, Any]) -> dict[str, Any]:
    return {key: stored[key] for key in ("id", "revision", "sha256")}


def _latest(database: Database, artifact_id: str) -> dict[str, Any] | None:
    try:
        return database.latest_artifact(artifact_id)
    except KeyError:
        return None


def _location(data_dir: Path, project_id: str, feature_id: str) -> Path:
    return data_dir / "guided" / project_id / feature_id


def _load_draft(location: Path, feature_id: str) -> FeatureSpec | None:
    path = location / "draft.json"
    if not path.is_file() or path.is_symlink():
        return None
    draft = FeatureSpec.model_validate_json(path.read_text(encoding="utf-8"))
    if draft.feature_id != feature_id:
        raise ValueError("saved draft belongs to another feature")
    return draft


def _linked_proposal(
    database: Database, feature_id: str, brief_ref: dict[str, Any]
) -> tuple[SpecProposal, dict[str, Any]] | None:
    context = _latest(database, f"proposal-context:{feature_id}")
    if context is None:
        return None
    link = json.loads(context["content"])
    if link.get("brief_ref") != brief_ref:
        return None
    proposal_ref = ArtifactRef.model_validate(link["proposal_ref"])
    stored = database.get_artifact(proposal_ref.id, proposal_ref.revision, limit=2 * 1024 * 1024)
    if stored["sha256"] != proposal_ref.sha256:
        raise ValueError("stored proposal changed")
    return SpecProposal.model_validate_json(stored["content"]), proposal_ref.model_dump(mode="json")


def _feedback(database: Database, feature_id: str, brief_ref: dict[str, Any]) -> list[str]:
    stored = _latest(database, f"spec-feedback:{feature_id}")
    if stored is None:
        return []
    content = json.loads(stored["content"])
    if content.get("brief_ref") != brief_ref:
        return []
    return [str(message) for message in content.get("messages", [])]


def _draft_proposal_ref(database: Database, feature_id: str) -> dict[str, Any] | None:
    stored = _latest(database, f"draft-proposal-context:{feature_id}")
    return json.loads(stored["content"])["proposal_ref"] if stored else None


def _standing_candidates(brief: BrainstormBrief, repository: Path) -> list[dict[str, str]]:
    existing = live_decisions(repository)
    return [
        candidate.model_dump(mode="json")
        for candidate in brief.synthesis.standing_decision_candidates[:3]
        if candidate.source_answer in brief.user_answers
        and not any(candidate.decision in entry for entry in existing)
    ]


def spec_session(
    database: Database,
    data_dir: Path,
    project: dict[str, Any],
    feature_id: str,
    action: str,
    *,
    message: str | None = None,
    answers: list[str] | None = None,
    contract: Path | None = None,
    expect_proposal_revision: int | None = None,
    expect_draft_revision: int | None = None,
    request_id: str | None = None,
    spec_hash: str | None = None,
    profile_hash: str | None = None,
    candidate_index: int | None = None,
) -> dict[str, Any]:
    feature = database.get_feature(feature_id)
    if feature["project_id"] != project["id"]:
        raise ValueError("feature belongs to another project")
    repository = Path(project["root_path"]).resolve(strict=True)
    profile = ProjectProfile.model_validate_json(json.dumps(project["profile"]))
    location = _location(data_dir, project["id"], feature_id)
    stored_brief = _latest(database, f"brief:{feature_id}")
    if stored_brief is None:
        raise ValueError("no brainstorm brief for this feature")
    brief = BrainstormBrief.model_validate_json(stored_brief["content"])
    if brief.feature_id != feature_id:
        raise ValueError("stored brief belongs to another feature")
    brief_ref = _ref(stored_brief)
    draft = _load_draft(location, feature_id)
    linked = _linked_proposal(database, feature_id, brief_ref)
    feedback = _feedback(database, feature_id, brief_ref)

    if action == "show":
        return {
            "feature_status": feature["status"],
            "brief_ref": brief_ref,
            "proposal": linked[0].model_dump(mode="json") if linked else None,
            "proposal_ref": linked[1] if linked else None,
            "draft_proposal_ref": _draft_proposal_ref(database, feature_id),
            "draft": draft.model_dump(mode="json") if draft else None,
            "draft_current": draft is not None
            and draft.brief_ref == ArtifactRef.model_validate(brief_ref),
            "feedback": feedback,
            "profile": {
                "project_id": profile.project_id,
                "revision": profile.revision,
                "surfaces": [item.id for item in profile.surfaces],
            },
            "standing_candidates": _standing_candidates(brief, repository)
            if feature["status"] == "frozen"
            else [],
        }

    if action == "ratify":
        if feature["status"] != "frozen":
            raise ValueError("freeze the spec before keeping a standing decision")
        candidates = _standing_candidates(brief, repository)
        if candidate_index is None or candidate_index < 1 or candidate_index > len(candidates):
            raise ValueError("standing decision changed; review the current candidates")
        candidate = candidates[candidate_index - 1]
        entry = add_live_decision(
            repository,
            area=candidate["area"],
            decision=candidate["decision"],
            reason=candidate["reason"],
            feature_id=feature_id,
        )
        return {"entry": entry}

    if feature["status"] == "frozen":
        raise ValueError("feature is already frozen")
    if action == "propose":
        if message is not None and (not message.strip() or len(message) > 4000):
            raise ValueError("spec feedback must be 1-4000 characters")
        if message is not None and linked is None:
            raise ValueError("create the first proposal before discussing it")
        next_feedback = [*feedback, message.strip()] if message is not None else feedback
        proposal = _propose_spec(
            brief,
            profile,
            repository,
            draft,
            next_feedback,
            linked[0] if linked else None,
        )
        proposal_ref = database.put_artifact(
            "feature-spec-proposal",
            canonical_model_bytes(proposal),
            artifact_id=f"proposal:{feature_id}",
        )
        database.put_artifact(
            "feature-spec-proposal-context",
            json.dumps(
                {"proposal_ref": proposal_ref, "brief_ref": brief_ref}, sort_keys=True
            ).encode(),
            artifact_id=f"proposal-context:{feature_id}",
        )
        if message is not None:
            database.put_artifact(
                "feature-spec-feedback",
                json.dumps(
                    {"brief_ref": brief_ref, "messages": next_feedback}, ensure_ascii=False
                ).encode(),
                artifact_id=f"spec-feedback:{feature_id}",
            )
        return {
            "proposal": proposal.model_dump(mode="json"),
            "proposal_ref": proposal_ref,
            "brief_ref": brief_ref,
            "feedback": next_feedback,
            "approved": False,
        }

    if action == "accept":
        if linked is None:
            raise ValueError("no current proposal; propose the spec first")
        if expect_proposal_revision != linked[1]["revision"]:
            raise ValueError("proposal changed; review its latest revision")
        if expect_draft_revision != (draft.revision if draft else 0):
            raise ValueError("draft changed; review its latest revision")
        indexed: dict[int, str] = {}
        for raw in answers or []:
            number, separator, value = raw.partition("=")
            if not separator or not number.isdigit() or not value.strip():
                raise ValueError("--answer must be N=non-empty answer")
            index = int(number)
            if index in indexed:
                raise ValueError("duplicate answer index")
            indexed[index] = value.strip()
        contracts: list[ArtifactRef] = []
        if contract is not None:
            path = (repository / contract).resolve(strict=True)
            if not path.is_relative_to(repository) or not path.is_file():
                raise ValueError("contract must be a file in the registered repository")
            contracts.append(
                ArtifactRef.model_validate(database.put_artifact("contract", path.read_bytes()))
            )
        replacement = draft_from_proposal(
            brief, ArtifactRef.model_validate(brief_ref), profile, linked[0], indexed, contracts
        )
        if draft is not None:
            replacement = replacement.model_copy(update={"revision": draft.revision + 1})
        _save(location / "draft.json", canonical_model_bytes(replacement))
        draft_ref = database.put_artifact(
            "feature-spec-draft",
            canonical_model_bytes(replacement),
            artifact_id=f"draft:{feature_id}",
        )
        database.put_artifact(
            "feature-spec-draft-context",
            json.dumps(
                {"proposal_ref": linked[1], "draft_ref": draft_ref}, sort_keys=True
            ).encode(),
            artifact_id=f"draft-proposal-context:{feature_id}",
        )
        sync_feature(database, feature_id, "spec")
        return {"draft": replacement.model_dump(mode="json"), "draft_ref": draft_ref}

    if draft is None or draft.brief_ref != ArtifactRef.model_validate(brief_ref):
        raise ValueError("draft is missing or out of date; review and accept a current proposal")
    accepted_ref = _draft_proposal_ref(database, feature_id)
    if linked is not None and accepted_ref is not None and accepted_ref != linked[1]:
        raise ValueError("proposal changed after draft acceptance; review and accept it again")
    if action not in {"prepare", "freeze"}:
        raise ValueError("unknown spec session action")
    prepared = SpecFreezer(database).prepare(draft, profile, repository_head(repository))
    if action == "prepare":
        candidate = database.get_artifact(
            prepared.candidate_ref.id, prepared.candidate_ref.revision
        )
        return {
            "preparation": prepared.model_dump(mode="json"),
            "draft": draft.model_dump(mode="json"),
            "candidate": json.loads(candidate["content"]),
            "profile_snapshot": profile.model_dump(mode="json"),
        }
    if (
        request_id != prepared.request_id
        or spec_hash != prepared.spec_hash
        or profile_hash != prepared.profile_hash
    ):
        raise ValueError("spec, profile, or repository changed; request a fresh approval")
    previous = database.approval_for_request(prepared.request_id)
    if previous is None:
        decision = database.respond_request(
            prepared.request_id,
            f"spec-session:{prepared.request_id}:{uuid4()}",
            {"approved": True},
            prepared.spec_hash,
            client_identity="francois-desktop",
        )
        decision_id = decision["decision_id"]
    else:
        if previous["answer"] != {"approved": True}:
            raise ValueError("the exact spec freeze request was denied")
        decision_id = previous["id"]
    frozen = SpecFreezer(database).freeze(draft, profile, repository_head(repository), decision_id)
    spec_bytes = canonical_model_bytes(frozen.spec)
    profile_bytes = canonical_model_bytes(profile)
    spec_ref = database.put_artifact("feature-spec", spec_bytes, artifact_id=f"frozen:{feature_id}")
    profile_ref = database.put_artifact(
        "project-profile", profile_bytes, artifact_id=f"frozen-profile:{feature_id}"
    )
    database.put_artifact(
        "feature-ready",
        json.dumps({"spec_ref": spec_ref, "profile_ref": profile_ref}, sort_keys=True).encode(),
        artifact_id=f"ready:{feature_id}",
    )
    _save(location / "frozen.json", spec_bytes)
    _save(location / "profile.json", profile_bytes)
    database.set_feature_status(feature_id, "frozen")
    sync_feature(database, feature_id, "ready")
    return {
        "spec": frozen.spec.model_dump(mode="json"),
        "spec_ref": spec_ref,
        "decision_id": decision_id,
    }
