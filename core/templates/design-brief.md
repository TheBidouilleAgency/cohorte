# DESIGN BRIEF — <feature title> (`<feature_id>`)

> The "spec return". This is §8 of the frozen spec, standalone — `/cohorte-spec` writes it to
> `specs/design/<feature_id>.md` on freeze. Omit entirely if the project has no UI.
>
> **Getting it into the design tool.** By default: paste it there yourself (see `PIPELINE.md` §design).
> With `design.inline: true`, `/cohorte-spec` instead offers to hand this file straight to `/design`,
> which reads the codebase, matches the existing UI style, and returns editable artboards in-session.
>
> Inline changes who does the pasting, and nothing else. This file is still written to disk first and
> is still what `/cohorte-build` reads — the artboards are an aid to the human, not an input to the
> pipeline, and `/design` is a research preview that does not save them for you. Export anything worth
> keeping before the session ends. If the design floor is unmet, the flag degrades to the paste-it-
> yourself path with a note, never to an error: a brief that exists is worth more than a step that ran.

**Goal:** <one line — what the user accomplishes>

**Design system:** use the existing UI kit (`PIPELINE.md` §design → `ui_kit_path`). Mobile-first.

## Screens / views

For each: purpose, who sees it (role, if RBAC), and the key elements.

- **<screen name>** — <purpose> · roles: <…>
  - Elements: <…>
  - States: empty · loading · error · success

## Flows

<step-by-step of the main user journey, and any role-specific variation>

## Responsive

- Mobile (base): <layout>
- Tablet (`md:`): <changes>
- Desktop (`lg:`): <changes>

## Data shown

<what fields/values appear on screen — must match the contract in spec §5>

## Notes / constraints

<accessibility · copy in the profile's `ui_language` · edge cases · theming constraints>
