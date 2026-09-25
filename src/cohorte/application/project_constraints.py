"""Fail closed when an enabled project constraint is absent from a feature spec."""

from __future__ import annotations

from cohorte.domain.models import FeatureSpec, ProjectProfile


def active_constraints(profile: ProjectProfile, selected_surfaces: list[str]) -> set[str]:
    surfaces = {surface.id: surface for surface in profile.surfaces}
    chosen = [surfaces[sid] for sid in selected_surfaces if sid in surfaces]
    required: set[str] = set()
    if profile.integrations.design.enabled and any(
        surface.uses_design or surface.role_profile == "frontend" for surface in chosen
    ):
        required.add("design")
    if profile.integrations.rbac.get("enabled") is True:
        required.add("rbac")
    if profile.integrations.mobile.get("enabled") is True and any(
        surface.role_profile == "frontend" for surface in chosen
    ):
        required.add("mobile")
    return required


def validate_project_constraints(profile: ProjectProfile, spec: FeatureSpec) -> None:
    required = active_constraints(profile, spec.surfaces)
    missing = [
        name
        for name, values in (
            ("design", spec.design_refs),
            ("rbac", spec.rbac_requirements),
            ("mobile", spec.mobile_requirements),
        )
        if name in required and not any(value.strip() for value in values)
    ]
    if missing:
        raise ValueError(
            f"spec lacks active project constraints: {', '.join(missing)}; "
            "record them before freezing or building"
        )
