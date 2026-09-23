import pytest

from cohorte.application.delivery import render_release_notes


def test_release_notes_are_opt_in_and_use_configured_template() -> None:
    content = {"title": "A new feature", "problem": "The old flow is slow", "acceptance": ["Works"]}

    assert render_release_notes({"enabled": False}, **content) is None
    assert (
        render_release_notes(
            {
                "enabled": True,
                "heading": "User changes",
                "template": "{title}\n\n{acceptance}",
            },
            **content,
        )
        == "## User changes\n\nA new feature\n\n- Works"
    )


@pytest.mark.parametrize(
    "config",
    [
        {"enabled": "true"},
        {"enabled": True, "template": "{title.__class__}"},
        {"enabled": True, "template": "{unknown}"},
        {"enabled": True, "template": "{title!r}"},
        {"enabled": True, "heading": "Heading\nInjected"},
    ],
)
def test_release_notes_reject_invalid_configuration(config: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        render_release_notes(config, title="Title", problem="Problem", acceptance=["Works"])
