# ADR-0014: V2 compatibility surface — completed importer and runtime removal

- **Status:** Superseded by the V3.0 completion decision
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
2. `ci.yml` is rewritten for V3. The temporary `legacy-v2` job was removed when the V3 parity gate completed; `publish.yml`, `docs.yml` and
   `discord-releases.yml` keep their names.
3. V2 logic is **ported with its test tables**, not reused as code; V2's gate implementation (a substring matcher with 11 confirmed evasions)
   is ported as a MUST-DENY test table only.
4. Kept for cockpit continuity: `cohorte doctor --panel`, `cohorte status --panel=…`, `cohorte specs --porcelain` (byte-compatible field
   order). Panel modes always exit 0.
5. The importer (`init --export-v2`, `init --from-v2`) performs the complete conversion in the current format; the implementation lives in
   `project-model/src/import-v2/`. The bundle contract and rollback rules are frozen in `docs/v3/MIGRATION.md`.

## Consequences

- The repository carries only the V3 runtime; the published package contains no V2 runtime.
- Existing V2 users have a reviewable, checksum-verified migration path; V2 runtime execution remains excluded.

## Revisit when

- The current format is released and the importer plus rollback tests are shipped; `legacy/v2/` has therefore been removed.
- François drops the one-shot panel extension model → the `--panel` adapters can be removed.
