# ADR-0014: V2 compatibility surface — sources to `legacy/v2/`, cockpit verbs kept, importer later

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 14; brief D8
- **Design reference:** DESIGN.md §9 (row 27), §10.3 (U0.1), §2.3.5

## Context

V3 is full-breaking (spec 27): no Claude/Codex/Cursor/Gemini/OpenCode adapters, no Markdown-only workflow logic. V2 contains reusable, tested
pure logic (loop reducer, verdict math, finding identity, tree digest, doctor framework, 70 gate cases) and doctrine worth porting. François
today spawns `cohorte doctor --panel`, `cohorte specs --porcelain` and similar one-shot panels. The repository's CI currently runs V2 tests.

## Decision

1. In Wave 0 the V2 sources (`bin core lib profile scripts assets install.sh install.ps1` and the V2 `package.json`) move to **`legacy/v2/`**
   with `git mv`; they are excluded from every tsconfig, Biome, vitest and bundle glob. Nothing V2 is on the execution path.
2. `ci.yml` is rewritten for V3 and keeps a `legacy-v2` job that still runs the V2 tests from `legacy/v2`; `publish.yml`, `docs.yml` and
   `discord-releases.yml` keep their names.
3. V2 logic is **ported with its test tables**, not reused as code; V2's gate implementation (a substring matcher with 11 confirmed evasions)
   is ported as a MUST-DENY test table only.
4. Kept for cockpit continuity: `cohorte doctor --panel`, `cohorte status --panel=…`, `cohorte specs --porcelain` (byte-compatible field
   order). Panel modes always exit 0.
5. The importer (`cohorte-v2 export`, `init --from-v2`) is V3.1; the seam is `project-model/src/import/` with a reserved bundle schema.

## Consequences

- The branch carries both code bases until V3.0 ships; the published package contains nothing from `legacy/`.
- Existing V2 users have no automated migration in V3.0.

## Revisit when

- V3.0 is released → decide when `legacy/v2/` leaves the repository (after the importer exists, or at 3.1).
- François drops the one-shot panel extension model → the `--panel` adapters can be removed.
