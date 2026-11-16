---
feature_id: <slug>
title: <Feature title>
status: draft # draft → frozen → in-progress → in-review → shipped → merged · blocked · abandoned (see `<core>/pipeline/schema/spec-status.md`)
branch: <feature_branch_prefix><slug>
created: <YYYY-MM-DD>
reviewed_base: # merge-base sha at the last SHIP verdict — freshness-gate anchor (written by /cohorte-review)
reviewed_digest: # sha256 (16 hex) of the reviewed source diff vs reviewed_base, specs excluded — /cohorte-ship re-checks
design_files: [] # design page links — full URLs of the form https://claude.ai/design/p/<projectId>?file=<file> (each carries its own project + page); blank until designed; omit if no UI
---

# <Feature title>

## 1. Goal & user story

<one paragraph: what · who · why>

## 2. Scope

**In:** …
**Out (non-goals):** …

## 3. Roles & permissions

> Only if `PIPELINE.md` §rbac is enabled — which roles can do what; note the lowest-privilege experience.

## 4. Data model & migrations

> Additive only (never gate.deny commands). Omit if the feature has no persistence.

| table | column | type | null? | default | notes |
| ----- | ------ | ---- | ----- | ------- | ----- |
|       |        |      |       |         |       |

## 5. CONTRACT (frozen)

> The only sync channel. Complete enough to build every surface independently. Uses the profile's
> `contract.mechanism`. If `contract.enabled` is false, capture the interface precisely in prose here.

### `<METHOD> /<path>` · auth: `<middleware/role>`

- **Request** — params / query / body: `field` · type · required? · nullable? · validation
- **Success** — `<status>` · response shape
- **Errors** — `<status>` · when (422 validation · 401 · 403 · 404 · 409 …)

<repeat per endpoint/interface>

### Contract types — lead authors `<contract.path>/<slug>.<ext>` before /cohorte-build

- `<slug>...Request` / `<slug>...Response` / `<slug>Base` … (sketch the schemas here)

## 6. Surface tasks

> One `###` subsection per surface in `PIPELINE.md` §surfaces (e.g. backend, frontend), each TDD.
> Surfaces are subsections of §6, never top-level sections — §5, §8 and §9 are referenced by number
> across the whole pipeline (the implementer and reviewer agents read "contract §5, acceptance §9",
> `/cohorte-spec` writes the design brief summary into §8), so a third surface must not become a §7
> or §8 of its own. (§7 is deliberately absent here — the patch template uses it for Out of scope.)

### <surface.key>

- …

## 8. Design brief (the "spec return")

> Only if the project has UI. Standalone; mirrors `<core>/templates/design-brief.md`.

- **Screens / views:** …
- **Flows:** …
- **Responsive:** mobile (base) → `md:` → `lg:`
- **States:** empty · loading · error · success

## 9. Acceptance criteria / DoD

> Defaults follow `PIPELINE.md` `project.kind` (absent ⇒ `web`). `web` ⇒ keep the five lines below
> as they are. Any other kind ⇒ read only its `## <kind>` section of
> `<core>/pipeline/schema/project-kinds.md` and apply its **DoD** line: add the lines it lists, drop
> the ones it drops (mobile-first outside `web`/`mobile`). Then add this feature's own criteria.

- [ ] Every contract endpoint/interface implemented exactly
- [ ] Each surface's tests (TDD) green
- [ ] `PIPELINE.md` commands.lint · typecheck · test green
- [ ] Mobile-first / responsive verified (if UI)
- [ ] User-facing copy in `ui_language`

## 10. Assumptions & open questions

- …

## Remediation

> Filled by `/cohorte-fix` (or `/cohorte-spec` Mode B) from a REVIEW REPORT; empty otherwise. Each item:
> `[ ] <SEVERITY> · <file:line> · <spec-violation|quality|security> · <concrete fix>`
