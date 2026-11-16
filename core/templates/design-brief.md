# DESIGN BRIEF — <feature title> (`<feature_id>`)

> The "spec return". This is §8 of the frozen spec, standalone — `/cohorte-spec` writes it to
> `specs/design/<feature_id>.md` on freeze. Omit entirely if the project has no UI.
>
> **Getting it into the design tool:** paste it there yourself (see `PIPELINE.md` §design). This file
> stays the source of truth — it is what `/cohorte-build` reads.

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
