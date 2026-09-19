# Lead decisions and fixes applied outside any unit

The lead owns the structural files (root config, `docs/v3/**`) and reconciles what a single unit cannot.
Each entry says what changed, why, and what would revisit it.

## L1 — `nursery/noFloatingPromises` turned OFF in `biome.json`

**Symptom.** `biome ci` aborted with `thread '…' has overflowed its stack / fatal runtime error` **and exited 0**,
so a crashed lint passed as a clean one over the whole tree.

**Cause.** Biome 2.5.14's type-aware analysis, on ordinary code in `packages/persistence` (U0.06's reviewer
reduced it to a `Pick<>` over an imported interface). `RUST_MIN_STACK` does not help — Biome sets its own
worker stack — and the crash survived U0.06 being finished and green, so it is not an artefact of half-written code.

**Decision.** The rule is off. A linter that crashes silently is worse than a missing rule: it hid every other
diagnostic in the files it never reached. `workspace.md` pins Biome 2.5.14 "because nursery/noFloatingPromises
is an error" — that reason no longer holds; the pin itself stays.

**Compensating fix.** `scripts/unit-check.ts` now treats `overflowed its stack` / `fatal runtime error` in Biome's
output as a FAILED lint step regardless of exit code, so a future crash can never pass as green again.

**Revisit when.** Biome is upgraded: turn the rule back on, run `biome ci .` over the full tree, keep it only if
it completes. Until then, floating promises are caught by review and by `tsc`'s `no-floating-promises`-adjacent
strictness only — name it in the reviewer prompt for async-heavy units.

## L2 — Wave 0 / Wave 1 overlap: "frozen barrel" tests reconciled

The lead runs Wave 1 units as soon as their Wave-0 contract is green, before gate G0. Two Wave-0 tests asserted
that a barrel entry *still* throws `NotImplemented`, which a Wave-1 unit legitimately falsifies by filling it
(`createGitPort` by U1.05, a security stub by U1.02–U1.04).

Rewritten to the invariant that holds for good: **every barrel entry is a live export — filled, or still refusing
loudly with `NotImplemented` — and never a missing/renamed symbol.** Files: `packages/git/test/contract/contract.test.ts`,
`packages/security/test/contract/barrel.test.ts`. The `createGitPort` probe also gained the two options U1.05 made
required (`mergeIdentity`, `worktreeRoot`).

## L3 — over-broad `testPaths` narrowed in `docs/v3/plan.json`

