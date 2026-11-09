---
feature_id: patch-<slug>
kind: patch # a bug fix, not a feature — /cohorte-build skips contract authoring, /cohorte-ship commits `fix(…)`
title: <one line: the bug, from the user's side>
status: draft # draft → frozen → in-progress → in-review → shipped · blocked (see SCHEMA.md §Spec status)
severity: <critical | major | minor> # drives nothing mechanical; it is what the human triages on
branch: <patch_branch_prefix><feature_id>
created: <YYYY-MM-DD>
reviewed_base: # merge-base sha at the last SHIP verdict — freshness-gate anchor (written by /cohorte-review)
reviewed_digest: # sha256 (16 hex) of the reviewed source diff vs reviewed_base, specs excluded — /cohorte-ship re-checks
design_files: [] # omit unless the fix is itself visual
---

# <one line: the bug, from the user's side>

## 1. Symptom & repro

> What the user sees, and the shortest deterministic path to see it. A repro nobody can run is a
> hypothesis, not a bug — say so here rather than pretending otherwise.

- **Observed:** …
- **Expected:** …
- **Repro:** 1. … 2. … 3. …
- **Since / trigger:** <version, commit, or "unknown">

## 2. Impact

> Who is affected, how often, and whether there is a workaround. This is what justifies the patch
> jumping the feature queue — one or two lines.

## 3. Cause

> Confirmed or hypothesis — label which. Name the `file:line` if you have it. If the cause is
> unknown at freeze, say so: the implementer's first job is then to find it, and the review will
> check that the stated cause matches the diff.

## 4. Regression test (red first)

> The heart of a patch spec — it replaces §5 CONTRACT as the thing the diff is checked against.
> Name the test file and what it asserts. It must fail on the current code and pass after the fix.

- **Test:** `<path/to/test>` · asserts: …
- **Fails today because:** …

## 5. Contract delta

> Usually `none`. A fix that *changes* an existing contract entry describes the change here and
> `/cohorte-build` propagates it to every surface that names it. A fix that needs **new** contract
> surface area is not a patch — stop and run `/cohorte-spec` instead.

`none`

## 6. Surface tasks

> One `###` subsection per surface the fix touches — a patch may legitimately span several (an
> unvalidated field on the API *and* the form that sends it). Each TDD: the §4 test first.

### <surface.key>

- …

## 7. Out of scope

> The adjacent things this patch deliberately does NOT fix. This is the section that keeps a bug fix
> from turning into a refactor — the reviewer reads it before flagging what you left alone. Real but
> out-of-scope findings belong in `specs/refactor-backlog.md`, not in this diff.

- …

## 9. Acceptance criteria / DoD

> §9, not §8 — the number is load-bearing, so don't renumber it. `review.md` and
> `implementer.template.md` both name "contract §5, acceptance §9" verbatim, so a patch spec pins
> those two sections to the feature spec's numbers and just has no §8 (the feature spec has no §7 —
> a gap in the sequence is normal here).

- [ ] The §4 regression test exists, and failed before the fix
- [ ] Each touched surface's tests (TDD) green
- [ ] `PIPELINE.md` commands.lint · typecheck · test green
- [ ] The repro in §1 no longer reproduces
- [ ] Nothing outside §6's surfaces changed

## Remediation

> Filled by `/cohorte-fix` from a REVIEW REPORT; empty otherwise. Each item:
> `[ ] <SEVERITY> · <file:line> · <spec-violation|quality|security> · <concrete fix>`