`U0.07` listed whole packages (`packages/security`, `packages/git`, …) and `U0.06` listed `packages/persistence`,
so their checks collected test directories owned by *later* units and flickered red or green depending on what a
sibling agent had half-written. Both now list only the directories the unit owns; their literal `check` strings were
updated to match and `scripts/gen-unit-checks.ts` re-run. (Requests R2/R4 from U0.06's reviewer.)

## L4 — toolchain traps fixed once, for every unit

- `pnpm -s <script>` is rejected by pnpm 12 → every check uses `pnpm --reporter=silent <script>`.
- `ajv` / `ajv-formats` are CJS: under `module: nodenext` + `verbatimModuleSyntax`, import
  `{ Ajv2020, type SchemaObject }` and unwrap `addFormatsModule.default ?? addFormatsModule` **below** the
  import block; pass schemas as `x as SchemaObject`.
- `vitest` stays UNDECLARED in the three packages whose `src/conformance/` imports it (`testkit`,
  `runtime-contract`, `persistence`) and is resolved by root hoisting. Declaring it was tried and reverted:
  `layers.json` models dev edges as workspace edges only, so `check-layers` rejects a third-party name there,
  and widening that schema would ripple through `scripts/check-layers.ts` and `scripts/test/resolve-edges.test.ts`.
  The packages are private, and DESIGN 1.3 keeps those files out of the published bundle, so nothing ships
  with a missing dependency. Revisit only if a package ever becomes publishable on its own.
- `docs/.vitepress/config.mjs` excludes `v3/**`: `docs/` is still the V2 documentation site.

## L5 — `U0.08` ownership overlap resolved (request R13)

`U0.08.ownedPaths` carried the glob `packages/core/src/*/index.ts`, which swallowed areas owned by `U0.09`
(`pipeline`, `state`) and `U1.08` (`events`, `durability/{journal,lease}`), breaking PLAN §3 rule 1. It made
U0.08's check compile a sibling's half-written files and forced U0.08 to edit files it did not own.

Replaced by the explicit list of the fourteen area seam files U0.08 actually creates (`engine`, `resume`,
`toolhost`, `approvals`, `context`, `snapshot`, `worktrees`, `provision`, `integration`, `loop`, `review`,
`budgets`, `grants`, `projection`), and the two `durability/{journal,lease}/index.ts` entries dropped now that
U1.08's implementations exist. `U0.08.testPaths` also covered the whole of `packages/tools`, which Wave 2 fills
with `U2.03`/`U2.04` suites: narrowed to `packages/tools/test/catalogue`. `scripts/gen-unit-checks.ts` re-run;
U0.08, U0.09 and U1.08 are green afterwards.

## L6 — `AGENT_TRANSITIONS` double assignment closed in code (request R6)

`plan.json` gave `agents/lifecycle.ts` to U0.08 and `agents/lifecycle-table.ts` plus the `AGENT_TRANSITIONS`
deliverable to U0.09. The units resolved it themselves, correctly: `lifecycle-table.ts` re-exports
`AGENT_TRANSITIONS`, `reincarnate` and `ReincarnateCause` from `lifecycle.ts` and adds only what is its own
(`ATTEMPT_CONSUMING_EDGES`, `attemptConsumed`). One definition, one published export, both units green — no
plan surgery needed. U0.09's deliverable text in `plan.json` is left as written: it records the intent, and the
implementation satisfies it by re-export rather than by a second definition.

## L7 — status at the end of Wave 0 + Wave 1

Every one of the twenty units U0.01–U0.10 and U1.01–U1.10 is GREEN, verified by the lead running each unit's own
check on a quiet tree (agent verdicts recorded during the run were unreliable: a check taken while a sibling was
mid-write flickers). Whole-tree `verify` passes typecheck, Biome over 620 files, `check-layers` over 481 files and
`check-contract-words`; its only failure is the missing `scripts/gen-schemas.ts`, which is gate G0's own deliverable.

## L8 — one racy test, reproducible only in the full suite (for G1)

`packages/security/test/exec/lifecycle.test.ts` › "one entry, keyed by the reported pgid and carrying the reported
startToken, then none" **passes 5/5 in isolation and fails 3/3 in `vitest run --project unit --project integration`**
(3601 passed, 1 failed). Diagnosed by the lead, not yet fixed — the gates were running on the tree and the file
belongs to U1.04.

**Why it races.** The test snapshots `pids.entries` from the executor's `onChunk` callback, i.e. it assumes the child
is still registered when its first chunk is delivered. Under full-suite load the child can exit — and the executor
deregister the group — before that callback runs, so `duringRun` is `[]`:

```
AssertionError: expected [] to deeply equal [ [ 78889, "lstart:67abd…" ] ]
```

**Proposed fix, deterministic rather than slower.** Keep the invariant (the group is recorded while it runs and
removed at exit) but observe it where it cannot race: snapshot inside the fake registry's `record()` — the one moment
the entry provably exists, and where `pgid`/`startToken` are already known — and keep `expect(pids.entries.size).toBe(0)`
after the run as the other half. Adding a sleep to the child would only widen the window, not close it.

A test that is green alone and red in the suite is worse than a failing one: it makes every later wave's gate
flicker. Close it before G1 is recorded as passed.

## L9 — G1's open major closed: the clean-exit lock release is now pinned

U1.INT's reviewer found that only one half of the lease invariant was asserted: the crash tests pin "a host that dies
keeps its row so a later host can take it over with fencing + 1" (DESIGN 4.4), but nothing asserted that a NORMAL exit
hands the run lock back. A regression there is invisible until a *second* run refuses to start.

Added by the lead to `packages/core/test/engine/run-to-completed.test.ts`: "hands the run lock back on a clean exit,
leaving no row to take over" — `listLocks({ scope: 'run' })` is empty before the run and empty after it.

**Proved it can fail**: with `if (!releaseHandled) await releaseQuietly(deps, lease)` disabled in
`packages/core/src/engine/index.ts`, the new test fails and the existing one still passes; restored, both pass. A test
that cannot fail pins nothing.

## L10 — Waves 0 and 1 are complete

Gate G1's declared exit check was run by the lead, whole, in one shell, on a quiet tree: **exit 0**. `verify`
(3720 tests over 152 files, Biome 629 files, check-layers 490, 24 schemas up to date), the durability/engine/resume
suites against REAL SQLite (210 tests), the walking skeleton (10 tests), `build.ts` (78 bundle files, agent-host
selftest against Pi 0.85.1), `pack-check.ts` (a real tarball that installs and whose `cohorte status` runs), and the
G1 checkpoint. Gate G0 passed the same way. Nothing is committed: `HEAD` is still `117ae8b`, identical to `main`.
