# Cohorte V3.0 — Work breakdown (PLAN)

**Status:** executable plan for parallel coding agents · **Date:** 2026-09-18 · **Design of record:** `docs/v3/DESIGN.md` · **Spec:** `docs/v3/SPEC.md`
**Machine-readable twin:** `docs/v3/plan.json` (same data; `scripts/gen-unit-checks.ts` and `scripts/unit-check.ts` read it).
**Revision 2 (same day):** amended after the adversarial design critique — 3 blockers, 16 majors, 17 minors, all applied; §8.4 maps each finding to the unit that delivers its fix, §2 rows F-7, F-8, PC-8..PC-11 record the facts behind the contract amendments.
**Where the work happens:** ONE working tree, `/Users/enzo/dev-perso/cohorte`, branch `feat/v3-rewrite`. No git worktrees for the builders, no commits by agents.

`<SCRATCH>` in this document = `/private/tmp/claude-501/-Users-enzo-dev-perso-cohorte/224084d8-944a-4120-a6f7-fe1d8176b0db/scratchpad/v3` (session-local research: `understand/*.md`, `spike/{child,sdk}/REPORT.md`, `pi-live/`, and the verified toolchain prototype at `<SCRATCH>/../proto`). Every research report ends with a "Verification" section whose corrections override its body.

## 0. How to use this plan

- A **wave** is a set of units that run at the same time. Wave 0 is **sequential**. Every other wave is: N parallel units, then **one integrator unit, alone**, whose check is the wave's exit check (the "gate").
- A **unit** is sized for one agent (about 500-2500 lines including tests). It lists: what it owns, what it depends on, which DESIGN sections to read, what to deliver, which tests to write FIRST, and ONE shell command that proves it is done.
- A unit agent reads, in this order: `SPEC.md` (the sections named by its DESIGN sections), `DESIGN.md` sections listed under "Read first", §2-§4 of this plan, then its own unit block. `DESIGN.md` is normative for types and behaviour; **this plan is normative for ownership, order and checks**, and §2 lists the few points where it clarifies or overrides DESIGN §10.
- Unit ids are `U<wave>.<nn>`; the integrator of wave *n* is `U<n>.INT` (gate `G<n>`); Wave 0 ends with `U0.G` (gate `G0`).

## 1. Shape

Seven waves. FakeRuntime first; Pi is never on the critical path; packaging is proven in Wave 0; from Wave 1 on every gate has a runnable end-to-end path with the FakeRuntime.

```text
W0  sequential   legacy move -> scaffold -> base -> frontier 1 -> frontier 2 (x2) -> store contract -> host contracts (x2)
                 -> state-machine kernel -> CLI registry + packaging path -> G0 freeze (schemas, first gate build)
W1  10 parallel  SQLite · paths · commands · L0 executor · git · FakeRuntime · Pi parent vs fake brain · journal/events · engine · resume
                 └─ G1: skeleton (a)  engine x journal x REAL SQLite x FakeRuntime, crash/resume at every commit
W2  10 parallel  gate stages · redact+HMAC · tools read · tools write/exec · decisions · accounting · toolhost · approvals · config · Pi probes+harness
                 └─ G2: "hands" skeleton  fake agent through the real gate chain / executor / journal / approvals
W3  10 parallel  context · run files+snapshot · supervisor · worktrees+provision · phase executors · phase contracts · commit/merge
                 · project-model x2 · providers+telemetry
                 └─ G3: full pipeline, programmatic  build -> test -> review -> fix -> clean -> ship, crash + resume
W4   9 parallel  run host · observers/controllers · CLI verbs x3 · fixtures + first E2E · L1 sandbox · Pi child · prompts/skills
                 └─ G4: the spec-29-shaped demo through the BUILT CLI (detach, tail, kill -9, resume, COMPLETED)
W5   9 parallel  crash matrix · security E2E · E2E II · Pi in the loop · auth CLI · packaging+pin · schema-compat+migrations
                 · protocol/approvals/retries suites · dogfood D1-D6
                 └─ G5: the whole e2e project on the gate build
W6   3 parallel  acceptance AC-01..AC-12 · docs · live smoke + runbooks
                 └─ G6: CI workflows + publish.yml + `pnpm ci:local` -> release checklist (human-operated real run)
```

**Critical path:** `U0.01 -> ... -> U0.G -> {U1.01, U1.08, U1.09, U1.10} -> {U2.01, U2.04, U2.07} -> {U3.03, U3.04, U3.05, U3.07} -> {U4.01, U4.02, U4.03} -> U5.01 -> U6.01`. Everything Pi-specific (`U1.07`, `U2.10`, `U4.08`, `U5.04`, `U5.05`, `U6.03`), the L1 sandbox (`U4.07`) and the project model (`U3.08`, `U3.09`) are leaves beside it.

## 2. Facts established while planning, and plan-level clarifications

These were verified on the machine that will run the agents (node v24.21.0, pnpm 12.4.2, git 2.50.1, macOS arm64) or follow from the constraints of the run. Where they differ from `DESIGN.md` §10 they take precedence **for delivery**; they change no contract.

| # | Fact / clarification | Consequence in this plan |
|---|---|---|
| F-1 | **There is no `rg` binary on this machine's PATH** (`/usr/bin/which rg` finds nothing; the shell's `rg` is a function wrapping another program). DESIGN 2.7 has `search` spawn `rg`. | `U2.03` implements `search` with `rg` first and a hardened `git grep --no-index` fallback through the same `Executor`; `doctor` reports the active backend; `rg`-only tests skip WITH a reason. Human decision H1 (§10): install ripgrep locally and in CI. |
| F-2 | **Nothing is ever committed on this branch by agents.** `git diff --exit-code schemas/` (DESIGN 1.4 / 7.6) proves nothing on an uncommitted tree. | `scripts/gen-schemas.ts --check` regenerates in memory and byte-compares with the files. The legacy move is `git mv` (an index operation, not a commit). Rollback = `scripts/checkpoint.ts` at every gate. The dogfood tests (`U5.09`) build their repository under test from the WORKING TREE, not from `git clone` (which would yield the V2 tree). |
| F-3 | **Probe P3 (Linux `bwrap`, Ubuntu 24.04 AppArmor userns, IPC fd passing) cannot execute on this macOS machine.** | `U2.10` authors it, skips it with a reason on darwin, and its PRE-AGREED fallback is the default until the first Linux CI run: Linux brain sandbox `partial`, fd 3/4 framing available, documented remediation in `doctor`. `native` is never put on the default Linux/CI path before P3 has run there (`U4.07`, `U6.INT`). |
| F-4 | `pack-check` (`npm install --ignore-scripts <tgz>` in an empty dir) and the docs build (`npm --prefix docs ci`) need the network; nothing else does. | Only `U0.10`, the integrators, `U5.06` and `U6.02` run them. Fixture provisioning in E2E uses `pnpm install --offline` against the machine's store (`U4.06`). |
| F-5 | The existing `publish.yml` is V2-shaped (`node --check bin/cli.js ...`) and triggers on push to `main`. It is left untouched until `U6.INT` rewrites it in place (same FILENAME, same `npm-publish` ENVIRONMENT: npm trusted publishing is bound to both). | **Do not merge `feat/v3-rewrite` into `main` before gate G6.** |
| F-6 | Both spike reports have landed (`<SCRATCH>/spike/child/REPORT.md`, `<SCRATCH>/spike/sdk/REPORT.md`). The executed transport is the Node `'ipc'` channel, including under `sandbox-exec`. | `U0.03` freezes transport-agnostic frames; `U1.07` ships the Node IPC codec first, LF-framed fd 3/4 as the drop-in alternate, `runRpcMode` as the second fallback confined to `packages/runtime-pi/src/child/**` (`U4.08` day-1 checkpoint). |
| PC-1 | DESIGN 2.8 places `ERROR_CATALOGUE` in `core`, but L2 packages (`security`, `persistence`, `git`...) must mint complete `ErrorInfo`s (impact, remediation) and may not import `core`. | The catalogue DATA, `CohorteError`, `toErrorInfo` and `errorOf()` live in `@cohorte/base` (`U0.02`); `core/src/errors/catalogue.ts` re-exports it and adds the class -> run-effect table (`U0.08`). |
| PC-2 | DESIGN 10.3 lists `assets` in the `git mv` to `legacy/v2/`. The root `assets/` directory is BRAND material (logo, banner, demo GIF) referenced by `README.md` through `raw.githubusercontent.com/.../main/assets/...`; V3 has no root `assets/` of its own (embedded assets live under `apps/cli/assets/`, generated). | `assets/` STAYS at the root (`U0.01`). Moved: `bin core lib profile scripts install.sh install.ps1 package.json .npmignore`. Kept: `LICENSE CHANGELOG.md README.md docs/ .github/ assets/`. |
| PC-3 | The delivery judge required "a usable reference reducer" frozen before two units build against it; DESIGN had `evolve`/`nextStep` in Wave 1 (`U1.9`) next to the engine that calls them. | The **state-machine kernel** (three tables, command matrix, `nextStep`, `resolveTransition`, `evolve`, `AGENT_TRANSITIONS`) is a Wave-0 unit (`U0.09`). Its totality tests are the ones DESIGN 2.5.1 already required of Wave 0. |
| PC-4 | Removing every intra-wave import needs a few more frozen seams than DESIGN 2.5 lists. | Added to Wave 0, all tiny: `ToolIntrospection` (security validates tool input without importing `tools`), `ModelResolver`, `ProcessSweeper`, `EffectVerifierRegistry`, `GuardRegistry` + `FactCollector`, `TransitionEffectRunner`, `BillingTable`, `CommitService`, `MergeService` (core ports, `U0.08`); `CliContext` + `CommandModule` + doctor check list (apps/cli, `U0.10`); `base.computeAnchorMac` (shared by `security` and `persistence`, `U0.02`); testkit `makeStore()` and `fakeRedactor` (`U0.02`, `U0.06`); `@cohorte/project-model/contract` (`U0.07`). |
| PC-5 | The task fixes Wave 0 as strictly sequential (it creates the root). DESIGN had 1 serial unit + 4 parallel. | Wave 0 = ten small serial units + the G0 freeze. The Pi/Linux probes are not contracts: they moved to `U2.10`, merged with the testkit harness (probe P2 IS the injected-fetch fake provider). `dependsOn` edges inside W0 are exact, so an orchestrator that later allows it can run `U0.03 ∥ U0.04` and `U0.06 ∥ U0.07` (disjoint paths). |
| PC-6 | The task requires exactly one owner of the root files per wave. DESIGN says "the lead". | Each wave has an **integrator unit** (`U<n>.INT`) with the lead's duties of DESIGN 10.1: apply requests, amend contracts, regenerate schemas, run the gate, build the immutable gate build, take the rollback checkpoint. It runs ALONE, after every other unit of its wave. |
| PC-7 | Five DESIGN waves could not hold the split units with at most ten parallel seats and zero intra-wave dependencies. | Seven waves (W0-W6). Mapping DESIGN §10 -> this plan in §9. |
| F-7 | **A gate build cannot resolve its bare externals.** The bundles keep `commander`, `yaml`, `picomatch`, `typebox` and Pi as external imports; under pnpm's strict layout the repo-root `node_modules` holds only root devDependencies, so a file under `.build/gate-<n>/.publish/dist/` importing `yaml` fails with `ERR_MODULE_NOT_FOUND` while the same file under `apps/cli/dist/` resolves (reproduced in the toolchain prototype layout). `pack-check` proves only an `npm install`-ed tarball, which needs the network. | `scripts/build.ts --out <dir>` (`U0.10`) finishes by symlinking `<dir>/.publish/node_modules` -> `apps/cli/node_modules` (`apps/cli` re-declares every runtime dependency, Pi included) and then RUNS both entries offline from `<dir>`. Every unit that runs a built CLI (`U4.06`, `U5.01`, `U5.02`, `U5.03`, `U5.09`, `U6.01`) and the G4-G6 exit checks rely on it. `pin()` skips the `install-lock` artifact for such a linked build (DESIGN 3.9). |
| F-8 | **macOS injects an env var into every process.** Verified here (macOS arm64, Node 24.21): a Node child spawned with `env: { PATH }` and an `'ipc'` channel reports `["PATH","__CF_USER_TEXT_ENCODING"]`; Node removes `NODE_CHANNEL_FD` itself before user code runs. | "env contains only the allowlist" is defined as `visible ⊆ allow ∪ OS_INJECTED_ENV[platform]` — frozen data in `@cohorte/security/contract/builtin.ts` (`U0.07`), mirrored in the host protocol (`U0.03`); `diffAttestation` (`U0.03`, `U1.07`) and S-20 (`U1.04`) use it. An exact-equality check would refuse every PiRuntime spawn and every fake-brain test on macOS. |
| PC-8 | The package graph of DESIGN 1.1 could not host the contracts of DESIGN §2: `config -> security` (via `RunSnapshotManifest`) + `security -> config` is a project-reference cycle (TS6202); `security` named `protocol`'s `BudgetCounters` and `CommandEnvelope`; `tools` named `persistence` types without an edge; `security` and `project-model` author `[S]` schemas without `typebox`. `U0.01` writes every `package.json` from that table and the lockfile is then frozen, so `U0.07`/`U0.08` could not have reached `tsc -b` green. | DESIGN 1.1/1.2 amended BEFORE Wave 0: `RunSnapshotManifest` is a `core` contract (`U0.08`); `BudgetCounters` lives in `@cohorte/base` (`U0.02`, re-exported by `protocol`); `CommandAuthenticator` signs a canonical body (no `protocol` type); type-only edge `tools -> persistence`; `typebox` in `security` and `project-model`; `GlobMatcher` frozen in `@cohorte/security/contract` instead of a second `picomatch` user. `U0.01` proves the table mechanically (`scripts/test/resolve-edges.test.ts`). |
| PC-9 | Test-only workspace edges were not among the "allowed edges": `core -> runtime-fake`, every package `-> testkit`, root `tests/** ->` every package. Under pnpm strictness an undeclared workspace import does not resolve, and adding it changes the lockfile importers, which units may not do. | `U0.01` declares them as `devDependencies` (`workspace:*`); `layers.json` records them as `dev` edges (legal from `test/**`, `tests/**`, `scripts/**` only); `check-layers` fails a `src/**` import into a dev-only package; pnpm's cyclic-workspace warning for `testkit` is accepted and documented. |
| PC-10 | After its wave, no test file is typechecked: `tsc -b` covers `src/` only, tests cannot join the composite projects (`testkit` <-> packages = reference cycle), vitest does not typecheck, and `tsconfig.checks/<unit>.json` runs only during the unit's wave. Every type-level guarantee (I7, S-60, brands, the Pi API `type-proof.ts`) and every script under `scripts/` would be inert in `pnpm verify` and in CI. | Root `tsconfig.tests.json` (`U0.01`): non-composite, `noEmit`, includes `{packages,apps}/*/test/**`, `tests/**`, `scripts/**`, `packages/testkit/**`, `fixtures/**/*.ts`; `tsc -p tsconfig.tests.json` is part of `pnpm verify` and of the CI jobs `typecheck` and `pi-latest` (`U6.INT`). |
| PC-11 | Several contracts frozen at G0 had holes that a later wave would have discovered as a forced amendment: no protocol target for some durable runtime events, no CLI verb / no `--json` schema for some spec-17.2 commands, no `StoreTx.enqueueCommand` for an atomic `start`, no lifecycle edge for a reincarnation that is not a retry, no exit for an environmental TEST failure, `skip` without entry effects, no `SkillManifest` owner, no in-memory `BlobStore`/`RunFiles`/spool before Wave 3. | All amended in DESIGN and delivered by the Wave-0 units named in §8.4. |

## 3. Rules that make parallel work in ONE working tree safe

1. **Exclusive path ownership.** A unit creates and edits files ONLY under its owned paths (plus its own `docs/v3/requests/<unitId>.md`). Inside a parallel wave no two units own overlapping paths, and nested ownership is forbidden too (a directory and one of its children never belong to different units of the same wave). `plan.json` was validated mechanically for this.
2. **Structural files have one owner per wave: the integrator** (Wave 0: the serial units). Structural = root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc`, `.gitignore`, root `tsconfig*.json`, `tsconfig.checks/**`, `biome.json`, `vitest*.config.ts`, `layers.json`, `.github/**`, every package's `package.json` and `tsconfig.json`, every `src/index.ts` barrel, `apps/cli/src/{cli.ts,lazy.ts,contract/**}`, `apps/cli/tsdown.config.ts`, `schemas/**`, `scripts/gen-schemas.ts`, `docs/v3/gates/**`. **No unit ever runs `pnpm install`, `pnpm add` or anything that rewrites the lockfile**: Wave 0 declares every dependency of 3.0 and installs once.
3. **Barrels, stubs and the CLI verb registry are frozen at G0.** Every barrel re-exports from files that already exist as typed stubs (final signature, body `throw new NotImplemented()`); `cli.ts` pre-registers every verb against `commands/<verb>/index.ts`. Later units FILL stub files that lie inside their owned paths; they never edit a barrel, the registry, or another unit's stub.
4. **Imports inside a wave** go only to: Wave-0 frozen contract entry points (`@cohorte/base`, `@cohorte/runtime-contract`, `@cohorte/protocol`, and the `./contract`, `./schema`, `./catalogue`, `./conformance`, `./host-protocol` subpaths), code finished in an EARLIER wave — imported through its AREA subpath (`@cohorte/security/decide/paths`, `@cohorte/persistence/memory`, ...) or a relative path inside the same package —, the `@cohorte/testkit` foundation barrel and testkit area subpaths (tests only), and the unit's own files. Never a sibling's area of the same wave, and **never the barrel (`@cohorte/<pkg>`) of a package that has an active unit in this wave**: a barrel statically loads every area, so a sibling's half-written file would break your typecheck AND your test run. This holds for test files too. Need a sibling's behaviour? Use the testkit fake or a local fake behind the frozen port.
5. **Per-unit checks see only owned code and write nothing shared.** `pnpm --reporter=silent unit:check <unitId>` (§4). It never emits, never touches `.tsbuildinfo`, and downgrades diagnostics located outside the unit's owned paths to warnings, so a sibling's half-written file cannot fail your check.
6. **No shared build output inside a wave.** A unit never runs `tsc -b`, `pnpm build` without `--out`, `gen-schemas` in write mode, or `pack` in a shared directory (`scripts/build.ts` refuses to write `apps/cli/dist` unless `COHORTE_ALLOW_SHARED_DIST=1`). E2E units consume the immutable gate build `.build/gate-<n>/` (resolved by testkit `runCli` from `$COHORTE_E2E_BUILD_DIR` or the highest gate build) or build privately with `node scripts/build.ts --out .build/<unitId>/`. Both kinds of build are RUNNABLE OFFLINE: `build.ts --out` links `<dir>/.publish/node_modules` to `apps/cli/node_modules` (F-7); only `pack-check` needs the network.
7. **Contracts are read-only after G0.** A unit that believes a contract is wrong writes `docs/v3/requests/<unitId>.md` (what, why, proposed change), continues against a local adapter, and the integrator amends the contract at the gate, regenerates schemas and records it in `docs/v3/gates/G<n>.md`. The conformance suites are W0-owned and complete: later units RUN them, nobody "fills" them.
8. **Never commit, never push, never mutate this repository's git state** (index, refs, stash, config, worktrees) — the single exception is `U0.01`'s `git mv`. Tests use temp repositories only. At every gate the integrator runs `COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G<n>`: a binary patch of tracked changes against `HEAD` + a tarball of untracked files, written to `$COHORTE_CHECKPOINT_DIR` (outside the repo). Lead-only commits on `feat/v3-rewrite` are possible only if the human authorises them (H2, §10).
9. **Tests first, and hermetic.** Write the listed tests before the implementation. Discovery is by FILE SUFFIX (`*.test.ts` unit, `*.itest.ts` integration, `*.e2e.ts` e2e, `*.live.ts` live): helpers and data tables under `test/` are never collected and nobody edits the vitest config. House rules: `test.extend` per-test fixtures (no shared mutable fixture), `test.for` for tables, `realpath(mkdtemp())`, hermetic `GIT_ENV`, a THROWAWAY `HOME` for anything that would touch `~/.cohorte` or `~/.pi`, at most 2 vitest workers per unit check, at most 2 Pi children at a time (~200 MB RSS each).
10. **Safety.** Never read, print or copy a credential file (`~/.pi/agent/auth.json`, `~/.codex`, `~/.claude*` credentials, `.env`). Pi tests use `InMemoryCredentialStore` or a temp `authPath` only. `U6.03` is the single unit whose code may touch a real login, and only when a HUMAN runs it with `COHORTE_LIVE=1`.
11. **Every unit ends by running its "Done when" command and printing its output.** A unit is not done while that command is red.
12. `legacy/**`, `.cohorte/**`, `.build/**`, `**/dist/**`, `**/node_modules/**` are excluded from vitest, Biome and every tsconfig; nothing under `legacy/v2` is imported by V3 code (it is read as reference for ports of tables and doctrine).

## 4. Check tooling (delivered by `U0.01`, finalised by `U0.G`)

| Command | What it runs | Who may run it |
|---|---|---|
| `pnpm --reporter=silent unit:check <unitId>` | `node scripts/unit-check.ts <unitId>`: (1) `tsc -p tsconfig.checks/<unitId>.json --noEmit` — the tsconfig is GENERATED from `plan.json` (`include` = the unit's owned TS paths; `composite:false`); diagnostics in non-owned files are printed as warnings; (2) `biome check` on the owned paths that exist; (3) `vitest run --maxWorkers=2 <testPaths>`; non-zero when no test file matched. | any unit |
| `pnpm --reporter=silent verify` | `pnpm install --frozen-lockfile --offline && tsc -b && tsc -p tsconfig.tests.json && biome ci . && node scripts/check-layers.ts && node scripts/check-contract-words.ts && node scripts/gen-schemas.ts --check && vitest run --project unit --project integration` (+ `check-prompts` from G4) | integrators and Wave 0 only |
| `node scripts/build.ts --out <dir>` | gen-schemas (in memory) -> embed-assets -> tsdown (two entries) -> stage-publish -> bundle manifest, all under `<dir>`, then `<dir>/.publish/node_modules` -> symlink to `apps/cli/node_modules` and an offline self-run of both entries from `<dir>` (F-7) | integrators; E2E units with a private `<dir>` |
| `node scripts/pack-check.ts <dir>` | pack from `<dir>/.publish`, install the tarball in an empty temp dir, run both entries, check the tarball allowlist | `U0.10`, integrators, `U5.06` |
| `COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G<n>` | rollback checkpoint (rule 8) | integrators |
| `pnpm --reporter=silent ci:local` (from G6) | every CI job's `pnpm ci:<job>` script, in order | `U6.INT`, humans |

Wave-0 units run whole-tree commands (`tsc -b`, `biome ci`) because they run alone.

## 5. What an integrator does (every gate)

1. Read every `docs/v3/requests/*.md` filed during the wave; apply or reject each one (contracts, dependencies, barrels, vitest/biome config); record the outcome in `docs/v3/gates/G<n>.md`.
2. Run `pnpm --reporter=silent verify`; fix cross-unit defects. It runs alone, so it may patch any file; every patch outside the structural paths is listed in the gate report with the owning unit.
3. Write the wave's walking-skeleton / E2E test (W1-W3: `tests/integration/skeleton/**`; W4+: make the E2E project green on the gate build).
4. `gen-schemas` (write), rebuild `tsconfig.checks/**` if `plan.json` changed, `node scripts/build.ts --out .build/gate-<n>`, `pack-check`.
5. `COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G<n>`; print the exit check's output.


## 6. Waves at a glance

| Wave | Mode | Units | What it delivers | Runnable FakeRuntime path at the gate |
|---|---|---|---|---|
| **W0** | sequential | 11 serial (last = gate G0) | Foundations: legacy move, scaffold, every shared contract, packaging path | — (packed tarball installs and runs both bundle entries) |
| **W1** | parallel | 10 parallel + 1 integrator | Leaves I + walking skeletons: store, git, path/command policy, L0 executor, FakeRuntime, PiRuntime parent vs fake brain, durability, engine, resume | skeleton (a): toy table, engine x journal x SQLite x FakeRuntime, crash/resume at every commit |
| **W2** | parallel | 10 parallel + 1 integrator | The hands: gate chain, tool implementations, CohorteToolHost, approvals, pure decisions + accounting, config loader, Pi probes + test harness | 'hands' skeleton: fake agent through the real gate chain, L0 executor, journal, approvals |
| **W3** | parallel | 10 parallel + 1 integrator | Orchestration: context, run snapshot, supervisor, worktrees + provisioning, phase executors, phase contracts, commit/merge, project model, providers + telemetry | full pipeline, programmatic: build -> test -> review -> fix -> clean -> ship, crash + resume |
| **W4** | parallel | 9 parallel + 1 integrator | Run host + CLI + E2E fixtures (first spec-29-shaped green through the BUILT CLI); L1 sandbox, Pi child, prompts | the G-demo through the BUILT CLI: detach, tail, kill -9, resume, COMPLETED |
| **W5** | parallel | 9 parallel + 1 integrator | Hardening: crash-at-every-transition, security table end to end, more E2E, Pi in the loop, auth CLI, packaging + hash manifest, schema-compat + migrations, protocol integration, dogfood | whole e2e project (e2e, security, crash, dogfood, packaging) on the gate build |
| **W6** | parallel | 3 parallel + 1 integrator | Definition of done: acceptance suite, docs, live smoke runbook, CI workflows, release gate | `pnpm ci:local` = every CI job, incl. acceptance AC-01..AC-12 |

## 7. The waves

### W0 — Foundations: legacy move, scaffold, every shared contract, packaging path

**Mode:** SEQUENTIAL — one unit after another, in the listed order (this wave creates the root).

**Goal.** Move V2 to legacy/v2, scaffold the pnpm + TypeScript 7 monorepo with every dependency declared and ONE install, and freeze every shared contract as compiling, tested code: base + error taxonomy, runtime-contract + complete conformance suite + AgentHostProtocol frames, Cohorte Protocol + event catalogue + generated schemas, StateStore + DDL + MemoryStateStore + complete store conformance suite, config/project-model/security/git/providers/telemetry contracts, tool catalogue, core ports + internal ports + factory signatures, the state-machine kernel (tables, nextStep, evolve), the CLI verb registry, and the two-entry packaging path proven on a packed tarball.

**Green state at the gate.** The repo installs, typechecks (tsc -b), lints, generates schemas, builds ONE tarball with two bundle entries and hashed assets that installs and runs in an empty directory. Every later file already has a home (typed stub, frozen barrel, per-unit tsconfig) and every later unit compiles against real types.

**Exit check.**

```sh
pnpm --reporter=silent verify && node scripts/schema-compat.ts --self && node scripts/build.ts --out .build/gate-0 && node scripts/pack-check.ts .build/gate-0 && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G0
```

| Unit | Title | Depends on | Size |
|---|---|---|---|
| U0.01 | Legacy move + workspace scaffold + layering/check tooling | — | ~1500 lines (mostly config + 5 scripts) |
| U0.02 | @cohorte/base: ids, canonical JSON, error taxonomy + catalogue, Sealed brand; testkit foundation | U0.01 | ~1900 lines |
| U0.03 | Frontier 1: @cohorte/runtime-contract + COMPLETE conformance suite + AgentHostProtocol v1 frames | U0.02 | ~2100 lines |
| U0.04 | Frontier 2, part I: protocol vocabulary, envelope, open enums, strict/open transforms, NDJSON codec, commands, agent-output/finding schemas | U0.02 | ~1900 lines |
| U0.05 | Frontier 2, part II: the complete event catalogue, snapshot documents, one fixture per event type | U0.04 | ~2300 lines (about 1000 of them JSON fixtures) |
| U0.06 | StateStore contract + records + DDL 0001 + MemoryStateStore + COMPLETE store conformance suite | U0.05 | ~2600 lines (largest W0 unit; do the suite first, then the memory store) |
| U0.07 | Host-side contracts I: config/ownership/spec/manifest schemas, project-model contract, security contract, GitPort, providers + telemetry contracts | U0.03, U0.05 | ~2300 lines (do the config schemas and the security contract first; git, project-model, providers and telemetry contracts are small) |
| U0.08 | Host-side contracts II: tool catalogue + core ports, INTERNAL ports, factory signatures, crash-point registry | U0.06, U0.07 | ~2100 lines |
| U0.09 | State-machine kernel: three versioned transition tables, command x state matrix, nextStep, resolveTransition, evolve, agent lifecycle table | U0.08 | ~2000 lines |
| U0.10 | CLI skeleton: verb registry + CliContext contract; the packaging path (two bundle entries, embedded assets, staged publish, bundle manifest, pack check) | U0.09 | ~1700 lines |
| U0.G (integrator) | Gate G0 — contract freeze: barrel/stub audit, gen-schemas + schemas/**, schema-compat --self, first immutable build, rollback checkpoint | U0.01, U0.02, U0.03, U0.04, U0.05, U0.06, U0.07, U0.08, U0.09, U0.10 | ~700 lines |

#### U0.01 — Legacy move + workspace scaffold + layering/check tooling

- **Origin:** DESIGN U0.1 (first half) · **Size:** ~1500 lines (mostly config + 5 scripts) · **Depends on:** —
- **Read first:** DESIGN §1.1, §1.2, §1.4, §7.0, §7.6, §10.1, §11 (D-2, D-4), ADR-0014, ADR-0016, ADR-0017; <SCRATCH>/understand/toolchain.md (§3, §4, §5, §10 + Verification); <SCRATCH>/../proto (the verified toolchain prototype: copy its working tsconfig/tsdown/vitest shapes); <SCRATCH>/understand/v2-profile-tests-ci.md (what the V2 CI runs)
- **Owns:** `legacy/v2/**`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc`, `.gitignore`, `tsconfig.json`, `tsconfig.base.json`, `tsconfig.checks/**`, `biome.json`, `vitest.config.ts`, `vitest.live.config.ts`, `layers.json`, `packages/*/package.json`, `packages/*/tsconfig.json`, `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/daemon/README.md`, `packages/base/test/canary.test.ts`, `apps/cli/test/canary.test.ts`, `scripts/check-layers.ts`, `scripts/check-contract-words.ts`, `scripts/gen-unit-checks.ts`, `scripts/unit-check.ts`, `scripts/checkpoint.ts`, `scripts/test/**`, `tests/integration/canary.itest.ts`, `tests/e2e/canary.e2e.ts`, `tests/security/canary.e2e.ts`, `tests/crash/canary.e2e.ts`, `tests/dogfood/canary.e2e.ts`, `tests/packaging/canary.e2e.ts`, `tests/acceptance/canary.e2e.ts`, `tests/live/canary.live.ts`, `.github/workflows/ci.yml`, `docs/v3/requests/README.md`, `docs/v3/gates/README.md`, `tsconfig.tests.json`, `packages/core/test/canary.edges.test.ts`, `docs/v3/workspace.md`

**Deliverables**

- Legacy move (index operation only, NEVER a commit): `git mv bin core lib profile scripts install.sh install.ps1 package.json .npmignore legacy/v2/` + plain `mv` of untracked gitignored leftovers (`scripts/new-feature.sh`, `scripts/remove-feature.sh`). Stay at root: `LICENSE CHANGELOG.md README.md docs/ .github/` and the brand `assets/` (PLAN PC-2: README images are raw.githubusercontent URLs on `main/assets/`). `legacy/v2/README.md` states: reference only, nothing on the execution path (D8). `pnpm --reporter=silent legacy:test` runs the seven V2 suites from `legacy/v2`.
- Root workspace: `package.json` (private, `packageManager: pnpm@12.4.2`, `engines.node: "^24.16.0 || >=26.1.0"`, scripts `typecheck lint test test:e2e test:live verify unit:check build pack:check gen:schemas checkpoint legacy:test`), `pnpm-workspace.yaml` (packages `apps/*` + `packages/*` only — never `docs/` or `legacy/`; `catalog:` as the single source of versions; `overrides` pinning the three `@earendil-works/*` to `0.85.1` and `typebox` to `1.3.7`; `allowBuilds: false` for `@google/genai`, `esbuild`, `protobufjs`), `.npmrc`, `.gitignore` (+ `.build/ .cohorte/state/ apps/cli/dist/ apps/cli/assets/ apps/cli/.publish/ *.tsbuildinfo dist-types/`; the two V2 script ignores re-pointed under `legacy/v2/`).
- EVERY third-party dependency of 3.0 declared now, ONE `pnpm install`, lockfile frozen afterwards: dev (root) `typescript 7.0.2`, `tsdown 0.23.0`, `vitest ^5.0.1`, `@biomejs/biome 2.5.14`, `@types/node ^24`, `@types/picomatch`, `ajv ^8.20.0`, `ajv-formats`; runtime `typebox 1.3.7` (exact = Pi's pin), `yaml ^2.9.1`, `commander ^15.0.0`, `picomatch ^4.0.7`, `@earendil-works/pi-coding-agent|pi-ai|pi-agent-core 0.85.1` (exact, runtime-pi + apps/cli only). No `tsx` (Node >= 24.16 runs `.ts` natively), no `@anthropic-ai/sandbox-runtime` (in-house backends, ADR-0003).
- All 16 package directories of DESIGN 1.1 + `apps/cli` + `apps/daemon/README.md`: `package.json` (`private`, ESM, source-first `exports`; `dependencies` = EXACTLY the allowed edges of the AMENDED DESIGN 1.1/1.2 — incl. the type-only edge `tools -> persistence`, `typebox` in `security` and `project-model`, NO `picomatch` in `tools` (globs go through security's `GlobMatcher`), and NO `config -> security` / `config -> runtime-contract` / `security -> protocol` edge (PLAN PC-8); `devDependencies` (`workspace:*`) = the TEST-ONLY edges of DESIGN 1.1: `@cohorte/testkit` in every package and in `apps/cli`, `@cohorte/runtime-fake` + `@cohorte/persistence` in `core`, EVERY `@cohorte/*` package in the root `package.json` for `tests/**` and `scripts/**` (PLAN PC-9; pnpm's cyclic-workspace warning for `testkit` is accepted and documented in `docs/v3/workspace.md`); `apps/cli` re-declares every third-party runtime dep = silent-inlining guard AND what makes linked gate builds runnable (PLAN F-7)), `tsconfig.json` (composite, `references` mirror the `dependencies` edges only — test files are not part of the composite projects), placeholder `src/index.ts` (`export {}`) so `tsc -b` has inputs. Subpath exports pre-declared in EVERY package: `.` (the barrel), `./contract` (or `./schema` for config, `./catalogue` for tools, `./host-protocol` for runtime-pi, `./conformance` for runtime-contract and persistence) and the AREA pattern `"./*": "./src/*/index.ts"` (so `@cohorte/security/decide/paths`, `@cohorte/persistence/memory`, `@cohorte/testkit/http-provider` resolve to one area each). PLAN §3 rule 4 depends on this: inside a wave a finished area is imported through its area subpath, never through the barrel of a package that still has an active unit.
- `tsconfig.base.json` = toolchain.md §3 verified flags with `isolatedDeclarations: false` (ADR-0016; TS9010/TS9013 reproduced with TypeBox consts) and `skipLibCheck: true`; `biome.json` (exact 2.5.14, `nursery/noFloatingPromises: error`); `vitest.config.ts` with `projects` unit/integration/e2e selected by FILE SUFFIX exactly as DESIGN 7.0 (no workspace file) + `vitest.live.config.ts`; the `unit` project ALSO collects `scripts/test/**/*.test.ts` (tooling self-tests); exclusions `legacy/** .cohorte/** .build/** **/dist/** **/node_modules/**` in vitest, Biome and every tsconfig (Biome additionally ignores `docs/**`, a VitePress site with its own npm toolchain, and the brand `assets/**`); one canary test per root (`packages/base`, `apps/cli`, every `tests/<suite>`).
- `layers.json` (three edge kinds: normal, `typeOnly` — `core -> persistence`, `tools -> persistence` —, and `dev`) + `scripts/check-layers.ts` (rules a-g of DESIGN 1.2; rule d also fails an import from `src/**` into a package the importer declares only under `devDependencies` and any VALUE import across a `typeOnly` edge; rule g exempts exactly two files: `apps/cli/src/lazy.ts` and `packages/runtime-pi/src/child/load-pi.ts`; incl. `@earendil-works/` confinement, forbidden `node:` imports in core, `as Sealed`, `import(` — rule g applies to shipped code; `packages/testkit/**` is exempt because it is dev-only and never bundled — and the credential-reading identifiers) + `scripts/check-contract-words.ts`. Area subpaths (`@cohorte/<pkg>/<area>`) are checked as the edge `<pkg>`.
- Parallel-work tooling (PLAN §3): `scripts/gen-unit-checks.ts` reads `docs/v3/plan.json` and writes `tsconfig.checks/<unit>.json` (extends base, `composite:false`, `noEmit:true`, `include` = that unit's owned TS paths); `scripts/unit-check.ts <unit>` (tsc with foreign diagnostics downgraded to warnings + `biome check` on owned paths + `vitest run --maxWorkers=2` on the unit's `testPaths` with a PRIVATE vitest cache dir `.build/.vitest/<unit>` (`vitest.config.ts` reads `COHORTE_VITEST_CACHE_DIR`), non-zero when no test file matched) with `--self-test`; `scripts/checkpoint.ts <gate>` (binary patch of tracked changes vs HEAD + tarball of untracked files into `$COHORTE_CHECKPOINT_DIR`, never inside the repo, never a commit).
- `.github/workflows/ci.yml` rewritten: `legacy-v2` job (V2 suites, `working-directory: legacy/v2`) + V3 `lint` / `typecheck` / `unit` skeleton jobs. `publish.yml`, `docs.yml`, `discord-releases.yml` are NOT touched (rewritten only by U6.INT).
- Root `tsconfig.tests.json` (PLAN PC-10): NON-composite, `noEmit`, extends the base config, `include` = `{packages,apps}/*/test/**`, `tests/**`, `scripts/**`, `packages/testkit/**`, `fixtures/**/*.ts` (same exclusions as everywhere). `pnpm typecheck` and `pnpm verify` run `tsc -b && tsc -p tsconfig.tests.json`; the CI `typecheck` skeleton job does the same. This is what keeps every type-level test (`expectTypeOf`, `@ts-expect-error`, the Pi API `type-proof.ts`) and every script under `scripts/` checked AFTER the wave that wrote it.

**Tests first (TDD)**

- discovery canaries: `vitest list` finds every canary; `vitest run tests/packaging` and `vitest run apps/cli` do not end in `No test files found` (the failure the delivery judge reproduced)
- `scripts/test/unit-check.test.ts`: a planted type error in a NON-owned file is a warning, in an owned file a failure; zero matched test files fails
- `scripts/test/check-layers.test.ts`: fixture tree with one violation per rule a-g, each detected; clean tree passes
- `scripts/test/check-contract-words.test.ts`: `piSession`, `phaseId` fail; `capabilities`, `RuntimePin` pass
- legacy: the seven V2 suites are still green when run from `legacy/v2`
- `scripts/test/resolve-edges.test.ts`: for EVERY package, every module name it may import according to the listings of DESIGN §2 and the table of 1.1 (workspace packages, their `./contract`-style subpaths, and third-party deps — the table is data in `layers.json`) resolves from that package's directory; an edge absent from the table does NOT resolve; `tsc -b --dry` reports no cycle (TS6202)
- `packages/core/test/canary.edges.test.ts` imports `@cohorte/runtime-fake`, `@cohorte/persistence` and `@cohorte/testkit` and resolves (test-only edges); the same imports planted under `packages/core/src` fail `check-layers`
- `tsconfig.tests.json` self-test (`scripts/test/tests-typecheck.test.ts`): a temp copy with a planted failing `expectTypeOf` makes `tsc -p tsconfig.tests.json` (and therefore `verify`) fail; the clean tree passes

**Done when**

```sh
pnpm install --frozen-lockfile && pnpm exec tsc -b && pnpm exec tsc -p tsconfig.tests.json && pnpm exec biome ci . && node scripts/check-layers.ts && node scripts/unit-check.ts --self-test && pnpm exec vitest run scripts/test packages/base packages/core/test/canary.edges.test.ts apps/cli && pnpm --reporter=silent legacy:test
```

#### U0.02 — @cohorte/base: ids, canonical JSON, error taxonomy + catalogue, Sealed brand; testkit foundation

- **Origin:** DESIGN U0.1 (base + testkit part), §2.8 · **Size:** ~1900 lines · **Depends on:** U0.01
- **Read first:** DESIGN §0.2 (I7), §2.1, §2.8, §1.3, §7.0
- **Owns:** `packages/base/src/**`, `packages/base/test/**`, `packages/testkit/src/index.ts`, `packages/testkit/src/git-env/**`, `packages/testkit/src/temp-repo/**`, `packages/testkit/src/fixed-clock/**`, `packages/testkit/src/seq-ids/**`, `packages/testkit/src/fault-injector/**`, `packages/testkit/src/fake-redactor/**`, `packages/testkit/test/foundation/**`

**Deliverables**

- DESIGN 2.1 in full, every `[S]` type authored as TypeBox with the static type derived: `ids.ts` (`ID_PATTERN`, brands, `parseId` = the only minting path from input), `ports.ts` (`Clock`, `IdSource`, `Result` + real `systemClock` / uuidv7 `IdSource`), `model.ts`, `usage.ts` (`TokenUsage`, `QuotaInfo` AND `BudgetCounters`: it lives in base because `security`'s `BudgetReader` needs it and `security` may not import `protocol`, PLAN PC-8), `redaction.ts` (`Redaction`, `Sealed<T>`, `Redactor` INTERFACE only), `canonical.ts` (`canonicalJson` sorted keys / no whitespace / NFC, `sha256Hex`), `json.ts`.
- Error taxonomy (spec 24, DESIGN 2.8) — PLAN PC-1: `ErrorClass`, `ErrorInfo` schema, `CohorteError`, `toErrorInfo` (total), `NotImplemented`, AND the append-only `ERROR_CATALOGUE` (every code named anywhere in DESIGN, with class, retryable, impact, remediation, exit code) + `errorOf(code, message, extra?)` live in `base` so L2 packages can mint complete `ErrorInfo`s without importing `core`. The catalogue includes the codes added by the design revision: `security/command-auth-invalid`, `security/project-policy-untrusted`, `security/deps-tampered`, `configuration/worktree-root-protected`, `configuration/provision-store-unavailable`.
- `hmac.ts`: `hmacSha256Hex(key, data)` + `computeAnchorMac(key, runId, atSequence, chainHash)` — the single definition shared by `security` (`CommandAuthenticator.anchor`) and `persistence` (`verifyChain`), which may not import each other.
- testkit foundation (dev-only, never bundled): hermetic `GIT_ENV` (toolchain.md §4 + `GIT_OPTIONAL_LOCKS=0`), `test.extend` temp-repo / temp-dir fixtures built on `realpath(mkdtemp())` with a throwaway `HOME`, `FixedClock`, `SeqIds`, `FaultInjector` (named points, nth occurrence), `fakeRedactor` (the only place outside `security` allowed to cast `as Sealed`). The `@cohorte/testkit` BARREL exports this foundation only; every later testkit area (`fake-brain`, `store-factory`, `http-provider`, `crash`, `run-cli`, `golden`) is reached through its area subpath, so a half-written area can never break a sibling's test run.

**Tests first (TDD)**

- id table: valid/invalid per `ID_PATTERN`, brand kind mismatch rejected, path/ref/token safety
- canonical JSON vectors (key order, NFC, numbers, nested) and sha256 vectors; `computeAnchorMac` vector
- error catalogue: codes unique, `<class>/<slug>` shape, prefix == class, one exit code per class as in DESIGN 2.8, every class has >= 1 code; `toErrorInfo` totality on strings, null, Error, CohorteError, cause depth capped at 5
- uuidv7 ids monotonic per prefix; `FixedClock`/`SeqIds` deterministic; `FaultInjector` fires at the nth hit only
- temp-repo fixture: global/system git config is not read (planted canary config), paths are realpath'd, concurrent tests do not share state (`test.for`, no shared mutable fixture)
- type-level (`expectTypeOf`): a `string` is not assignable to `SealedText`; `Brand<string,'RunId'>` is not a `AgentId`

**Done when**

```sh
pnpm exec tsc -b && pnpm exec biome ci packages/base packages/testkit && pnpm exec vitest run packages/base packages/testkit/test/foundation
```

#### U0.03 — Frontier 1: @cohorte/runtime-contract + COMPLETE conformance suite + AgentHostProtocol v1 frames

- **Origin:** DESIGN U0.A · **Size:** ~2100 lines · **Depends on:** U0.02
- **Read first:** DESIGN §0.1 (C1, C2, C4), §2.2 (all, incl. the 11 conformance rules), §3.3, §3.5, §1.2 (check-contract-words); <SCRATCH>/spike/child/REPORT.md (what the frames must carry; Node 'ipc' channel is the executed transport)
- **Owns:** `packages/runtime-contract/src/**`, `packages/runtime-contract/test/**`, `packages/runtime-pi/src/index.ts`, `packages/runtime-pi/src/protocol.ts`, `packages/runtime-pi/src/parent/index.ts`, `packages/runtime-pi/src/pin/index.ts`, `packages/runtime-pi/src/classify/index.ts`, `packages/runtime-pi/test/protocol/**`, `packages/runtime-fake/src/index.ts`, `packages/runtime-fake/src/fake/index.ts`, `packages/runtime-fake/src/script/index.ts`, `packages/testkit/src/fake-brain/frames.ts`

**Deliverables**

- DESIGN 2.2 in full: `AgentRuntime` VERBATIM from spec 5.1, `AgentRuntimeProvider`, `LoginInteraction`, `RuntimeHostBindings` (contains NO executor: rule C1), `ToolHost`, `RuntimeToolCall/Result`, `SpawnRequest` + parts, `Budget`, `SandboxPolicy`, handle/exit/snapshot, the `RuntimeEvent` union with durability in the type, tri-state `RuntimeCapabilities`, `RuntimePin`, `ProviderAuthStatus`. `role`, tool names, transcript formats are strings, never closed unions. `ContextManifest` is documented as PROVENANCE ONLY (DESIGN 2.2.3): every byte the model sees is in `systemPrompt`, `task` and `continuation.note`. `agent.message.completed.stop` / `model.responded.stop` are a CLOSED five-value set: adapters map any other engine stop reason to `'error'` + `runtime.warning`.
- `@cohorte/runtime-contract/conformance`: `runtimeConformance(factory, opts)` implementing ALL TWELVE numbered rules of DESIGN 2.2 (rule 12 = context installation: `systemPrompt`, then `task`, then the continuation `note`, byte-identical spans, before the first `model.requested`; nothing else from `context` reaches the model; what the model sees is observed through the suite's `opts.modelProbe()` hook — the faux provider's recorded context for Pi, the recorded model input for the fake and the echo runtime) (capability-dependent rules branch on `capabilities()`), plus a ~60-line in-test echo runtime proving the suite runs. Later units only RUN this suite; nobody 'fills' it.
- `packages/runtime-pi/src/protocol.ts`: `AgentHostProtocol` v1 (`ParentFrame`, `ChildFrame`, `EngineSettings`, `Attestation`, `SpawnRequestWire`) as TypeBox, Pi-free, transport-agnostic (`encodeFrame`/`decodeFrame`, usable over the Node 'ipc' channel and over LF-delimited fd 3/4), + `diffAttestation(expected, got)`, which checks `envKeys` against `allow ∪ OS_INJECTED_ENV[platform]` (PLAN F-8; the constant `{ darwin: ['__CF_USER_TEXT_ENCODING'] }` is MIRRORED here from `@cohorte/security/contract/builtin.ts` because runtime-pi may not import security; a test in U0.07 asserts the two copies are equal). Frames added by the design revision: `prompt.note?: { text }`, the `provider.request` frame `{ requestId, origin, authScheme, refused }` of the guard fetch, `ErrorSignal { modelsErrorCode?, causeCode?, httpStatus?, text, origin }` carried by `settled` and `fatal` (the PARENT classifies, DESIGN 3.8), `Attestation.hooks.guardFetchInstalled`, `Attestation.platform`. `testkit/src/fake-brain/frames.ts` re-exports the frame helpers for the Pi-free fake brain.
- Frozen barrels + typed stubs (final signature, body `throw new NotImplemented()`) for `runtime-pi` (`createPiRuntimeProvider({ entryOverride?, sandboxWrapper? })`, `classify`, `pin`) and `runtime-fake` (`createFakeRuntimeProvider`, `FakeScript`, builder).

**Tests first (TDD)**

- schema round-trips for every `[S]` type (valid + invalid samples); `ToolGrant.inputSchema` flat-object rule; tool-name regex and case-collision rule
- conformance self-test: the echo runtime passes all applicable rules
- the suite has teeth: mutant echo runtimes each fail exactly the expected rule (delivers without `handleToolCall` -> rule 1; non-monotonic `seq` -> rule 2; accepts a duplicate incarnation -> rule 3; ignores a bad prompt hash -> rule 6; leaves a timer after `close()` -> rule 9; delivers the note before the task, or drops it -> rule 12)
- frames: every `ParentFrame`/`ChildFrame` variant round-trips through both codecs; unknown `t` and schema violations are rejected, not thrown; `diffAttestation` flags activeTools / envKeys / prompt hash / modelFallback / baseUrl mismatches; `envKeys = ['PATH','__CF_USER_TEXT_ENCODING']` on `darwin` PASSES, the same list on `linux` fails, any name outside `allow ∪ osInjected(platform)` fails, and `NODE_CHANNEL_FD` is not expected in the visible set
- `node scripts/check-contract-words.ts` passes on the package; type-level: `RuntimeHostBindings` has no member able to execute (S-60 seed)

**Done when**

```sh
pnpm exec tsc -b && node scripts/check-contract-words.ts && pnpm exec biome ci packages/runtime-contract packages/runtime-pi packages/runtime-fake packages/testkit && pnpm exec vitest run packages/runtime-contract packages/runtime-pi/test/protocol
```

#### U0.04 — Frontier 2, part I: protocol vocabulary, envelope, open enums, strict/open transforms, NDJSON codec, commands, agent-output/finding schemas

- **Origin:** DESIGN U0.1 (vocabulary) + U0.B (first half) · **Size:** ~1900 lines · **Depends on:** U0.02
- **Read first:** DESIGN §0.1 (C3, C4, C5), §2.3.1, §2.3.2, §2.3.4, §2.9, ADR-0004, ADR-0019; <SCRATCH>/understand/francois-vision.md (R1-R11); <SCRATCH>/understand/francois.md (one-shot 10 s / 4 MiB constraints)
- **Owns:** `packages/protocol/src/vocabulary.ts`, `packages/protocol/src/envelope.ts`, `packages/protocol/src/open-enum.ts`, `packages/protocol/src/compile.ts`, `packages/protocol/src/ndjson.ts`, `packages/protocol/src/commands.ts`, `packages/protocol/src/agent-output.ts`, `packages/protocol/src/refs.ts`, `packages/protocol/test/core/**`

**Deliverables**

- `vocabulary.ts` (DESIGN 2.3.1) — the ONE home of shared pipeline vocabulary so `core`, `config`, `persistence` import it from `protocol` and `protocol` never imports them: `PipelineProfile`, `PipelineState` families, `TransitionReason`, `StopReason`, `AgentState`, `NodeStatus`, `COHORTE_ROLES`, `Severity`, `Actor`, `GuardOutcome`, `StopRecord`, `EscalationStep/Policy`, `CheckResult`; `BudgetCounters` is RE-EXPORTED from `@cohorte/base` (declared there, PLAN PC-8). `StopReason` has the ten of spec 11.2 + EIGHT added (the eighth is `check-environment`, DESIGN 2.5.1 T16). OPEN ON THE WIRE (DESIGN 2.3.1, spec 32: a provisional ADR is never a closed wire enum): `PipelineProfile`, `Actor.transport` (known: `cli`), `SandboxReport.{level,backend,filesystem,network}`, `ResumeReport` verdicts, the authenticator `scheme`.
- `envelope.ts` + `open-enum.ts` + `compile.ts`: `PROTOCOL_VERSION`, `EnvelopeBase` with `(sequence, sub)` ordering and `durability`, `OpenEnum`, generic `compileStrict` (writer side, unknown keys rejected) and `toOpenJsonSchema` (published side: open objects, `x-cohorte-known`, catch-all branch) — generic over an EVENTS table so U0.05 only adds rows.
- `refs.ts`: `PhaseRef`, `AgentRef`, `ArtifactRef`, `RuntimeRef`, `FileTouch`, `SandboxReport`, `RunPlan` (incl. `trust { policySha256, loosenedKeys, grantedBy }`, DESIGN 2.10.1), `ApprovalRequest` (incl. `options?` for the `approval_request` tool; `preStateSha256` = target `beforeSha256` or the slot `treeDigest`), `ResumeReport` (incl. `approvedReplays`).
- `commands.ts` (2.3.4): `CommandEnvelope`, `CommandPayloads` for all 15 command types (`approve.answer?`; `start.consent?: { policySha256, via: 'cli-flag' }` — the trust flag travels in the SIGNED start command; `inspect.target` incl. `{kind:'diff'}` and `{kind:'artifact', artifactId, maxBytes?, offset?}` with the byte cap), the scheme-neutral authenticator field `auth?: { scheme: OpenEnum<'hmac-sha256'>; value }` (NOT a field named `mac`), `canonicalCommandBody` (the envelope MINUS `auth`: exactly what the authenticator covers, and the only thing `security` ever sees of a command), route table (direct-read vs inbox) and controller exit codes as data.
- `agent-output.ts` (2.9): `Finding`, `AgentOutput` (FLAT, everything inlined: it is `submit_result.inputSchema`), `ReviewResult`.
- `ndjson.ts`: `encodeLine`, streaming `LineSplitter` (LF only, U+2028/2029 legal inside strings, 8 MiB line cap, a non-JSON line is a violation RESULT, never a throw).

**Tests first (TDD)**

- vocabulary: `StopReason` = the ten of spec 11.2 in spec order + the eight added (incl. `check-environment`); `COHORTE_ROLES` contains the eleven spec-8 roles + `verifier`; spec-11.1 states all present + `AUTH_REQUIRED`/`QUOTA_EXCEEDED`
- strict vs open on a 2-event mini table: strict rejects unknown keys; open accepts a future event type, a future open-enum value and an extra field; durability cannot differ between strict and open
- NDJSON fuzz table: CRLF, U+2028, 8 MiB boundary, partial chunks, garbage line -> violation
- commands: every `CommandType` has a payload schema, a route and a fixture; `commandId` pattern; `canonicalCommandBody` excludes `auth` and is key-order independent; an envelope with an unknown `auth.scheme` still VALIDATES under the open schema (rejection is the host's job)
- `AgentOutput` JSON Schema has no `$ref/$defs/oneOf` at root, `findings.maxItems = 30`; a `Finding` without location validates (normalisation is core's job, spec 22)
- open-on-the-wire table: a future profile, transport, sandbox backend, resume verdict and auth scheme validate under the OPEN schemas and are rejected by the STRICT writer compile

**Done when**

```sh
pnpm exec tsc -b && pnpm exec biome ci packages/protocol && pnpm exec vitest run packages/protocol/test/core
```

#### U0.05 — Frontier 2, part II: the complete event catalogue, snapshot documents, one fixture per event type

- **Origin:** DESIGN U0.B (second half) · **Size:** ~2300 lines (about 1000 of them JSON fixtures) · **Depends on:** U0.04
- **Read first:** DESIGN §2.3.2, §2.3.3 (every row), §2.3.5, §7.1 (schemas row), §7.5 (AC-05, AC-07); <SCRATCH>/understand/francois-vision.md (R2, R4, R6, R8, R9)
- **Owns:** `packages/protocol/src/index.ts`, `packages/protocol/src/events/**`, `packages/protocol/src/catalogue.ts`, `packages/protocol/src/documents.ts`, `packages/protocol/test/catalogue/**`, `fixtures/schema-compat/3.0.0-dev/**`

**Deliverables**

- `EVENTS` table = one declaration per event type of DESIGN 2.3.3 (payload TypeBox schema + durability): this table IS the catalogue. `EventType`, `Payload<T>`, `Envelope<T>`, `DurableEventType`. No `effect.*` type, no Pi identifier anywhere. Added by the design revision so that the ONE mapper (W3) has a target for every durable runtime event: `tool.rejected` (engine-side refusal: no `toolCallId`, no rule ids — NOT a `tool.denied`), `agent.message.accepted`, `runtime.warning`; `agent.state.changed.reason` is an OpenEnum incl. `recovery | park | pause-expiry` with `attemptConsumed`; `tool.completed.waitedMs` + `filteredPaths?`; `tool.started.replayOfApproval?`; `approval.resolved.commandAuth { scheme, value }` + `answer?`; `command.accepted { authVerified, scheme }`.
- `documents.ts` (2.3.5): `RunSnapshotDocument`, `PhaseNode`, `AgentNode`, `ApprovalView`, `ProjectStatusDocument` + ONE `[S]` document per `--json` output (spec 21): `InspectDocument` (a union over the inspect targets incl. `diff` and `artifact` with its byte cap), `RunDiffDocument` (per-surface files + an `ArtifactRef` per patch), `CommandResultDocument { commandId, type, status, result | error }`, `DoctorReport` (`sandbox` and `runtimeCapabilities` carried as OPAQUE JSON: protocol imports neither security nor runtime-contract), `AuthStatusDocument` (declared here a second time, not imported from runtime-contract: rule C4).
- `fixtures/schema-compat/3.0.0-dev/`: one payload fixture per event type + one fixture per document + one per command (the seed of the schema-compat golden set).
- The frozen `@cohorte/protocol` barrel.

**Tests first (TDD)**

- every event type has >= 1 fixture and it validates under `compileStrict`; every fixture file maps to a known type
- spec-17.1 minimum event list is a subset of `EVENTS`; durability per row equals the literal D/E column of DESIGN 2.3.3 (pinned list)
- identifier scan over all schema keys/enums of THIS package (events, commands, every document): no `pi` token, no engine name (R10, AC-07 seed — the scan is about the protocol frontier, DESIGN 7.5)
- open events schema: `oneOf` over `type` WITH a catch-all branch; `$id` stable
- document fixtures validate; `ProjectStatusDocument.runs` is a strict projection of `RunSnapshotDocument.run`
- every new document has a fixture that validates strictly; `InspectDocument` artifact content above the cap is rejected; `DoctorReport.sandbox` accepts an arbitrary object

**Done when**

```sh
pnpm exec tsc -b && pnpm exec biome ci packages/protocol fixtures/schema-compat && pnpm exec vitest run packages/protocol
```

#### U0.06 — StateStore contract + records + DDL 0001 + MemoryStateStore + COMPLETE store conformance suite

- **Origin:** DESIGN U0.B (persistence half) · **Size:** ~2600 lines (largest W0 unit; do the suite first, then the memory store) · **Depends on:** U0.05
- **Read first:** DESIGN §0.2 (I5, I6, I7), §2.4 (all), §4.1, §4.5, §5.6, ADR-0002, ADR-0022; <SCRATCH>/understand/toolchain.md §2 (node:sqlite facts)
- **Owns:** `packages/persistence/src/index.ts`, `packages/persistence/src/contract.ts`, `packages/persistence/src/records.ts`, `packages/persistence/src/conformance/**`, `packages/persistence/src/memory/**`, `packages/persistence/src/sqlite/index.ts`, `packages/persistence/src/migrate/index.ts`, `packages/persistence/src/blob/index.ts`, `packages/persistence/src/files/index.ts`, `packages/persistence/src/spool/index.ts`, `packages/persistence/test/contract/**`, `packages/persistence/test/memory/**`, `migrations/state/0001_init.sql`, `packages/testkit/src/store-factory/**`

**Deliverables**

- `contract.ts` + `records.ts`: DESIGN 2.4 in full — `StateStore` (async boundary, SYNCHRONOUS transaction body, thenable rejected), `StoreTx`, `LeaseToken`, `EffectIntent`, `EffectKind`, `ReplayClass`, `TransitionRecord`, `LedgerEntry`, `StoredSnapshot`, lock types, `SqlDriver`, `BlobStore`, `RunFiles`, `EphemeralSpool`, and every record type (`RunRecord` ... `CommandRecord`, `RunTreeRows`, `StoreInfo`, `MigrationReport`). Amended contract (PLAN PC-11): `StoreTx.enqueueCommand(cmd): 'enqueued' | 'duplicate' | 'id-reuse-conflict'` (the same rules as `StateStore.enqueueCommand`, INSIDE a transaction), and `transact('project', null, body)` may `putRun` a run that does not exist yet + `enqueueCommand` — that is the ONLY way `start` = `{ run row IDLE, signed start command }` is one atomic write.
- `migrations/state/0001_init.sql`: all 18 tables (`STRICT`, `json_valid` checks, append-only triggers, partial index on open effects), column-for-column equal to the record types. `runs`: NO SQL `CHECK` on `profile` (validated in TypeScript, ADR-0018 is provisional); `snapshot_digest`, `runtime_pin_json`, `plan_json`, `base_sha`, `integration_branch`, `zones_json` are NULLABLE while the run is IDLE (only the host can compute them, in the T04 transaction) with a table `CHECK` that forbids leaving `IDLE | CANCELLED | FAILED` without them; `pinned_install_dir` stays NOT NULL (written by the CLI); `skip_waivers_json`. `commands.auth_scheme` + `auth_value` and `approvals.command_auth_json` (scheme-neutral, not `mac`); `worktrees.deps_manifest_sha256`.
- `@cohorte/persistence/conformance`: `stateStoreConformance(factory: () => Promise<StateStore>, hooks)` — COMPLETE: tx atomicity + rollback, thenable body rejected, gapless sequence + hash chain + `verifyChain` (tamper, gap, duplicate, anchor MAC via `base.computeAnchorMac`), fencing (`conflict/lease-lost`), idempotency of transition / effect (`started | already-done | open`) / approval / command (`duplicate`, `id-reuse-conflict`), allow-once consumed exactly once inside the intent transaction, locks (shared/exclusive, zone overlap by PATH SEGMENT, steal = fencing+1, renew false after steal), inbox claim/finish, **`createRun + start command is atomic; a second start with the same commandId creates no second run and reports duplicate`**, `a run row may leave IDLE only with the six host-computed columns set`, snapshots written after their events and keep-last-3, paginated reads, `expectedSequence`, append-only events, `purgeable`.
- `MemoryStateStore` (dumb: no reducer inside; rollback by structural clone) passing the whole suite — the second implementation that keeps the contract honest and the store every W1-W3 core unit tests against.
- `testkit/src/store-factory`: `makeStore()` = memory by default, a temp-file SQLite store when `COHORTE_TEST_STORE=sqlite` — the SQLite area is loaded LAZILY (`import()` is legal in testkit) so that, during Wave 1, U1.01's half-written store can never be evaluated by a sibling's test run; this is how gate G1 re-runs the core suites on real SQLite.
- Frozen `@cohorte/persistence` barrel + typed stubs: `openSqliteStore`, `createMigrator`, `createBlobStore`, `createRunFiles`, `createEphemeralSpool`.
- In-memory implementations of the OTHER ports of this package, next to `MemoryStateStore` (`packages/persistence/src/memory/**`): `createMemoryBlobStore` (verify-on-read), `createMemoryRunFiles`, `createMemorySpool` — exposed through testkit `store-factory` (`makeBlobStore()`, `makeRunFiles()`, `makeSpool()`), because their first consumers are in W1-W2 (`U1.08` spool port, `U2.07` stage-8 artifacts, the G1/G2 skeletons) while the file-backed ones arrive in W3 (`U3.02`). Three SMALL conformance suites in `@cohorte/persistence/conformance` (`blobStoreConformance`, `runFilesConformance`, `spoolConformance`), green on the memory implementations now and re-run unchanged by `U3.02`.

**Tests first (TDD)**

- the conformance suite itself, written BEFORE `MemoryStateStore`, then green on it
- DDL applies on an in-memory `node:sqlite`; `PRAGMA foreign_key_check` clean; `PRAGMA table_info` columns == record type keys for every table (parity test); `UPDATE events` and `DELETE events` abort unless `runs.purgeable`
- spec-20 minimum concepts (`runs phases agents events artifacts approvals budgets locks migrations`) all exist as tables
- type-level: `appendEvents` rejects an unsealed draft (I7)
- the three small port suites are green on the memory implementations; a tampered memory blob fails verify-on-read; spool tail is ordered by `(sequence, sub)`

**Done when**

```sh
pnpm exec tsc -b && pnpm exec biome ci packages/persistence packages/testkit && pnpm exec vitest run packages/persistence
```

#### U0.07 — Host-side contracts I: config/ownership/spec/manifest schemas, project-model contract, security contract, GitPort, providers + telemetry contracts

- **Origin:** DESIGN U0.C (first half) · **Size:** ~2300 lines (do the config schemas and the security contract first; git, project-model, providers and telemetry contracts are small) · **Depends on:** U0.03, U0.05
- **Read first:** DESIGN §2.6 (all seven subsections), §2.10, §5 (GitPort listing + 5.0), §3.7 (billing table), spec 12-14 via DESIGN 9, ADR-0003, ADR-0022, ADR-0024, §2.10.1, ADR-0011, ADR-0026; <SCRATCH>/understand/v2-security-isolation.md (rule set + precedence ideas to keep)
- **Owns:** `packages/config/src/index.ts`, `packages/config/src/schema/**`, `packages/config/src/load/index.ts`, `packages/config/src/write/index.ts`, `packages/config/src/migrate/index.ts`, `packages/config/test/schema/**`, `fixtures/config/**`, `packages/project-model/src/index.ts`, `packages/project-model/src/contract.ts`, `packages/project-model/src/scan/index.ts`, `packages/project-model/src/init/index.ts`, `packages/project-model/src/desired/index.ts`, `packages/project-model/src/drift/index.ts`, `packages/project-model/src/reconcile/index.ts`, `packages/project-model/test/contract/**`, `packages/security/src/index.ts`, `packages/security/src/contract/**`, `packages/security/src/decide/paths/index.ts`, `packages/security/src/decide/commands/index.ts`, `packages/security/src/decide/gate/index.ts`, `packages/security/src/exec/index.ts`, `packages/security/src/sandbox/index.ts`, `packages/security/src/redact/index.ts`, `packages/security/src/auth/index.ts`, `packages/security/test/contract/**`, `packages/git/src/index.ts`, `packages/git/src/contract.ts`, `packages/git/src/impl/index.ts`, `packages/git/test/contract/**`, `packages/providers/src/index.ts`, `packages/providers/src/contract.ts`, `packages/providers/src/resolve/index.ts`, `packages/providers/src/billing/index.ts`, `packages/providers/src/quota/index.ts`, `packages/providers/test/contract/**`, `packages/telemetry/src/index.ts`, `packages/telemetry/src/contract.ts`, `packages/telemetry/src/logger/index.ts`, `packages/telemetry/src/accounting/index.ts`, `packages/telemetry/test/contract/**`

**Deliverables**

- `@cohorte/config/schema`: `CohorteConfig` (DESIGN 2.10; NO open question frozen as a literal type), `DEFAULT_CONFIG` (schema-valid), `Ownership`, `Spec` (feature|patch, draft|frozen), `Manifest` (with `generated[].renderedSha256`), **`SkillManifest`** (`id, version, appliesWhen, prompt, checks: { name?, argv: string[] }[]`, reserved `signature`/`source`; spec 8's shell-string `command` becomes `argv`, D-25), `provision.{env (closed name allowlist), dependencyDirs, writableCaches}`, and the policy DATA shapes evaluated by security: `CommandRule`, `SymlinkPolicy`, `NetworkPolicyConfig`. Valid + invalid sample YAMLs under `fixtures/config/`. **NOT here: `RunSnapshotManifest`** — it embeds `SandboxCapabilities`, `RuntimeCapabilities` and `RuntimePin`, and `config` importing `security` would close a project-reference cycle (`security` imports `config`): it is a `core` contract (`U0.08`). Added: the key-trust classification `CONFIG_KEY_TRUST` (`tighten-only | loosen | neutral` per JSON-pointer pattern, DESIGN 2.10.1) as frozen DATA, the `TrustRecord` schema and the `TrustStore` PORT (`lookup(projectKeyId, policySha256)`, `grant`, `revoke`) that `security` implements and the loader consumes.
- `@cohorte/project-model/contract`: `ProjectModel` schema (spec 12 fields, five field classes, provenance, `unknowns`), `DriftReport` / `ReconcilePlan` (six diff classes; EXPORTED as a schema for `gen-schemas`: it is the `--json` document of `reconcile --plan`), `InitPlan` — frozen so scan and drift units never import each other.
- `@cohorte/security/contract`: every type of DESIGN 2.6 (`PolicyDecision`, `GateCall`, `NormalizedCall`, `PolicyVerdict [S]`, `AgentGrant [S]`, `PolicyPorts`, `PolicyEngine`, `PolicySnapshot`, `PathResolver`/`ResolvedPath`/`PathViolation`/`CanonicalPath`, `CommandRequest` (NO string form, I3), `ProgramProfile`, `ParsedCommand`/`CommandDenial`, `CommandPolicy`, `ProgramResolver`, `ExecRequest`/`ExecResult`/`Executor`/`SandboxBackend`/`SandboxCapabilities [S]`, `KeyStore`, `CommandAuthenticator` — `sign(canonicalBody: string, key)` / `verify(canonicalBody, value, key)` with `scheme: 'hmac-sha256'`: it signs BYTES and names no `protocol` type —, `SandboxCapabilities` with `filesystem | network: … | 'partial'` and `processEscape`) + the **`GlobMatcher`** contract (`matches`, `isDenied`, `toExcludeArgs(set, 'rg-glob' | 'git-pathspec')`: the ONE glob semantics, consumed by `tools` and `core`) + a `ToolIntrospection` port (`schemaOf(tool)`, `pathArgsOf(tool, input)`) so stage 1/3 can validate without importing `tools`; + frozen DATA in `contract/builtin.ts`: protected roots, default deny globs, the non-overridable trampoline set, the agent git deny set, the L0 env allowlist, **`OS_INJECTED_ENV = { darwin: ['__CF_USER_TEXT_ENCODING'] }`** (PLAN F-8), the protected roots incl. `~/.cohorte/{keys,versions,pi-agent,brains,trust}` and `~/.cohorte/config.yaml`.
- `packages/git/src/contract.ts`: `GitPort` exactly as DESIGN 5 + `RepoFacts`, `GitIdentity`, `SurfaceMap`, `ArtifactDraft`, and the hardened-runner flag/env constants of 5.0.
- providers/telemetry contracts: `resolveModel`, `AuthPolicy`, `BILLING` row type, `costOf`, `parseQuotaHeaders`; `createLogger` (accepts `SealedText` only), `Accounting`.
- Frozen barrels + typed `NotImplemented` stubs for every area listed in the owned paths. The `@cohorte/security` barrel does NOT re-export the `sandbox` area (reached only through `@cohorte/security/sandbox`, by the composition root). Final factory names (`createPathResolver`, `createGlobMatcher`, `createTrustStore`, `createCommandPolicy`, `createPolicyEngine`, `buildPolicySnapshot`, `explainPolicy`, `createExecutor`, `probeSandbox`, `createSeatbeltBackend`, `createBubblewrapBackend`, `wrapForPolicy`, `createRedactor`, `scanForSecrets`, `createKeyStore`, `createCommandAuthenticator`, `createGitPort`, `loadConfig`, `resolveConfig`, `loadSpec`, `freezeSpec`, `writeConfig`, `migrateConfig`, `scanRepository`, `planInit`, `applyInit`, `planReconcile`).

**Tests first (TDD)**

- config: every valid sample validates, every invalid sample fails at the documented JSON pointer; `DEFAULT_CONFIG` is schema-valid; `runtime.id` and provider names are open strings; the D2 triple opt-in shape; `telemetry.remote` is a boolean (rejection is a loader rule, ADR-0013)
- ownership: surfaces disjoint-or-`shared` validator; spec: frozen spec carries a sha256 and rejects edits
- security: `PolicyVerdict`/`AgentGrant`/`SandboxCapabilities` schema samples; type-level: `CommandRequest` has no `script`/string member, `Executor.run` takes argv only, `PolicyPorts` members are synchronous
- builtin data: trampoline set contains `sh bash env npx pi cohorte`...; agent git deny set contains `commit push merge rebase reset checkout switch worktree config update-ref`; protected roots contain `.git`, `.cohorte/**`, `.pi/**`
- every stub throws `NotImplemented`; every barrel export named in DESIGN 1.1 'Public API' exists
- skill: a manifest with `checks: [{ argv: ['pnpm','test'] }]` validates; one with a `command` string fails at the documented pointer
- key-trust data: every key of `CohorteConfig` has exactly one class; the loosening keys of DESIGN 2.10.1 are all classed `loosen`; `provision.env` rejects a name outside the four allowlisted ones
- `OS_INJECTED_ENV` equals the mirror exported by `@cohorte/runtime-pi/host-protocol`; type-level: `CommandAuthenticator.sign` takes a `string`, and `packages/security` has no import of `@cohorte/protocol` (check-layers)

**Done when**

```sh
pnpm exec tsc -b && pnpm exec biome ci packages/config packages/project-model packages/security packages/git packages/providers packages/telemetry fixtures/config && pnpm exec vitest run packages/config packages/project-model packages/security packages/git packages/providers packages/telemetry
```

#### U0.08 — Host-side contracts II: tool catalogue + core ports, INTERNAL ports, factory signatures, crash-point registry

- **Origin:** DESIGN U0.C (second half) · **Size:** ~2100 lines · **Depends on:** U0.06, U0.07
- **Read first:** DESIGN §1.2 (port table), §2.5 (intro + internal ports listing), §2.5.2, §2.5.3 (types only), §2.7, §2.8 (run-effect column), §4.1, §4.3 (the 22 crash points), §6.1 (RunSnapshotManifest), §2.3.3 (mapping table), §4.5
- **Owns:** `packages/tools/src/index.ts`, `packages/tools/src/catalogue/**`, `packages/tools/src/impl/read/index.ts`, `packages/tools/src/impl/write/index.ts`, `packages/tools/src/impl/exec/index.ts`, `packages/tools/src/impl/state/index.ts`, `packages/tools/src/registry/index.ts`, `packages/tools/src/workspace/index.ts`, `packages/tools/test/catalogue/**`, `packages/core/src/index.ts`, `packages/core/src/contract/**`, `packages/core/src/errors/catalogue.ts`, `packages/core/src/durability/crashpoints.ts`, `packages/core/src/*/index.ts`, `packages/core/src/agents/supervisor/index.ts`, `packages/core/src/agents/lifecycle.ts`, `packages/core/src/phases/executor/index.ts`, `packages/core/src/phases/contracts/index.ts`, `packages/core/src/durability/journal/index.ts`, `packages/core/src/durability/lease/index.ts`, `packages/core/test/contract/**`

**Deliverables**

- `@cohorte/tools/catalogue` (DESIGN 2.7): the 9 V3.0 tools + the 3 seams with FLAT input schemas (`git_diff.base: 'run-base' | 'integration' | 'checkpoint'`; `approval_request { question, options? }` whose result echoes `{ decision, answer }`), model-facing descriptions (incl. 'call `submit_result` alone, last'), `effect`, `terminal`, path-argument annotations; `toToolGrant(name)` asserting the flat-schema rule; catalogue-derived `ToolIntrospection`; `ToolImplementation`, `ToolExecContext` (with `requestApproval` / `acceptResult` hooks for the pure-state tools), `ToolRegistry`, `WorkspaceReader`. `ToolImplementation` names `EffectKind`, `ReplayClass`, `EffectIntent`, `EffectRecord` through the TYPE-ONLY edge `tools -> @cohorte/persistence/contract`.
- `core/src/contract/ports.ts`: the port table of DESIGN 1.2 re-exported/declared for core + the ports this plan adds so units never import each other: `ModelResolver`, `ProcessSweeper`, `EffectVerifierRegistry`, `GuardRegistry` + `FactCollector`, `TransitionEffectRunner`, `BillingTable`, `AssetSource`, `InstallInspector`.
- `core/src/contract/internal.ts` — the INTERNAL ports that let core units run in parallel (frozen): `EventWriter`, `EffectJournal` + `EffectSpec`, `ApprovalService` (incl. `approvedUnconsumed`), `ToolHostReplay` (`replayApproved`: the host-side replay of an approved call whose requester is gone, DESIGN 4.5), `AgentSupervisor`, `ContextBuilder`, `RunSnapshotter`, `PinReader`, `WorktreeService`, `Provisioner`, `CommitService`, `MergeService`, `PhaseExecutor`, `Resumer`, `RunEngine`; `WorktreeService.resetClean(slot, to)` (the journaled reset + clean of `_integration` after a check sequence, DESIGN 2.5.2).
- `core/src/contract/types.ts`: `RunState`, `PhaseContract`, `AgentPlan`, `TaskSpec`, `ContextRequest`, `AgentGrantRequest`, `RetryPolicy`, `PhaseOutcome`, `PhaseRunContext`, `PhaseInputContext`, `AgentResult`, `ApprovalDraft`, `LoopState`, `LoopPolicy`, `LoopDecision`, `RoundRecord`, `GlobalFacts`, `HostContext`, `EventDraftInput`, `EphemeralInput`, `SnapshotInput`, `LedgerAudit`, `CheckpointCause`, `TransitionDef`, `TransitionTable`, `Guard`, `GuardContext`; `contract/ids.ts`: `GUARD_IDS`, `TRANSITION_EFFECT_IDS`, `ALL_STOP_REASONS`.
- `core/src/contract/factories.ts`: the `create*` signatures and their `*Deps` types (what the composition root will pass) for every core area; the frozen `@cohorte/core` barrel re-exporting typed `NotImplemented` stubs for every area (`engine resume events durability/journal durability/lease toolhost approvals context snapshot agents/supervisor worktrees provision phases/executor phases/contracts integration loop review pipeline/guards budgets grants projection`).
- `durability/crashpoints.ts`: the `CRASHPOINTS` registry (DESIGN 4.3 names) + `crashpoint(name)` — inert unless `COHORTE_CRASH_AT=<name>[#n]` (real `SIGKILL`) or the in-process `FaultInjector` is armed. `errors/catalogue.ts`: class -> default run effect table of DESIGN 2.8 (re-exports the base catalogue).
- `core/src/contract/snapshot-manifest.ts`: the `RunSnapshotManifest` `[S]` schema of DESIGN 6.1 (incl. `config.trust`) — here and not in `@cohorte/config` because it embeds security and runtime-contract types (PLAN PC-8); `gen-schemas` reads it from `@cohorte/core/contract`.
- `core/src/contract/event-mapping.ts`: the RuntimeEvent -> protocol-event mapping table of DESIGN 2.3.3 as frozen DATA (`RUNTIME_EVENT_TARGETS`: a target event type, `'host-emitted'` for `tool.call.requested`, or `'not-forwarded'` for `tool.call.delivered`), `satisfies`-total over the `RuntimeEvent` union — so the mapper written in W3 (`U3.03`) discovers nothing.

**Tests first (TDD)**

- every tool input schema is one flat top-level object, `additionalProperties:false`, no `$ref/$defs/oneOf`; `toToolGrant` output validates against `ToolGrant`; names match the regex and never differ only by case
- `submit_result.inputSchema` deep-equals the `AgentOutput` JSON Schema; the three seam tools are flagged granted-to-nobody; `pathArgsOf` finds every path argument of every tool
- `CRASHPOINTS` unique and equal to the DESIGN 4.3 list; `crashpoint()` is a no-op without the env var
- class -> run-effect table is total over `ErrorClass`; `security` maps to BLOCKED, unknown throwable to FAILED + checkpoint
- `node scripts/check-layers.ts`: `core/src/contract/**` imports no `node:fs|child_process|sqlite|net`, no runtime-pi, no runtime-fake; every core stub throws `NotImplemented`
- event-mapping totality (type-level + runtime): every `RuntimeEvent['type']` has an entry; every target is a key of `EVENTS` with the SAME durability, except the two documented special cases
- `RunSnapshotManifest` sample validates; `node scripts/check-layers.ts`: every import of `@cohorte/persistence` under `packages/tools/src` is `import type` from `./contract`

**Done when**

```sh
pnpm exec tsc -b && node scripts/check-layers.ts && pnpm exec biome ci packages/tools packages/core && pnpm exec vitest run packages/tools packages/core/test/contract
```

#### U0.09 — State-machine kernel: three versioned transition tables, command x state matrix, nextStep, resolveTransition, evolve, agent lifecycle table

- **Origin:** DESIGN U0.C (tables) + U1.9 (`evolve`, `nextStep`) — pulled into W0 (judge must-fix: a usable reference reducer before two units build against it) · **Size:** ~2000 lines · **Depends on:** U0.08
- **Read first:** DESIGN §0.2 (I10), §2.5.1 (tables, totality tests, command matrix, versioning), §2.5.4, §2.3.3 (run.state.changed), §4.2 (E3-E5), ADR-0018; <SCRATCH>/understand/v2-doctrine.md (CL-* control-logic rules that must live in TS, not prompts)
- **Owns:** `packages/core/src/pipeline/index.ts`, `packages/core/src/pipeline/guards/index.ts`, `packages/core/src/pipeline/tables/**`, `packages/core/src/pipeline/next-step.ts`, `packages/core/src/pipeline/resolve-transition.ts`, `packages/core/src/pipeline/command-matrix.ts`, `packages/core/src/pipeline/idempotency-key.ts`, `packages/core/src/state/**`, `packages/core/src/agents/lifecycle-table.ts`, `packages/core/test/pipeline/**`, `packages/core/test/state/**`

**Deliverables**

- `tables/feature.v1.ts`, `bugfix.v1.ts`, `review.v1.ts` as `as const satisfies TransitionTable` — every row T01-T33 of DESIGN 2.5.1 incl. **T16** (`TEST -> FAILED`, stop `check-environment`, guard `checks.errored-environmental`), T04's guard `config.trust-satisfied`, and **T33's effects = `record-skip` + the entry effects of the success-path row it replaces, DERIVED from the table** (`entryEffectsOf(table, phase)`: TEST -> `mint-review-ref`, REVIEW -> `record-approved-digest{waivedBy:'skip'}`, SHIP -> `release-locks`, `write-ship-report`); `tables/index.ts` = the version registry (unknown version -> `runtime-incompatible`, never re-interpreted).
- `command-matrix.ts`: the command x state matrix of 2.5.1 as DATA (row or defined rejection for every spec-17.2 command in every state).
- PURE kernel: `nextStep(state, table)`, `resolveTransition(table, from, reasonOrOutcome, guardOutcomes)`, `transitionIdempotencyKey(...)`, `evolve(state, durableEvent) -> RunState` as a `satisfies`-total switch over `DurableEventType` (irrelevant events are explicit no-ops), `initialRunState`.
- `agents/lifecycle-table.ts`: `AGENT_TRANSITIONS` (2.5.4) as data, incl. the four REINCARNATION edges `spawning | running | waiting | paused -> spawning` and `ReincarnateCause = 'recovery' | 'park' | 'pause-expiry'`; the rule as data: `attempt` is incremented by `failed -> retrying` and `failed -> escalated` ONLY.

**Tests first (TDD)**

- per profile: reachability; every active state has an exit for every `PhaseOutcome` kind — for TEST three exits keyed by the worst `CheckResult.status`: all passed -> T08, failed and none errored -> T09 (or T24), any errored -> T16; every `StopReason` resolves to exactly ONE row; no row targets a state outside the profile's `phases`
- command x state matrix is total; `retry`/`skip`/`resume`/`cancel` from `FAILED`, `BLOCKED`, `IDLE` are REQUIRED rows; `pause` on suspended and `resume` on active are `{noop}`
- every guard id / effect id used by a row is in `GUARD_IDS` / `TRANSITION_EFFECT_IDS`; row ids unique and stable
- idempotency-key stability (golden vectors); `evolve`: fold(events) is identical whatever the snapshot cut; an ephemeral envelope does not typecheck as input; unknown table version -> incompatible
- `AGENT_TRANSITIONS` total over `AgentState`; `completed`/`cancelled` are terminal
- skip totality: for every skippable phase, `skip` then the normal rows reach COMPLETED (skip REVIEW -> SHIP -> T14 holds through the recorded waiver; it never bounces SHIP -> TEST); a tree change after the skip invalidates the waiver (T15)
- lifecycle totality: from every non-terminal `AgentState`, 'the child is gone' has a legal path to `spawning` that does not increment `attempt`; `retrying`/`escalated` are the only edges with attempt+1

**Done when**

```sh
pnpm exec tsc -b && pnpm exec biome ci packages/core && pnpm exec vitest run packages/core/test/pipeline packages/core/test/state packages/core/test/contract
```

#### U0.10 — CLI skeleton: verb registry + CliContext contract; the packaging path (two bundle entries, embedded assets, staged publish, bundle manifest, pack check)

- **Origin:** DESIGN U0.1 (apps/cli + packaging part) · **Size:** ~1700 lines · **Depends on:** U0.09
- **Read first:** DESIGN §1.2 (net 4: bundle allowlist), §1.3, §1.4 (all six build steps), §2.3.4 (routes, exit codes), §2.8 (CLI exit column), §9 (CLI row + verb semantics paragraph), §4.7, §6.3; <SCRATCH>/understand/toolchain.md §3 (verified tsdown config, silent-inlining hazard, staging dir, asset manifest); <SCRATCH>/understand/francois.md (`--panel`, 10 s / 4 MiB)
- **Owns:** `apps/cli/src/cli.ts`, `apps/cli/src/lazy.ts`, `apps/cli/src/contract/**`, `apps/cli/src/commands/*/index.ts`, `apps/cli/src/compose/index.ts`, `apps/cli/src/host/index.ts`, `apps/cli/src/assets/index.ts`, `apps/cli/src/pin/index.ts`, `apps/cli/src/observe/index.ts`, `apps/cli/src/control/index.ts`, `apps/cli/src/render/index.ts`, `apps/cli/src/panels/index.ts`, `apps/cli/src/doctor/index.ts`, `apps/cli/test/registry/**`, `apps/cli/tsdown.config.ts`, `packages/runtime-pi/src/child/entry.ts`, `scripts/embed-assets.ts`, `scripts/stage-publish.ts`, `scripts/write-bundle-manifest.ts`, `scripts/build.ts`, `scripts/pack-check.ts`, `prompts/README.md`, `skills/README.md`, `migrations/config/README.md`, `apps/cli/src/doctor/checks/auth/index.ts`

**Deliverables**

- `apps/cli/src/cli.ts`: commander tree with EVERY verb of DESIGN §9 (`init doctor discover run status inspect resume pause cancel shutdown approve deny retry skip logs tail diff review fix ship auth providers models config migrate reconcile spec policy gc update brainstorm run-tool send` + hidden `__host`; `config` has the sub-verbs `get set validate trust`) — EVERY spec-17.2 command type has a verb, because one-shot CLI spawns are the only V3.0 transport: `inspect`, `shutdown`, `run-tool` and `send` (= `agent.send`) included; the stubs of `run-tool` and `send` answer `configuration/phase-not-available` unless policy enables them pre-registered against a stub module `commands/<verb>/index.ts`; `lazy.ts` = the ONLY `import(` site (read-only verbs never load core/runtime). Later units fill stubs; nobody edits the registry.
- `apps/cli/src/contract/**`: `CommandModule`, `CliContext` (ports: `openStore`, `Controller`, `Observer`, `HostSpawner`, `Renderer`, runtime providers, clock/ids, stdio — no env dependency for read-only verbs), `DoctorCheck` + the frozen list of doctor check modules, exit-code table (2.8 classes + controller codes 0/2/3/4 + the WAIT rule of DESIGN 2.8: an observer started by `run`, or any `--wait`, exits 0 on COMPLETED, the class code of `run.lastError` on FAILED/BLOCKED, 4 on a suspended state, 16 on CANCELLED; plain `status`/`logs`/`tail`/`--panel` stay 0), and `JSON_OUTPUTS`: the map verb -> published document schema (DESIGN 2.3.5) that the command units' `--json validates` tests read. Also the stub `apps/cli/src/doctor/checks/auth/index.ts` (filled by `U5.05`). This is what lets the command units (W4) be written and tested against fakes while the host is built in parallel.
- Packaging path (DESIGN 1.4), retired NOW: `tsdown.config.ts` with TWO entries (`cli`, `agent-host` -> `../../packages/runtime-pi/src/child/entry.ts`), `deps.onlyBundle: []`, a PER-ENTRY `onlyImport` allowlist (so `cli.mjs` importing Pi fails the build), `define` of `__ASSETS_TREE_SHA256__` / `__COHORTE_VERSION__`; `embed-assets.ts` (byte-order sorted sha256 manifest), `stage-publish.ts` (generated package.json: no devDependencies, no scripts, no `@cohorte/*`), `write-bundle-manifest.ts`, `build.ts --out <dir>` (REFUSES to write the shared `apps/cli/dist` unless `COHORTE_ALLOW_SHARED_DIST=1`; FINISHES by symlinking `<dir>/.publish/node_modules` -> `<repo>/apps/cli/node_modules` and by running `cli.mjs --version` + `agent-host.mjs --selftest` OFFLINE from `<dir>` — PLAN F-7: without the link a gate build cannot resolve `yaml`/`commander`/`typebox`/Pi and no later unit could run the built CLI), `pack-check.ts <dir>` (pack, `npm install --ignore-scripts` in an empty temp dir, run `cohorte --version` and `node dist/agent-host.mjs --selftest`, tarball allowlist (the `node_modules` link is never packed), no test-hook strings, `cli.mjs` imports no `@earendil-works/*`).
- Minimal `packages/runtime-pi/src/child/entry.ts`: `--selftest` imports the three Pi packages, asserts equal versions, prints the Pi version (filled for real by U4.08).

**Tests first (TDD)**

- registry: every DESIGN §9 verb is registered exactly once and appears in `--help`; each stub exits with the documented not-available error + exit code; `--version`
- exit-code table is total over `ErrorClass`; controller codes 0/2/3/4 documented in `--help`
- `embed-assets` is deterministic (two runs, identical `treeSha256`); a tampered asset is detected
- build guard: adding a Pi import to a file reachable from `cli.ts` fails the build (fixture); `build.ts` without `--out` refuses
- acceptance = the packed tarball installs in an empty dir and both entries run
- every `CommandType` of `@cohorte/protocol` has a registered verb, and every verb flagged `--json` has an entry in `JSON_OUTPUTS` whose schema exists in the protocol / project-model / security contracts
- linked build: from `.build/u0-10`, with the network unavailable, both entries run; deleting the `node_modules` link reproduces `ERR_MODULE_NOT_FOUND` (the regression this guards)

**Done when**

```sh
pnpm exec tsc -b && pnpm exec biome ci apps/cli scripts && pnpm exec vitest run apps/cli && node scripts/build.ts --out .build/u0-10 && (cd .build/u0-10 && node .publish/dist/cli.mjs --version && node .publish/dist/agent-host.mjs --selftest) && node scripts/pack-check.ts .build/u0-10
```

#### U0.G — Gate G0 — contract freeze: barrel/stub audit, gen-schemas + schemas/**, schema-compat --self, first immutable build, rollback checkpoint

- **Origin:** DESIGN G0 · **Size:** ~700 lines · **Depends on:** U0.01, U0.02, U0.03, U0.04, U0.05, U0.06, U0.07, U0.08, U0.09, U0.10
- **Read first:** DESIGN §0.1 (C3), §1.4 (step 1), §2.3.2 (compat rules), §7.6 (schema-compat), §10.1 (rules 2, 3, 7, 8), §7.5 (AC-07 scope), ADR-0005
- **Owns:** `schemas/**`, `scripts/gen-schemas.ts`, `scripts/schema-compat.ts`, `docs/v3/gates/G0.md`, `docs/v3/protocol/compat.md`, `package.json`, `tsconfig.checks/**`

**Deliverables**

- `scripts/gen-schemas.ts`: TypeBox -> `schemas/*.schema.json` (OPEN variant): `config`, `project-model`, `spec`, `run-state`, `events`, `agent-output` (the six of spec 4) + `commands`, `project-status`, `inspect`, `run-diff`, `command-result`, `doctor-report`, `auth-status` (protocol documents), `reconcile-plan` (project-model contract), `ownership`, `manifest`, `skill`, `trust-record` (config), `run-snapshot-manifest` (read from `@cohorte/core/contract`, NOT from config), `policy-verdict`, `sandbox-capabilities` (security), `runtime-capabilities` (runtime-contract), `tool-catalogue`. `--check` regenerates in memory and byte-compares with the files — it NEVER relies on `git diff` (nothing is committed on this branch).
- `scripts/schema-compat.ts --self`: every schema compiles under `ajv/dist/2020` strict; every fixture of `fixtures/schema-compat/3.0.0-dev/` validates (the full five-check job is U5.07).
- Freeze audit: every public API named in DESIGN 1.1 is exported; every stub throws `NotImplemented`; `check-layers` + `check-contract-words` green on the whole tree; `pnpm verify` finalised in root `package.json`; `tsconfig.checks/**` regenerated from `docs/v3/plan.json` for every W1-W6 unit.
- `docs/v3/protocol/compat.md` (normative MINOR/MAJOR rules), `docs/v3/gates/G0.md` (what was frozen, open requests), `.build/gate-0/`, rollback checkpoint.

**Tests first (TDD)**

- `gen-schemas --check` fails when a TypeBox source changes without regeneration (fixture)
- ajv strict compile of all schemas; AC-07 seed: the identifier scan finds no Pi identifier in the PROTOCOL schemas — those generated from `@cohorte/protocol` and `@cohorte/runtime-contract` (the list is data exported by `gen-schemas`). `config.schema.json` is OUTSIDE the scan: it legitimately contains `runtime.pi` and `authentication.anthropicSubscriptionViaPi` (DESIGN 7.5, ADR-0005 item 7) — scanning `schemas/**` would make this gate red by construction
- `tsconfig.checks/` contains one file per unit of plan.json W1-W6 and each `include` exists or is creatable

**Done when**

```sh
pnpm --reporter=silent verify && node scripts/schema-compat.ts --self && node scripts/build.ts --out .build/gate-0 && node scripts/pack-check.ts .build/gate-0 && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G0
```

### W1 — Leaves I + walking skeletons: store, git, path/command policy, L0 executor, FakeRuntime, PiRuntime parent vs fake brain, durability, engine, resume

**Mode:** parallel — all units at once, then the integrator alone.

**Goal.** Build, in parallel and against Wave-0 contracts only, the leaves on the critical path and the durable kernel: SQLite store, git mechanics, canonical paths, argv command policy, L0 executor, FakeRuntime, the Pi-free PiRuntime parent proven against a fake brain (skeleton b, part 1), EffectJournal/EventWriter, RunEngine and Resumer. The gate closes walking skeleton (a): engine x journal x REAL SQLite x FakeRuntime on a toy table with a crash/resume at every commit.

**Green state at the gate.** First runnable end-to-end path with the FakeRuntime (programmatic): a toy 2-state run is started, a fake agent's tool call is journaled intent->effect->done on a real SQLite file, the host is 'killed' at every commit and `Resumer` brings the run to the same final state with exactly one `done` per effect key and a valid hash chain. Both conformance suites are green on a second implementation (SQLite store, FakeRuntime, PiRuntime parent + fake brain).

**Exit check.**

```sh
pnpm --reporter=silent verify && COHORTE_TEST_STORE=sqlite pnpm exec vitest run packages/core/test/durability packages/core/test/engine packages/core/test/resume && pnpm exec vitest run tests/integration/skeleton && node scripts/build.ts --out .build/gate-1 && node scripts/pack-check.ts .build/gate-1 && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G1
```

| Unit | Title | Depends on | Size |
|---|---|---|---|
| U1.01 | SqliteStateStore (node:sqlite) + migration runner + backup | U0.G, U0.06 | ~2500 lines |
| U1.02 | security/paths: canonical PathResolver, symlink/hardlink policy, glob semantics, use-time re-verification | U0.G, U0.07 | ~1800 lines |
| U1.03 | security/commands: ProgramProfiles, pinned-PATH resolution, argv CommandPolicy; port of the 70 V2 gate cases + EV-01..EV-13 | U0.G, U0.07 | ~2400 lines (about half is ported test tables) |
| U1.04 | security/exec: the L0 isolated executor (env allowlist, kill-tree + sweep, caps, rlimit wrapper) + sandbox capability probe | U0.G, U0.07 | ~1800 lines |
| U1.05 | git: hardened runner, worktrees, tree digest, trailers, plumbing merge with CAS, immutable review refs | U0.G, U0.07 | ~2300 lines |
| U1.06 | runtime-fake: scriptable deterministic AgentRuntime (FakeScript, YAML loader, builder, FakeLedger) | U0.G, U0.03 | ~1500 lines |
| U1.07 | runtime-pi PARENT (Pi-free) + fake brain child + runtime pin + error classifier — skeleton (b), part 1 | U0.G, U0.03 | ~2500 lines (off the critical path) |
| U1.08 | core/durability: EffectJournal (intent -> effect -> done, replay classes), EventWriter (validate -> seal -> append), lease keeper | U0.G, U0.06, U0.08 | ~1800 lines |
| U1.09 | core/engine: RunEngine loop E0-E8, inbox drain with MAC verification, pause/cancel, checkpoints — skeleton (a) | U0.G, U0.09 | ~2000 lines |
| U1.10 | core/resume: the 11-step recovery procedure, replay-class reconciliation, reconciliation note | U0.G, U0.09 | ~2300 lines |
| U1.INT (integrator) | Gate G1 — integrate Wave 1; walking skeleton (a): engine x journal x REAL SQLite x FakeRuntime with a crash/resume at every commit | U1.01, U1.02, U1.03, U1.04, U1.05, U1.06, U1.07, U1.08, U1.09, U1.10 | ~400 lines of test + integration fixes |

#### U1.01 — SqliteStateStore (node:sqlite) + migration runner + backup

- **Origin:** DESIGN U1.1 (store part; blob/files/spool moved to U3.02) · **Size:** ~2500 lines · **Depends on:** U0.G, U0.06
- **Read first:** DESIGN §0.2 (I6), §2.4 (all, incl. Location + pragmas), §4.1, §4.3 (#22), §5.6, §7.1 (migrations row), §7.2 (SQLite row), ADR-0002; <SCRATCH>/understand/toolchain.md §2 (node:sqlite verified facts, sync-only implications)
- **Owns:** `packages/persistence/src/sqlite/**`, `packages/persistence/src/migrate/**`, `packages/persistence/test/sqlite/**`, `packages/persistence/test/migrations/**`

**Deliverables**

- `openSqliteStore`: `SqlDriver` over `node:sqlite`; pragmas `journal_mode=WAL synchronous=FULL foreign_keys=ON trusted_schema=OFF busy_timeout=5000` + `enableDefensive(true)`; `transact` = `BEGIN IMMEDIATE; assert fencing FIRST; body(tx); COMMIT`, a thenable body is rejected; the complete `StoreTx`; hash chain + `verifyChain` (hash, gap, duplicate, anchor MAC through `base.computeAnchorMac`); locks with zone overlap decided inside one `BEGIN IMMEDIATE`; inbox; effects; ledger; snapshots keep-last-3; lock-free paginated reads. Includes the amended contract of `U0.06`: `StoreTx.enqueueCommand`, run creation inside `transact('project', null, …)` (`putRun` of a new run + the signed start command in ONE `BEGIN IMMEDIATE`), the nullable host-computed `runs` columns with their table `CHECK`, the scheme-neutral `auth_*` columns.
- Migration runner: numbered, monotonic, sha256-pinned files from `migrations/state/`; `migrate('check'|'apply')`; `apply` takes the EXCLUSIVE project lock and calls `backup()` first; an incompatible schema REFUSES with the exact `cohorte migrate --apply` instruction and never deletes or rewrites a run.

**Tests first (TDD)**

- the Wave-0 `stateStoreConformance` suite, UNCHANGED, green on a temp-file SQLite store
- 3 processes x 400 `BEGIN IMMEDIATE` transactions (forks): no lost update, gapless sequences
- SIGKILL of a reader mid-read never blocks the writer; append-only triggers abort `UPDATE/DELETE events`
- chain tamper (row edit, gap, duplicate) and rewritten chain without the key (anchor MAC) are detected; zombie writer fails with `conflict/lease-lost` (S-34 seed)
- migrations: monotonic; an edited migration file is refused (sha pin); a synthetic `0002` applies after a backup; incompatible version refuses with instruction, run rows untouched
- two PROCESSES issuing `start` with the same `commandId` concurrently: exactly one run row, one `pending` command, the loser gets `duplicate`

**Done when**

```sh
pnpm --reporter=silent unit:check U1.01
```

#### U1.02 — security/paths: canonical PathResolver, symlink/hardlink policy, glob semantics, use-time re-verification

- **Origin:** DESIGN U1.2 (split 1/3) · **Size:** ~1800 lines · **Depends on:** U0.G, U0.07
- **Read first:** DESIGN §0.2 (I2, I4, I11), §2.6.1 (AgentGrant globs), §2.6.3 (the 8-step algorithm), §7.4 (S-01..S-13), spec 23; <SCRATCH>/understand/pi-tools.md (why Pi built-ins give zero confinement); <SCRATCH>/understand/toolchain.md §7 (glob semantics that affect security)
- **Owns:** `packages/security/src/decide/paths/**`, `packages/security/test/decide/paths/**`

**Deliverables**

- `createPathResolver`: steps 1-7 of DESIGN 2.6.3 — input hygiene (NUL/control, length, `~`, env syntax, drive/UNC), NFC, component walk with `lstat`, symlink modes (`deny-outgoing | deny-all | allow`), final-component symlink on write, realpath of the deepest existing ancestor (on-disk case), containment by PATH SEGMENTS (never `startsWith`), built-in protected roots (not overridable), hardlink/special-file rules, picomatch `{dot:true, nocase:false}` with deny sets first, slash-less pattern = `**/<p>`, `dir/**` matches `dir`. Never throws: returns `Result<ResolvedPath, PathViolation>`.
- Use-time helpers (step 8) for the tools units: `openVerified` (`O_NOFOLLOW`, `fstat`, `(dev,ino)` compare) and `writeAtomicVerified` (temp file `O_CREAT|O_EXCL|O_NOFOLLOW` in the same canonical dir, `fsync`, re-`realpath`, `rename`).
- `createGlobMatcher` — the implementation of the `GlobMatcher` contract (`matches`, `isDenied(path, grant, intent)`, `toExcludeArgs(set, 'rg-glob' | 'git-pathspec')`): the SAME picomatch options and the same slash-less / `dir/**` rules as step 7, exported so that `tools` (output filtering of `list_files`, `search`, `git_diff`) and `core` never configure picomatch themselves.

**Tests first (TDD)**

- S-01..S-13 as one `test.for` table: `../` escape, absolute outside roots, outgoing symlink, symlink to a sibling surface, final-component symlink write, symlink swapped between gate and use (`(dev,ino)`), `.ENV` on a case-insensitive volume, NFC, hardlinked file on write, NUL byte, `src/backend-evil` vs `src/backend/**`, `.git` file + nested `.git`, `.cohorte/state/cohorte.db`, Pi `auth.json` path shape, install dir, FIFO/device
- glob semantics table (dot files, slash-less patterns, `dir/**` vs `dir`, deny beats allow)
- property: arbitrary byte strings never throw and never resolve outside the roots
- `GlobMatcher`: `toExcludeArgs` round-trip — for a table of deny sets, the paths excluded by real `rg --glob` / `git grep` pathspecs (when the binaries exist) equal the paths `isDenied` rejects
- path-table case: an agent path under a worktree root that lies inside a protected root (`<project>/.cohorte/worktrees/…`) is `protected-root` — the reason `U2.09` refuses such a `git.worktreeRoot` at config resolution (DESIGN 2.6.3 step 5)

**Done when**

```sh
pnpm --reporter=silent unit:check U1.02
```

#### U1.03 — security/commands: ProgramProfiles, pinned-PATH resolution, argv CommandPolicy; port of the 70 V2 gate cases + EV-01..EV-13

- **Origin:** DESIGN U1.2 (split 2/3) · **Size:** ~2400 lines (about half is ported test tables) · **Depends on:** U0.G, U0.07
- **Read first:** DESIGN §0.2 (I3), §2.6.4, §7.4 (V2 port table + MUST-DENY evasions), ADR-0024, ADR-0007; <SCRATCH>/understand/v2-security-isolation.md (full V2 rule set, the 70 cases, the 11 confirmed evasions); legacy/v2/scripts/test-gate.mjs (the V2 test table to port — port the TABLE, not the substring matcher)
- **Owns:** `packages/security/src/decide/commands/**`, `packages/security/test/decide/commands/**`

**Deliverables**

- `ProgramProfile`s for `git pnpm npm yarn node docker` (structural `parse` into globals/subcommand/flags/positionals; re-targeting global options denied: `git -C/-c/--git-dir/--work-tree...`, `pnpm -C/--dir`, `npm --prefix`, `node -e/-p/-r/--import/--loader`); alias normalisation (`docker-compose`).
- `ProgramResolver` through the PATH pinned at run start, then realpath (a repo-local shim or a planted binary can never stand in).
- `createCommandPolicy` evaluation, steps 1-6 of 2.6.4: bare-name `argv[0]`; non-overridable trampoline deny set (incl. `pi` and `cohorte`); built-in agent git deny set (D9); profile match by `(program, subcommand, flags, positionals)`, programs without a profile only by `exact` argv; no rule => DENY; deny > ask > allow; `cwd` inside the agent's own worktree; detached/unknown branch = PROTECTED; `dangerousCommands` = exact argv, always `ask`; `config.checks` become `exact` rules with `replay: idempotent`.

**Tests first (TDD)**

- `commands.v2-port.test.ts`: V2 groups A1-A19 and B1-B15 with the V3 expectations of DESIGN 7.4 (input is `{argv, cwd}`, never a shell string); A11 deny-over-ask made non-vacuous; A16 `['sh','-c',...]` => `security/command-trampoline`
- `must-deny.evasions.test.ts`: EV-01..EV-13, each asserting the verdict AND the mechanism (no quote removal, no variables, no pipes, realpath resolution, alias normalisation, git global options, cwd containment)
- program resolution: `Node`, `./node`, PATH-planted binary, symlinked shim
- property: every returned verdict fragment is schema-valid

**Done when**

```sh
pnpm --reporter=silent unit:check U1.03
```

#### U1.04 — security/exec: the L0 isolated executor (env allowlist, kill-tree + sweep, caps, rlimit wrapper) + sandbox capability probe

- **Origin:** DESIGN U1.3 (split 1/3; L1 backends -> U4.07, redact/auth -> U2.02) · **Size:** ~1800 lines · **Depends on:** U0.G, U0.07
- **Read first:** DESIGN §0.2 (I3), §0.3, §2.6.6 (ExecRequest/ExecResult, L0 row), §4.4 (step 5: orphan sweep), §7.4 (S-20..S-24), ADR-0003; <SCRATCH>/understand/toolchain.md §8 (verified kill-tree and ulimit behaviour on macOS)
- **Owns:** `packages/security/src/exec/**`, `packages/security/test/exec/**`

**Deliverables**

- `createExecutor` (L0, every OS): verified canonical cwd; env built ONLY from `ExecRequest.env` (never `process.env`); `detached:true` + process-group `TERM -> grace -> KILL`; `(pgid, startToken)` recorded through a pid-registry port and removed at exit; post-run SWEEP for processes that left the group (`escapees`), also callable on demand by the Resumer; wall-clock and stream-drain timeouts; output cap that KILLS on overflow; `ulimit -t/-f/-n/-u` through the compile-time-constant wrapper `/bin/sh -c 'ulimit ...; exec "$0" "$@"'` (the only shell in the product, positional args only); chunks sealed through the `Redactor` port; `SandboxBackend` plumbing with the `none` backend. `ExecRequest.fs.readOnly` roots INSIDE a write root are part of the contract now (the slot's dependency directories, DESIGN 5.7): L0 records them as advisory; the L1 backends (`U4.07`) enforce them.
- `probeSandbox()` -> `SandboxCapabilities` (detects `sandbox-exec` / `bwrap` presence; reports L0 honestly until U4.07 lands); `require: 'native'` with no usable backend => `security/sandbox-unavailable` with the `doctor` remediation.

**Tests first (TDD)**

- S-20: with `ANTHROPIC_API_KEY=canary GH_TOKEN=canary` in the parent env, NO canary name or value is visible to a `node` child, and every visible name lies in `allow ∪ OS_INJECTED_ENV[process.platform]` (PLAN F-8: on macOS a clean-env Node child reports `__CF_USER_TEXT_ENCODING` too, so an exact-equality assertion cannot pass)
- S-21: timeout kills a grandchild that ignores SIGTERM; S-22: a `setsid` escapee is found by the sweep; S-23: the output cap kills; S-24: fork bomb bounded where `processes` is enforced, REPORTED otherwise (never silently skipped)
- I3: arguments containing `; && | $()` and newlines reach the program as literal argv through the ulimit wrapper
- `ExecResult.guarantees` equals `probeSandbox()`; never kills on a bare pid (startToken mismatch => no kill)

**Done when**

```sh
pnpm --reporter=silent unit:check U1.04
```

#### U1.05 — git: hardened runner, worktrees, tree digest, trailers, plumbing merge with CAS, immutable review refs

- **Origin:** DESIGN U1.4 · **Size:** ~2300 lines · **Depends on:** U0.G, U0.07
- **Read first:** DESIGN §5 (GitPort), §5.0, §5.1, §5.4, §5.5, §5.8, §7.2 (worktrees row), §7.4 (E1-E9, F1, S-70), ADR-0007, ADR-0008, ADR-0021; <SCRATCH>/understand/v2-security-isolation.md (content-addressed tree digest, E1-E9 cases); <SCRATCH>/understand/toolchain.md §4 (macOS realpath rule, porcelain parsing test)
- **Owns:** `packages/git/src/impl/**`, `packages/git/test/impl/**`

**Deliverables**

- `createGitPort`: EVERY invocation through the hardened runner of 5.0 (`execFile`, no shell, hooks off, `core.fsmonitor=`, `protocol.allow=never`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, explicit identity, `--porcelain=v2 -z`, `--no-ext-diff --no-textconv`).
- All `GitPort` methods: `facts` (git >= 2.38), `treeDigest` (V2 port: temp index, 5 s backdate, excludes, real index untouched), `addWorktree`, `switchToNewBranch`, `removeWorktree`, `resetHardClean` (refuses any path outside the worktree root), `commitAll` + trailers, `findCommitByTrailer`, `mergeTree`/`commitTree`/`updateRefCas`, `createRef`, `diffBySurface`, `changedPaths`.

**Tests first (TDD)**

- tree digest E1-E9 incl. E9 'real index untouched'; F1 inverted (a green result from another worktree does not validate this one)
- concurrent `worktree add`; EXACT whole-line porcelain match; paths with spaces/unicode; detached HEAD
- `mergeTree` clean + conflict; `updateRefCas` race returns `moved`; review ref never moves
- S-70 hook canary: a husky-style fixture (`core.hooksPath=.husky/_`, gitignored hook writing a canary) goes through commit, merge and `worktree add` — the canary never appears
- `commitAll` twice with identical content is content-idempotent; trailer lookup finds exactly one commit

**Done when**

```sh
pnpm --reporter=silent unit:check U1.05
```

#### U1.06 — runtime-fake: scriptable deterministic AgentRuntime (FakeScript, YAML loader, builder, FakeLedger)

- **Origin:** DESIGN U1.5 · **Size:** ~1500 lines · **Depends on:** U0.G, U0.03
- **Read first:** DESIGN §0.1 (C1), §2.2 (conformance rules), §3.10, spec 29 (Pi replaceable by a fake runtime)
- **Owns:** `packages/runtime-fake/src/fake/**`, `packages/runtime-fake/src/script/**`, `packages/runtime-fake/test/**`

**Deliverables**

- `createFakeRuntimeProvider`: in-process `AgentRuntime` with NO timers and NO randomness unless scripted, running on the injected `Clock`/`IdSource`; every scripted tool step goes through the REAL `ToolHost` (rule C1) — that is what makes 'Pi replaceable by a fake' a meaningful test.
- `FakeScript` `[S]` (DESIGN 3.10 verbatim: `say think tool submit usage await-message fail hang crash stop-without-result model-request`), YAML/JSON loader, fluent builder; matching on `SpawnRequest` fields ONLY (role, agentId glob, incarnation, attempt) — the fake knows no phases (R10); unmatched spawn => `configuration/fake-script-unmatched`.
- `FakeLedger` of every `SpawnRequest` (retry byte-identity assertions); `pin()` hashes the script; honest `capabilities()`; trivial `authStatus/login/logout` (`authSource: 'none'`).

**Tests first (TDD)**

- the Wave-0 `runtimeConformance` suite (12 rules, incl. rule 12: a scripted probe sees `task` then the continuation `note`, byte-identical), UNCHANGED, green
- one test per `FakeStep` kind; `hang` and `crash` honour `cancel`; `incarnation` matching ('first incarnation crashes after two writes, second finishes')
- `model-request` step drives `authSource`/`baseUrl`/quota fields (feeds the auth-mode-violation tests later)
- ledger: a retry's `SpawnRequest` minus `incarnation` is byte-identical

**Done when**

```sh
pnpm --reporter=silent unit:check U1.06
```

#### U1.07 — runtime-pi PARENT (Pi-free) + fake brain child + runtime pin + error classifier — skeleton (b), part 1

- **Origin:** DESIGN U1.6a · **Size:** ~2500 lines (off the critical path) · **Depends on:** U0.G, U0.03
- **Read first:** DESIGN §3.1, §3.2, §3.3, §3.5, §3.7 (layers 1, 5), §3.8, §3.9, §7.2 (parent <-> child row), ADR-0001, ADR-0015; <SCRATCH>/spike/child/REPORT.md + spike/child/src/agent-process.mjs (the EXECUTED Node 'ipc' transport, kill ladder timings, Seatbelt run); <SCRATCH>/understand/pi-rpc.md, pi-delta-rpc-tools.md (+ Verification sections)
- **Owns:** `packages/runtime-pi/src/parent/**`, `packages/runtime-pi/src/pin/**`, `packages/runtime-pi/src/classify/**`, `packages/runtime-pi/test/parent/**`, `packages/runtime-pi/test/pin/**`, `packages/runtime-pi/test/classify/**`, `packages/testkit/src/fake-brain/child.ts`, `packages/testkit/src/fake-brain/scripts/**`

**Deliverables**

- `createPiRuntimeProvider` / `PiRuntime` parent — imports NO Pi: spawn `<pinned node> <pinned entry>` (or `entryOverride`, tests only) with `stdio ['ignore', 'pipe', 'pipe', 'ipc']`, `serialization:'json'` — the child's stdout/stderr are PIPES that the parent line-buffers (64 KiB line cap, 1 MiB per incarnation) and writes through the SEALED logger port into `host.log`, never a raw file: Pi can print refresh/login error bodies containing token material (DESIGN 3.2, I7) —, `detached`, cwd = the agent state dir, env = the allowlist of 3.7 layer 1 (the attested names are checked against `allow ∪ OS_INJECTED_ENV[platform]`, PLAN F-8); the `prompt` frame carries the task text AND, for a later incarnation, `note.text` (both read and hash-verified by the parent); ONE `FrameTransport` interface with two codecs (Node 'ipc' channel first = what the spike executed; LF-delimited fd 3/4 as the drop-in alternate); optional `sandboxWrapper(policy) -> argv` injection.
- Protocol engine: `hello(nonce)` -> `init` -> `ready(attestation)` verified with `diffAttestation` — the spawn FAILS CLOSED on any mismatch; `ToolCallId = tc_<incarnation>_<ordinal>` assigned by the parent; `tool.call` -> `ToolHost.handleToolCall`; tool-boundary pause latch; model-boundary via `pause` frame with `stop-after-turn` fallback; cancel ladder (settle pending calls first -> `abort` -> 5 s -> SIGTERM group -> 2 s -> SIGKILL); heartbeat (3 missed => ladder); `disconnect` => `crashed`; parent-side budget belt; PER-REQUEST assertion (layer 5) on the guard fetch's `provider.request` frames — origin == the pinned `baseUrl` origin, `authScheme` as planned, `refused == false` — and only then the echoed `effectiveModel`/`authSource`; `frames.ndjson` wire log.
- `pin()` + per-spawn verification (dist files, the three Pi package trees, lock evidence, node; stat cache keyed by `(dev, ino, size, mtimeNs)`); `classify/` = a PURE function `classify(signal: ErrorSignal): ErrorInfo` over the WIRE shape `{ modelsErrorCode?, causeCode?, httpStatus?, text, origin }` — this area is Pi-free, so `instanceof ModelsError` cannot be evaluated here; only child code (`U4.08`) looks at engine classes. The table of DESIGN 3.8, where `modelsErrorCode` alone is NOT a discriminator: `auth` + "Credential store (read|modify|delete) failed" or `causeCode ∈ {ELOCKED, EPERM, EACCES, EBUSY}` -> `provider-transient/credential-store-locked`; `auth` + "Provider is not configured" / "No API key" -> `provider-terminal/auth-required`; `oauth` + a network-class cause -> `provider-transient/network` (bounded retry); any other `oauth` -> `auth-required`. Pi's `stopReason` is never a discriminator. `pin()` SKIPS the `install-lock` artifact for a linked development build (PLAN F-7) and says so in `diagnostics`.
- testkit fake brain child: Pi-free, speaks `AgentHostProtocol`, scripted (attestation overrides, tool calls, heartbeat suppression, stubborn mode ignoring `abort`, grandchild spawn).

**Tests first (TDD)**

- `parent-fake-brain.itest.ts`: framing on BOTH transports; attestation mismatch (activeTools != grant, env key outside `allow ∪ OS-injected`, prompt hash, `modelFallback`, baseUrl, `guardFetchInstalled: false`) => spawn refused — and a CLEAN fake brain on macOS, which reports `__CF_USER_TEXT_ENCODING`, is ACCEPTED; heartbeat loss => ladder; stubborn child + grandchild reaped; `disconnect` => `crashed`; parent SIGKILL => the fake brain exits
- the Wave-0 `runtimeConformance` suite green on parent + fake brain
- classifier: one case per row of the 3.8 table, incl. the three `auth` rows (store locked / not configured / unclassified) and the two `oauth` rows (network cause -> transient, otherwise auth-required) — all on plain `ErrorSignal` fixtures, no Pi import; unknown tool proposed / frame schema violation => `security/*`
- pin: a tampered file => `security/runtime-pin-mismatch`; the stat cache re-hashes on change
- env canary: parent env `OPENAI_API_KEY=canary` is not visible to the child (attested env key NAMES)
- stderr canary (S-53 seed): a token-shaped canary printed by the fake brain on stderr is absent from `host.log` (sealed), and a 2 MiB stderr flood is truncated, not buffered
- layer 5: a fake brain reporting a `provider.request` with a foreign origin, or with `authScheme: 'api-key-header'`, => `security/auth-mode-violation`; a run whose model requests have NO matching `provider.request` frame fails the same way
- `prompt` frame with a `note`: the fake brain echoes what it received — task then note, byte-identical (rule 12 on parent + fake brain)

**Done when**

```sh
pnpm --reporter=silent unit:check U1.07
```

#### U1.08 — core/durability: EffectJournal (intent -> effect -> done, replay classes), EventWriter (validate -> seal -> append), lease keeper

- **Origin:** DESIGN U1.10 (split 1/3) · **Size:** ~1800 lines · **Depends on:** U0.G, U0.06, U0.08
- **Read first:** DESIGN §0.2 (I5, I6, I7), §2.5 (EventWriter, EffectJournal, EffectSpec), §4.1 (both tables), §4.2 (E0), §4.3 (#6, #12, #13), §4.5 (grant consumed in the intent tx), §7.1 (idempotency keys row)
- **Owns:** `packages/core/src/durability/journal/**`, `packages/core/src/durability/lease/**`, `packages/core/src/events/**`, `packages/core/test/durability/**`, `packages/core/test/events/**`

**Deliverables**

- `createEventWriter`: strict validate (`compileStrict`) -> summary/severity table (one line, <= 200 chars, no tabs/newlines) -> `Redactor.seal` -> `tx.appendEvents`; a redactor exception REPLACES the event by `error{security/redaction-failed}` and drops the raw payload; ephemerals go to the spool port and never to the store; `summary` has every C0/C1 control character replaced before validation (DESIGN 2.3.6); ORDERING UNDER BATCHING (DESIGN 2.3.2): `ephemeral()` enqueues behind the pending durable drafts of the same agent and stamps `(sequence, sub)` only after that batch committed (or flushes the batch first). Tests use the Wave-0 in-memory spool / run files (`makeSpool()`, `makeRunFiles()`): no private fakes.
- `createEffectJournal().run(lease, spec, signal)`: tx A (`beginEffect` + `before` events [+ `consumesGrant`]) -> `perform` -> tx B (`completeEffect` + `after` events + ledger + post state); `already-done` => `{status:'replayed'}` without re-executing; `open` => verifier policy hook; the ONLY caller of `Executor`, `GitPort` mutators and `AgentRuntime.spawn` (I5); crash points `*.after-intent`, `*.after-effect`, `*.after-done`.
- Idempotency-key builders for every effect kind of the 4.1 table; lease keeper (renew every 5 s, TTL 15 s; a lost lease stops every further effect with `conflict/lease-lost`).

**Tests first (TDD)**

- `keys.test.ts`: duplicate effect => replayed, nothing re-executes; allow-once grant consumed EXACTLY once across a simulated crash between tx A and tx B (`FaultInjector`)
- I5: a spy executor is reachable only through `run()`; an effect without a committed intent cannot start
- EventWriter: unknown payload key rejected; redactor throwing => event replaced, payload dropped; summary rules; type-level: an unsealed draft does not compile
- lease lost mid-run => next tx fails, journal stops; all suites run on `makeStore()` (memory now, SQLite at the gate)
- interleaving under batching: with durable drafts of message 1 still pending, deltas of message 2 are stamped AFTER `agent.message.completed` of message 1 in `(sequence, sub)` order; a `summary` containing `\x1b[2K` or a newline is stored without control characters

**Done when**

```sh
pnpm --reporter=silent unit:check U1.08
```

#### U1.09 — core/engine: RunEngine loop E0-E8, inbox drain with MAC verification, pause/cancel, checkpoints — skeleton (a)

- **Origin:** DESIGN U1.10 (split 2/3) · **Size:** ~2000 lines · **Depends on:** U0.G, U0.09
- **Read first:** DESIGN §0.2 (I10, I12), §2.5 (RunEngine), §2.5.1 (command matrix), §2.3.4 (routes, results), §4.2, §4.3 (#1, #4, #5, #17-#20), §4.6, §4.7, §2.8 (unknown throwable)
- **Owns:** `packages/core/src/engine/**`, `packages/core/test/engine/**`

**Deliverables**

- `createRunEngine`: the loop E0-E8 of DESIGN 4.2 on the Wave-0 kernel (`nextStep`, `resolveTransition`, `evolve`); guards through the injected `GuardRegistry` + `FactCollector`; transition effects through `TransitionEffectRunner`; phases through the `PhaseExecutor` port; `checkGlobalStops` injected (real one = U2.05).
- Inbox drain E1: authenticator verified BEFORE anything else — the engine computes `canonicalCommandBody(envelope)` and hands BYTES + `auth.value` to the `CommandAuthenticator` port (which knows no protocol type); an unknown `auth.scheme` is rejected like a bad value; `actor` is NORMALISED before it is recorded (DESIGN 2.6.7: `kind: 'human'` is kept only for `transport: 'cli'`, never upgraded; rows whose `TransitionDef.actor` is `human` fire only from an accepted command, never from the engine itself) —, one tx per command (`claim; command.accepted; events; finish; command.completed|rejected`), two tx for commands with external effects; command x state matrix applied from the Wave-0 data; `expectedSequence` guard; `{noop}` results.
- Pause (complete only when `PAUSED` is committed) and cancel (durable flag first, then effects, then `CANCELLED`); `checkpoint.created` with chain MAC anchor and `writeSnapshot` AFTER the events (spec 11.3); unknown throwable => `FAILED` + `checkpoint.created{cause:'fatal'}`.

**Tests first (TDD)**

- toy 2-state table LOCAL to the tests + `makeStore()`: run to `COMPLETED`; table-driven from the Wave-0 matrix: every command in every state => the row's transition or its defined rejection
- forged / missing MAC => `command.rejected{security/command-auth-invalid}`, never applied; replayed `commandId` no-op; same id + other body => `conflict/command-id-reuse`
- pause/cancel orderings; events-before-snapshot; fatal handler path
- in-process crash at every engine crash point (`FaultInjector`) then a fresh engine => identical final state (`recordTransition` duplicate is a no-op)
- identity: an envelope claiming `actor.kind: 'human'` over a non-`cli` transport is recorded as `client`; the engine never emits a transition with actor `human` without a causing `commandId`

**Done when**

```sh
pnpm --reporter=silent unit:check U1.09
```

#### U1.10 — core/resume: the 11-step recovery procedure, replay-class reconciliation, reconciliation note

- **Origin:** DESIGN U1.10 (split 3/3) · **Size:** ~2300 lines · **Depends on:** U0.G, U0.09
- **Read first:** DESIGN §2.3.3 (ResumeReport), §2.5 (Resumer), §4.1 (verifier column), §4.3 (all 22 rows, 'Resume does'), §4.4 (steps 1-11 + checkpoint cadence), §6.2, §6.3, ADR-0023, ADR-0025
- **Owns:** `packages/core/src/resume/**`, `packages/core/test/resume/**`

**Deliverables**

- `createResumer().recover(runId, host)` = DESIGN 4.4 steps 1-11 over ports only: migration CHECK (never auto-migrate), `verifyChain` + snapshot load + replay through `evolve` + projection compare, lease liveness / `stealLock` (fencing+1), immutability inputs (pin, snapshot digest, table version; NO adopt flag), orphan sweep through `ProcessSweeper` (never a bare pid), lock rebuild, effect reconciliation FIRST by replay class through `EffectVerifierRegistry`, git verification + ledger audit outcomes through the `WorktreeService` port (explained / quarantine+reset+compensate / unexplained => BLOCKED), inbox in order, approvals expiry, `run.resumed{mode:'recovery', report}`; recovery never silently un-suspends.
- Built-in verifiers that need only ports: `git.branch.create`, `git.ref.create`, `git.worktree.add`, `git.commit` (trailer), `git.merge` (CAS head), `git.worktree.reset`, `provision.command` (marker), `agent.spawn` (nonce sweep), `fs.snapshot.materialize`.
- Reconciliation-note builder (the `Continuation.note` content, built AFTER steps 7-8): calls not executed / completed with their recorded result / compensated by a reset / in doubt / approvals decided meanwhile — an approved call is REPLAYED BY THE HOST before the note is built (through the `ToolHostReplay` port, DESIGN 4.5), so the note states a fact ("approved and executed; result: …" / "approved but NOT executed: the workspace changed" / "denied: …"), never an instruction to re-issue. Every continuation is a `reincarnate('recovery')` lifecycle edge (DESIGN 2.5.4): incarnation+1, attempt unchanged.

**Tests first (TDD)**

- resume matrix on synthetic journals: one case per row of DESIGN 4.3 asserting the 'Resume does' column
- replay classes: `idempotent` re-executes, `verifiable` probes three ways (done / redo / in-doubt), `at-most-once` is NEVER re-executed and surfaces in `ResumeReport.inDoubt`
- live owner => `conflict/run-host-alive`; dead owner => takeover with fencing+1 and `lock.stolen`; pin mismatch => BLOCKED with `resumeRequires: reinstall-pinned-version`
- note content for each of the five situations (the approved case in its three outcomes: executed / binding-changed / denied-by-gate, with a fake `ToolHostReplay`); `ResumeReport.approvedReplays` filled; host restarts count against `maxIncarnations`, not `maxAttempts`; completed agents/phases are never re-executed

**Done when**

```sh
pnpm --reporter=silent unit:check U1.10
```

#### U1.INT — Gate G1 — integrate Wave 1; walking skeleton (a): engine x journal x REAL SQLite x FakeRuntime with a crash/resume at every commit

- **Origin:** DESIGN gate G1 · **Size:** ~400 lines of test + integration fixes · **Depends on:** U1.01, U1.02, U1.03, U1.04, U1.05, U1.06, U1.07, U1.08, U1.09, U1.10
- **Read first:** DESIGN §10.1, §10.2, §4.3, §7.2; docs/v3/requests/*.md filed during the wave
- **Owns:** *all structural paths (§3 rule 2)*, `tests/integration/skeleton/**`, `docs/v3/gates/G1.md`

**Deliverables**

- Apply or reject every `docs/v3/requests/U1.*.md` (recorded in `docs/v3/gates/G1.md`); `pnpm verify` green on the whole tree; the core durability/engine/resume suites re-run with `COHORTE_TEST_STORE=sqlite`.
- `tests/integration/skeleton/engine-sqlite-fake.itest.ts`: real `RunEngine` + `EffectJournal` + `EventWriter` + `Resumer` + `SqliteStateStore` (temp file) + `FakeRuntime`; a toy `PhaseExecutor` spawns one fake agent whose tool call is journaled by a trivial `ToolHost`; the host is 'killed' (FaultInjector) at EVERY commit and resumed => same final state, exactly one `done` per effect key, gapless sequence, valid chain + anchors.
- `gen-schemas` (adds `fake-script.schema.json`), `.build/gate-1/`, `pack-check`, rollback checkpoint.

**Tests first (TDD)**

- the skeleton test above is written first and is the gate

**Done when**

```sh
pnpm --reporter=silent verify && COHORTE_TEST_STORE=sqlite pnpm exec vitest run packages/core/test/durability packages/core/test/engine packages/core/test/resume && pnpm exec vitest run tests/integration/skeleton && node scripts/build.ts --out .build/gate-1 && node scripts/pack-check.ts .build/gate-1 && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G1
```

### W2 — The hands: gate chain, tool implementations, CohorteToolHost, approvals, pure decisions + accounting, config loader, Pi probes + test harness

**Mode:** parallel — all units at once, then the integrator alone.

**Goal.** Everything between a model's tool call and an audited effect: the five pure gate stages and PolicyEngine, redaction + HMAC control-plane auth, the nine tool implementations, CohorteToolHost (stages 0-8 through the journal), durable approvals bound to pre-state, plus the pure decision core (guards, loop controller, review math, budgets, grants, projections), the config loader, and the executed Pi probes with the shared test harness (fake HTTP provider, crash runner, runCli).

**Green state at the gate.** Runnable FakeRuntime path, 'hands' skeleton: a scripted fake agent in a temp git worktree reads, writes inside its ownership, is DENIED outside it, runs an allowed argv command through the real L0 executor, hits an `ask` rule, is approved by a MAC-signed command applied by the engine, submits a result — all through the real PolicyEngine, PathResolver, CommandPolicy, Redactor, EffectJournal and SQLite; a crash between intent and done of `write_file` is reconciled as `done` by the tool's verifier.

**Exit check.**

```sh
pnpm --reporter=silent verify && pnpm exec vitest run tests/integration/skeleton && node scripts/build.ts --out .build/gate-2 && node scripts/pack-check.ts .build/gate-2 && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G2
```

| Unit | Title | Depends on | Size |
|---|---|---|---|
| U2.01 | security/gate: the five pure stages, PolicyEngine, PolicySnapshot, precedence + fail-closed, `policy explain` | U1.INT, U1.02, U1.03 | ~2000 lines |
| U2.02 | security/redact + auth: Redactor (the only minter of Sealed<T>), secret scan, KeyStore, HMAC CommandAuthenticator + chain anchors | U1.INT, U0.07 | ~1700 lines |
| U2.03 | tools/read: read_file, list_files, search, git_diff + tool registry + WorkspaceReader | U1.INT, U1.02, U1.04, U1.05, U0.08 | ~1700 lines |
| U2.04 | tools/write + exec + state: write_file, patch_file, run_command (post-command scan), approval_request, submit_result, the three seams | U1.INT, U1.02, U1.04, U1.05, U0.08 | ~2300 lines |
| U2.05 | core/decisions: all guards + fact collection, loop controller (V2 decide() port), global stops, escalation, review math | U1.INT, U0.09 | ~2500 lines (about half is ported tables) |
| U2.06 | core/accounting: budgets (five levels), grants from ownership, agent lifecycle, snapshot-document projection | U1.INT, U0.09 | ~2200 lines |
| U2.07 | core/toolhost: CohorteToolHost — stages 0-8 around the pure gate, through the journal, with replay and audit | U1.INT, U1.08 | ~2000 lines |
| U2.08 | core/approvals: durable approvals, grant keys bound to pre-state, one-shot / for-run grants, unattended rule, expiry, parking | U1.INT, U1.08 | ~1700 lines |
| U2.09 | config loader: layout discovery, load/merge/resolve, spec validate/freeze, comment-preserving writer, config migrations | U1.INT, U0.07 | ~1800 lines |
| U2.10 | Pi probes P1-P4 with pre-agreed decision rules + testkit harness: injected-fetch fake provider, crash runner, runCli, golden helpers | U1.INT, U0.03 | ~2200 lines (off the critical path) |
| U2.INT (integrator) | Gate G2 — integrate Wave 2; 'hands' skeleton: a fake agent through the REAL gate chain, executor, journal, approvals and SQLite | U2.01, U2.02, U2.03, U2.04, U2.05, U2.06, U2.07, U2.08, U2.09, U2.10 | ~450 lines of test + integration fixes |

#### U2.01 — security/gate: the five pure stages, PolicyEngine, PolicySnapshot, precedence + fail-closed, `policy explain`

- **Origin:** DESIGN U1.2 (split 3/3) · **Size:** ~2000 lines · **Depends on:** U1.INT, U1.02, U1.03
- **Read first:** DESIGN §0.2 (I2, I4), §2.6.1, §2.6.2 (stages 1-5 + precedence paragraph), §7.1 (policy row), §7.4 (C1-C4 inverted, G property, EV-14/15); <SCRATCH>/understand/v2-security-isolation.md (precedence ideas; C and G groups)
- **Owns:** `packages/security/src/decide/gate/**`, `packages/security/test/decide/gate/**`

**Deliverables**

- Stages 1-5 as pure synchronous functions over `PolicyPorts`: (1) STRICT schema re-validation through `ToolIntrospection` (no coercion, size caps, NUL/control rejection), (2) capability (`grant.tools`, terminal tool once), (3) every path argument -> `PathResolver` -> roots -> deny sets -> read/write globs -> protected roots, (4) `run_command` -> `CommandPolicy`, `network_request` -> always deny in V3.0, (5) budgets + calls/minute through `BudgetReader`, `timeoutMs` clamp, 80 % wrap-up notice.
- `createPolicyEngine().evaluate`: ALL of stages 1-5 run; the first `deny` wins over any number of `ask`s; `ask`s accumulate into one approval subject; any exception => `deny` `security/gate-internal-error`; every `PolicyVerdict` is schema-valid, carries `evaluatedRules`, `normalized`, a `modelFacingReason` with no absolute host path and ending in 'Do not retry.' for a deny.
- `buildPolicySnapshot(resolvedConfig, ownership)` (immutable, hashed; missing/unparseable/empty policy => `configuration/policy-invalid`), `explainPolicy` (stages 1-5 offline).

**Tests first (TDD)**

- C1-C4 INVERTED: missing / unparseable / empty policy => `configuration/policy-invalid`, zero evaluations allowed; malformed input => `validation/tool-input`
- stage-order + precedence tables (A11 deny-over-ask non-vacuous; asks accumulate); a throwing port => deny (fail closed)
- G property: every verdict of every table row of U1.02/U1.03 + this unit validates against the `PolicyVerdict` schema
- EV-14/15 (gate half): writes to `.cohorte/**`, a forged `.cohorte/preflight.ok` stamp has no effect on any verdict
- budget stage: hard breach => deny with `terminate`; rate limit; soft limit notice

**Done when**

```sh
pnpm --reporter=silent unit:check U2.01
```

#### U2.02 — security/redact + auth: Redactor (the only minter of Sealed<T>), secret scan, KeyStore, HMAC CommandAuthenticator + chain anchors

- **Origin:** DESIGN U1.3 (split 2/3) · **Size:** ~1700 lines · **Depends on:** U1.INT, U0.07
- **Read first:** DESIGN §0.2 (I7, I12), §0.3, §2.6.5, §2.6.7, §7.1 (redaction row), §7.4 (S-30..S-33 unit half, S-50..S-53), ADR-0022, §2.10.1, ADR-0026; <SCRATCH>/understand/pi-auth.md (what an OAuth error body can contain)
- **Owns:** `packages/security/src/redact/**`, `packages/security/src/auth/**`, `packages/security/test/redact/**`, `packages/security/test/auth/**`

**Deliverables**

- `createRedactor`: `registerSecret` by VALUE (+ base64, hex, URL-encoded forms; values < 8 chars rejected), detectors of 2.6.5 (`KEY=value` lines, `.env` learned values, PEM blocks, provider key shapes, JWT triples, `Authorization`/`Bearer`, OAuth JSON fields), `sealText` / `sealJson` with JSON-pointer `Redaction`s; `redact/seal.ts` is the ONLY file allowed to cast `as Sealed` (check-layers rule f). `scanForSecrets(bytes, path)` for the commit-time secret scan.
- `createKeyStore` (32 random bytes, file `0600`, dir `0700`, `~/.cohorte/keys/<projectId>-<sha256(realpath(git common dir))[0:12]>.key`, lazy create, refuses wrong modes) and `createCommandAuthenticator` (`scheme: 'hmac-sha256'`; `sign(canonicalBody, key)` / `verify(canonicalBody, value, key)` = HMAC-SHA256 over the BYTES the caller hands in — this package never imports `@cohorte/protocol` —, timing-safe; `anchor` === `base.computeAnchorMac`). `createTrustStore` (in the `auth` area: `packages/security/src/auth/trust-store.ts`, exported by the W0 `auth/index.ts` stub) — the file implementation of the `TrustStore` port of `@cohorte/config/schema` (DESIGN 2.10.1): `~/.cohorte/trust/<projectKeyId>.json`, dir `0700` / file `0600`, records MAC'd with the project key, a record with a bad MAC or wrong modes is treated as ABSENT (fail closed).

**Tests first (TDD)**

- S-50..S-53 (unit half): secret value, its base64/hex/URL forms, PEM in command output, OAuth error text — none survives `seal*`
- detector table (provider key shapes, JWT, headers); short values rejected; a redactor exception is surfaced, never swallowed into a partially sealed value
- MAC: forged, missing, field-tampered, key-order-shuffled envelopes; anchor equality with `base`
- key file/dir modes enforced; wrong modes refuse; tests use a throwaway HOME — NEVER the real `~/.cohorte`
- trust store: grant -> lookup hit for the same `policySha256` only; tampered record / wrong modes / other project key => miss; revoke; throwaway HOME only

**Done when**

```sh
pnpm --reporter=silent unit:check U2.02
```

#### U2.03 — tools/read: read_file, list_files, search, git_diff + tool registry + WorkspaceReader

- **Origin:** DESIGN U2.1 (split 1/2) · **Size:** ~1700 lines · **Depends on:** U1.INT, U1.02, U1.04, U1.05, U0.08
- **Read first:** DESIGN §0.2 (I1, I7), §2.6.3 (step 8), §2.7 (rows + ToolImplementation), §4.1 (tool.read); <SCRATCH>/understand/pi-tools.md (what NOT to reproduce)
- **Owns:** `packages/tools/src/impl/read/**`, `packages/tools/src/registry/**`, `packages/tools/src/workspace/**`, `packages/tools/test/impl/read/**`, `packages/tools/test/registry/**`, `packages/tools/test/workspace/**`

**Deliverables**

- `read_file` (sealed text with line numbers, offset/limit, binary => error, 256 KiB cap), `list_files` (deny sets filtered out, never follows outgoing symlinks, `maxEntries`), `git_diff` (Cohorte-run hardened git, `--no-ext-diff --no-textconv`, base `run-base | integration | checkpoint` — `run-base` = the run's pinned `base.sha`, the DEFAULT for `readonly-ref` workspaces where `integration` would be an empty diff; ALWAYS adds exclude pathspecs for `denyRead` and for everything outside `read`, also when `paths` is absent, and filters the resulting file list), each with `plan()` => `tool.read` / idempotent, `verifyAfterCrash`, `describeForNote`.
- `search`: spawns `rg` through the `Executor` (never an in-process scan) with one `--glob '!<pattern>'` per `denyRead` entry (`:(exclude,glob)` pathspecs for the `git grep` fallback) — both rendered by `GlobMatcher.toExcludeArgs` — and then FILTERS EVERY HIT PATH through `PathResolver` + the grant before returning it, counting what was dropped (`filteredPaths`). RULE (DESIGN 2.7): every tool that enumerates content filters on OUTPUT — gate stage 3 only validates path ARGUMENTS. PLAN fact F-1: this dev machine has NO `rg` binary on PATH (the shell `rg` is a function) — when `rg` is absent from the pinned PATH the tool falls back to hardened `git grep --no-index -n -I` through the same Executor and says so in its result metadata; `doctor` reports which backend is active.
- `createToolRegistry(impls)` (implementations are PASSED IN by the composition root: this unit never imports U2.04) and `createWorkspaceReader` (gated reads/lists for `ContextBuilder`, same `PathResolver` + grant rules).

**Tests first (TDD)**

- each tool through a REAL temp worktree with the real `PathResolver` and L0 executor: caps, binary detection, deny-set filtering, outgoing symlink not followed
- `search` with `rg` (skipped WITH A REASON when absent) and with the `git grep` fallback (always runs); pattern is an argv element, never a shell string
- `git_diff` ignores a planted `textconv`/external diff driver (canary)
- output is sealed: a secret planted in a file is redacted in the model-facing text; registry rejects duplicate / unknown tool names
- S-14: a planted `certs/server.key`, `id_rsa` and `.npmrc` are never returned by `search` (pattern `.`), on the `rg` backend and on the `git grep` fallback; the result reports `filteredPaths > 0`
- S-15: a TRACKED `.env.example` and `.cohorte/config.yaml` are never printed by `git_diff`, with and without `paths`; `base: 'run-base'` on a detached review ref yields the run's diff, `integration` there yields an empty one

**Done when**

```sh
pnpm --reporter=silent unit:check U2.03
```

#### U2.04 — tools/write + exec + state: write_file, patch_file, run_command (post-command scan), approval_request, submit_result, the three seams

- **Origin:** DESIGN U2.1 (split 2/2) · **Size:** ~2300 lines · **Depends on:** U1.INT, U1.02, U1.04, U1.05, U0.08
- **Read first:** DESIGN §0.2 (I1, I11), §2.6.2 (stages 7-8), §2.6.3 (step 8), §2.7, §3.5 (structured result), §4.1 (tool.* rows + verifiers), §4.4 (checkpoint cadence c)
- **Owns:** `packages/tools/src/impl/write/**`, `packages/tools/src/impl/exec/**`, `packages/tools/src/impl/state/**`, `packages/tools/test/impl/write/**`, `packages/tools/test/impl/exec/**`, `packages/tools/test/impl/state/**`

**Deliverables**

- `write_file` / `patch_file`: `verifiable`; `verify = { beforeSha256|null, afterSha256 }`; use-time `(dev,ino)` re-verification + atomic temp-file rename from U1.02; `patch_file` is exact-match, each `oldText` exactly once, pre-image mismatch => `tool-terminal/patch-preimage-mismatch`; ledger rows + `FileTouch`es.
- `run_command`: executes ONLY the `NormalizedCall` (resolved program realpath, argv, canonical cwd, clamped timeout); replay class from the matched rule; checkpoint hook before an `at-most-once` command; post-command changed-path scan (`GitPort.changedPaths`) => ledger rows, `file.changed`, and the call FAILS with `security/write-outside-ownership` if any touched path is outside the `write` globs.
- `approval_request` (its `options` travel in `ApprovalRequest.options`; the human's `approve.answer` is validated against them and echoed in the tool result `{ decision, answer }`) and `submit_result` (pure state through the `ToolExecContext` hooks; strict per-role `AgentOutput` validation; accepted ONCE); `git_commit` / `network_request` / `secret_read` registered, granted to nobody, execute => deny by design.
- `verifyAfterCrash` three-way for every effectful tool (`done | not-done | in-doubt`) + `describeForNote`.

**Tests first (TDD)**

- each tool through a real temp worktree; symlink swapped between gate and use; hardlinked target; special files
- verifier three-way: file == after => done (+ ledger row), == before => not-done, else in-doubt; `run_command` idempotent => `failed(interrupted)`, at-most-once => in-doubt, never re-run
- a formatter-like allowed command writing outside the agent's write globs => call fails + security error (I11 first enforcement)
- patch pre-image mismatch; `submit_result` twice => second rejected; role-specific output validation
- `approval_request` with options: an answer outside the list is rejected; the chosen answer is echoed; without options no answer is required

**Done when**

```sh
pnpm --reporter=silent unit:check U2.04
```

#### U2.05 — core/decisions: all guards + fact collection, loop controller (V2 decide() port), global stops, escalation, review math

- **Origin:** DESIGN U1.9 (split: decisions) · **Size:** ~2500 lines (about half is ported tables) · **Depends on:** U1.INT, U0.09
- **Read first:** DESIGN §0.2 (I10), §2.5.1 (guards column), §2.5.3 (all), §2.9 (normalisation rules 1-5), §7.1 (loop, review math rows), §7.4 (D1-D13, F1); <SCRATCH>/understand/v2-code.md (decide() reducer loop.js:81-91, verdict math + finding fingerprint review.js:285-347, test tables); legacy/v2 loop/review tests (port the TABLES)
- **Owns:** `packages/core/src/loop/**`, `packages/core/src/review/**`, `packages/core/src/pipeline/guards/**`, `packages/core/test/loop/**`, `packages/core/test/review/**`, `packages/core/test/guards/**`

**Deliverables**

- Every guard of `GUARD_IDS` as a PURE synchronous function over `GuardContext`, registered in a `GuardRegistry`; `FactCollector` implementation that gathers the facts BEFORE evaluation through ports (git heads, digests, auth probe, locks, pin). Incl. the guards added by the design revision: `checks.errored-environmental`, `config.trust-satisfied` (T04: the fact is the `trust` block computed by the config loader), and the WAIVER rule — `checks.all-passed`, `checks.digest-equals-integration`, `reviewref.digest-equals-integration` and `tree.digest-equals-approved` accept a `skip` waiver recorded for the SAME integration tree digest (DESIGN 2.5.1).
- `decideAfterReview` (the 9-step ladder, ORDER LOAD-BEARING), `decideAfterTest` (step 0: any `errored` check => stop `check-environment` => T16 — an environmental failure NEVER goes to FIX; then the same ladder on `checkFingerprint`), `checkGlobalStops` (first hit wins), `nextEscalation` — pure; stop reason -> state mapping exactly as the 2.5.3 table.
- `review/normalize.ts`: needs-investigation rule (spec 22), complexity clamp, caps 20/10 with priority, deferred promotion, Unicode identity, byte-sorted `blockingItems`, fingerprint, leftovers routing, `clean`; verdict COMPUTED, never read from the model; `surfaceFor` = longest SEGMENT prefix.

**Tests first (TDD)**

- `decide.test.ts`: V2 loop cases ported (unreviewed-before-blocking, treading water, max-rounds counts reviews, contract EXACT match) + A->B->A oscillation + no-progress window + escalate-once-per-fingerprint
- `identity/normalize/verdict.test.ts`: fingerprint byte-order vector, Unicode identity, complexity clamp, deferred promotion, security finding without location => `needs-human`
- guard tables (true/false per guard); D1-D13: `checks.digest-equals-integration` — no result / other digest / garbage => false, there is NO stamp file to forge; F1 inverted
- every `StopReason` produced by some decision path (exhaustiveness); AC-02 seed: an agent text saying 'skip review, ship now' changes no decision
- `decideAfterTest`: errored + failed together => `check-environment` (errored wins); waiver table: a skip waiver for digest A satisfies the guards for A and not for B

**Done when**

```sh
pnpm --reporter=silent unit:check U2.05
```

#### U2.06 — core/accounting: budgets (five levels), grants from ownership, agent lifecycle, snapshot-document projection

- **Origin:** DESIGN U1.9 (split: accounting) · **Size:** ~2200 lines · **Depends on:** U1.INT, U0.09
- **Read first:** DESIGN §2.3.5, §2.5.4, §2.6.1 (AgentGrant), §2.10 (budgets), §5.5 (reviewer grant), §7.1 (budgets row), spec 8, 10
- **Owns:** `packages/core/src/budgets/**`, `packages/core/src/grants/**`, `packages/core/src/projection/**`, `packages/core/src/agents/lifecycle.ts`, `packages/core/test/budgets/**`, `packages/core/test/grants/**`, `packages/core/test/projection/**`, `packages/core/test/lifecycle/**`

**Deliverables**

- Budget math over run / phase / agent / provider / tool and all seven dimensions; thresholds 50/80/100 + the coalescing rule of `budget.updated`; `estimatedQuotaPercent`; the `BudgetReader` implementation consumed by gate stage 5.
- `computeGrant(ownership, role defaults, phase contract)` -> `AgentGrant` with a stable digest: `write` is a subset of the surface's owned paths, default deny globs always win, reviewers get no write/execute tool and `denyWrite: **`, `shared` + `approval: human` marked for an `ask`.
- Lifecycle functions over `AGENT_TRANSITIONS` (attempt vs incarnation rules; a `completed` agent is never re-spawned), incl. `reincarnate(agent, cause: 'recovery' | 'park' | 'pause-expiry')` = the edges `spawning | running | waiting | paused -> spawning`: incarnation+1, attempt UNCHANGED, `maxIncarnations` enforced, emitted as `agent.state.changed{reason, attemptConsumed:false}`.
- Pure projections: `RunSnapshotDocument` and `ProjectStatusDocument` from `RunTreeRows` (computable from the store alone; not-yet-run phases as `pending`).

**Tests first (TDD)**

- `budgets.test.ts`: five levels incl. provider and tool; quota percent limit; coalescing
- grants: write within owned; deny defaults win; digest stability; reviewer grant shape
- lifecycle table-driven: illegal transitions rejected; retry/escalation = attempt+1 & incarnation+1; recovery, park and pause-expiry = incarnation+1 ONLY (a parked approval or a pause longer than the keep-alive never consumes an attempt); exceeding `maxIncarnations` => failed `budget/incarnations`
- projection fixtures validate STRICTLY against the protocol document schemas

**Done when**

```sh
pnpm --reporter=silent unit:check U2.06
```

#### U2.07 — core/toolhost: CohorteToolHost — stages 0-8 around the pure gate, through the journal, with replay and audit

- **Origin:** DESIGN U2.2 (split 1/2) · **Size:** ~2000 lines · **Depends on:** U1.INT, U1.08
- **Read first:** DESIGN §0.1 (C1), §0.2 (I1, I5, I7), §2.2.2 (ToolHost), §2.6.2 (the whole chain, stages 0, 6, 7, 8), §2.3.3 (tool.* and file.* events), §4.1, §4.6 (pause latch)
- **Owns:** `packages/core/src/toolhost/**`, `packages/core/test/toolhost/**`

**Deliverables**

- `createToolHost` = the ONLY code path that touches a worktree, spawns a process for an agent or runs git for an agent (I1): stage 0 (`signal.aborted` first statement, pause latch, `tool.requested` with sealed args) -> `PolicyEngine.evaluate` (1-5) -> stage 6 `ApprovalService` -> stage 7 `EffectJournal.run` + `ToolRegistry` (`plan`/`execute`, per-slot effect mutex) -> stage 8 (output capped, hashed, SEALED, artifact; `tool.completed` + `file.*` + ledger rows).
- Replay (`already-done` => `tool.completed.replayed = true`, nothing re-executes); denial accounting (`deniedCalls[agent]` -> `policy-violation` signal at the threshold); `securityViolation` => BLOCKED signal; budget hard breach => `isError + terminate` AND abort; `handleToolCall` always RESOLVES and settles promptly after abort.
- `ToolHostReplay.replayApproved(lease, approved, signal)` (DESIGN 4.5 parked path): re-runs stages 1-5 on the STORED normalised call, recomputes the pre-state binding, and ONLY if the grant key still matches executes it through the journal under the ORIGINAL `toolCallId` and idempotency key, consuming the grant in the intent tx (`tool.started.replayOfApproval`); `binding-changed` and `denied-by-gate` execute nothing and never open an ask. Stage-8 artifacts go through the Wave-0 in-memory `RunFiles` in tests.

**Tests first (TDD)**

- chain-order test with spies: all of 1-5 run, first deny wins, stage 6 only on asks, stage 7 only through the journal
- pause latch holds NEW calls while an in-flight effect completes and is delivered; abort settles pending calls
- replay returns the stored result without re-execution; gate exception => `tool.denied{security/gate-internal-error}`
- `tool.denied` carries stage / ruleId / evaluatedRules / overridable; N denials => policy-violation stop signal
- runs on `makeStore()` + the REAL journal/event writer (U1.08) + fake `PolicyEngine` / `ApprovalService` / `ToolRegistry`
- replayApproved: matching binding => executed exactly once under the original key (a second replay is `already-done`); changed `beforeSha256` / tree digest => nothing executes; a call the gate now denies => nothing executes

**Done when**

```sh
pnpm --reporter=silent unit:check U2.07
```

#### U2.08 — core/approvals: durable approvals, grant keys bound to pre-state, one-shot / for-run grants, unattended rule, expiry, parking

- **Origin:** DESIGN U2.2 (split 2/2) · **Size:** ~1700 lines · **Depends on:** U1.INT, U1.08
- **Read first:** DESIGN §2.3.3 (ApprovalRequest, approval.* events), §2.6.1 (decisions comment), §2.6.2 (stage 6), §4.5 (all), §4.3 (#11), §7.2 (approvals row), §7.4 (A17-A19), ADR-0025
- **Owns:** `packages/core/src/approvals/**`, `packages/core/test/approvals/**`

**Deliverables**

- `createApprovalService`: `request` in ONE tx (`approval.requested` + row with the NORMALISED pending call + `grant_key` + expiry + agent -> `waiting`); `grant_key = sha256(tool | canonicalJson(normalised call) | pre-state binding)` (`beforeSha256` for write/patch; THE SLOT'S CONTENT-ADDRESSED `treeDigest` for a command — never `(checkpoint_sha, ledger digest)`: parking makes a checkpoint commit, which moves the sha and clears the ledger, so that binding could never match again for an agent with uncommitted writes; the tree digest survives a commit of identical content); `grantFor` must cover ALL asks; `await` (fast path) honours the signal.
- Resolution (called by the engine when it applies a MAC-verified `approve|deny`): `allow-once` = unconsumed one-shot grant, `allow-for-run` = live grant; resolving NEVER executes anything; consumption happens inside the consuming effect's intent tx; `unattended: deny` => denial 'nobody to confirm', `wait` => park; expiry; parking after `parkAfterMinutes`; `superseded` on cancel; phase-level approvals keyed `apr:<runId>:<kind>:<phaseRunId>`; `approvedUnconsumed(runId, agentId)` = the resolved-allow approvals whose stored call was never executed (what the supervisor hands to `ToolHostReplay` before spawning the next incarnation); `approve.answer` validated against `ApprovalRequest.options` and stored in the decision.

**Tests first (TDD)**

- approval held 'for hours' with `FixedClock`; `approve` with no live requester leaves a grant and executes nothing
- a PARK CHECKPOINT does not change the grant key of a pending command approval (tree digest binding); pre-state really changed meanwhile => grant key mismatch => the approval is `superseded`, nothing executes, and a re-issued call opens a NEW ask
- allow-once consumed exactly once across a crash; duplicate request is idempotent by key
- A17-A19: unattended `ask` => `deny` matching /nobody to confirm/; expiry => `expired`; deny => `permission/denied-by-human`
- an approved write is applied BY THE HOST after park (fake `ToolHostReplay` asserts it receives the original call); the model is never asked to re-issue; `approvedUnconsumed` is empty afterwards

**Done when**

```sh
pnpm --reporter=silent unit:check U2.08
```

#### U2.09 — config loader: layout discovery, load/merge/resolve, spec validate/freeze, comment-preserving writer, config migrations

- **Origin:** DESIGN U1.7 (config half) · **Size:** ~1800 lines · **Depends on:** U1.INT, U0.07
- **Read first:** DESIGN §2.10 (table + load order), §5.7 (provision flags rule), §6.1, spec 14, ADR-0013, §2.10.1, §2.6.3 (step 5), ADR-0026; <SCRATCH>/understand/v2-profile-tests-ci.md (PIPELINE.md profile model -> .cohorte/)
- **Owns:** `packages/config/src/load/**`, `packages/config/src/write/**`, `packages/config/src/migrate/**`, `packages/config/test/load/**`, `packages/config/test/write/**`, `packages/config/test/migrate/**`, `migrations/config/**`

**Deliverables**

- Layout discovery (walk up to `.cohorte/`, resolve the git common dir so every worktree addresses the same project; no env var needed); `loadConfig` with the order shipped defaults < `~/.cohorte/config.yaml` < `.cohorte/config.yaml` < CLI flags; `resolveConfig` => deterministic resolved config + sha256 (what the run snapshot stores) + the TRUST block of DESIGN 2.10.1: per `CONFIG_KEY_TRUST`, a `tighten-only` key of the project file is honoured only when at least as strict as the layer below, a `loosen` key only with the local user's consent — the same or a looser value in the user-scope file (`user-config`), a CLI flag (`cli-flag`), or a `TrustStore` hit for `policySha256 = sha256(canonicalJson(project-file values of every loosen-class key + ownership.yaml))` (`trust-record`); otherwise the result is `untrusted { loosenedKeys, diff }` and the caller fails closed with `security/project-policy-untrusted`. The `TrustStore` is an injected port (file implementation: `U2.02`); loaders for manifest / ownership / spec / `skill.yaml` (`SkillManifest`); `freezeSpec` (immutable once frozen, sha256).
- Fail-closed validation with JSON-pointer messages (`configuration/*`); loader rules: `telemetry.remote: true` => `configuration/telemetry-remote-unavailable`; `provision.argv` for a known package manager MUST carry `--frozen-lockfile` + `--ignore-scripts` (or equivalent) else refused. A `git.worktreeRoot` that canonicalises inside a built-in protected root (`.cohorte/worktrees` included) => `configuration/worktree-root-protected`; every `provision.env` value must canonicalise inside `provision.cacheDirs`; for pnpm the loader appends `--config.package-import-method=clone-or-copy`.
- Comment-preserving writer (yaml Document API) for `config set`; numbered config migrations runner under `migrations/config/`.

**Tests first (TDD)**

- precedence table; resolved hash is deterministic and key-order independent; throwaway HOME for the user-level file
- comment preservation golden; invalid samples => documented codes + pointers
- spec freeze immutability; provision flag refusal (S-71 seed); D2 triple opt-in only valid when all three are true
- S-37 (unit half): a hostile project file (`sandbox.require: best-effort` + a `dangerousCommands` rule) resolves to `untrusted` listing exactly those keys; with the same value in the user file => `grantedBy: 'user-config'`; with a trust record => `trust-record`; tightening keys never ask
- S-38 (unit half): editing a loosening key changes `policySha256` => the old trust record no longer matches; editing a neutral key does not
- worktree root under `.cohorte/` refused; `provision.env` outside `cacheDirs` refused

**Done when**

```sh
pnpm --reporter=silent unit:check U2.09
```

#### U2.10 — Pi probes P1-P4 with pre-agreed decision rules + testkit harness: injected-fetch fake provider, crash runner, runCli, golden helpers

- **Origin:** DESIGN U0.P + U1.8 (testkit half) — moved out of the sequential W0 (not a contract) and merged: probe P2 IS the fake HTTP provider · **Size:** ~2200 lines (off the critical path) · **Depends on:** U1.INT, U0.03
- **Read first:** DESIGN §1.3, §3.4, §3.5 (pause, A-1), §3.10 (fake provider tier b), §7.3 (crash harness mechanics), §12.2 (A-1..A-5), §10.3 (U0.P decision rules); <SCRATCH>/spike/sdk/REPORT.md, <SCRATCH>/spike/child/REPORT.md, <SCRATCH>/understand/pi-delta-sdk-auth.md, pi-delta-rpc-tools.md (+ Verification sections); <SCRATCH>/pi-live (0.85.1 sources). SAFETY: never read ~/.pi/agent/auth.json or any credential file; probes use InMemoryCredentialStore only
- **Owns:** `docs/v3/probes/**`, `packages/runtime-pi/test/tripwires/probe-p1.itest.ts`, `packages/runtime-pi/test/tripwires/probe-p2.itest.ts`, `packages/runtime-pi/test/tripwires/probe-p3.itest.ts`, `packages/runtime-pi/test/tripwires/probe-p4.itest.ts`, `packages/runtime-pi/test/tripwires/probe-support/**`, `packages/testkit/src/http-provider/**`, `packages/testkit/src/crash/**`, `packages/testkit/src/run-cli/**`, `packages/testkit/src/golden/**`, `packages/testkit/test/harness/**`

**Deliverables**

- Executed answers, each a permanent tripwire + a written verdict in `docs/v3/probes/P<n>.md` with its PRE-AGREED decision rule: P1 [A-1] a `streamFunction` wrapper is observed for EVERY request incl. continuation runs (red => capabilities stay `partial`, pause = stop-after-turn, budgets counted parent-side); P2 [A-3] real `openai-codex` provider + dummy OAuth credential in an `InMemoryCredentialStore` + injected `fetch` relays 401/429 status + headers (red => header tests on recorded fixtures only); P3 [A-2] Linux `bwrap` under Ubuntu 24.04 AppArmor userns + IPC fd passing — CANNOT run on this macOS machine: authored here, skipped with a reason on darwin, executed at the first Linux CI run; until then the pre-agreed fallback is the default (Linux brain sandbox `partial`, fd 3/4 framing available, documented sysctl remediation in `doctor`); P4 [A-5] two children forcing a concurrent OAuth refresh against a fake OAuth endpoint take Pi's file lock (red => serialise refresh in the parent).
- testkit harness: `http-provider` (scripted `openai-codex-responses` endpoint through an injected `fetch`: 200, 401, 429 with/without reset headers, 5xx, slow, hanging, broken chunks; records every request header), `crash` runner (start a built CLI with `COHORTE_CRASH_AT`, wait for the host to die, resume, assertion helpers), `runCli(args, {cwd, home})` (throwaway HOME, scrubbed env, build dir = `$COHORTE_E2E_BUILD_DIR` or the highest `.build/gate-<n>/` — runnable offline through its `.publish/node_modules` link (PLAN F-7); `runCli` fails with a precise message when the link is missing —, optional 10 s / 4 MiB François mode), golden NDJSON normaliser (ids, timestamps).

**Tests first (TDD)**

- the four probes are the tests (`probe-p*.itest.ts`); each asserts its decision-rule outcome and the verdict file exists
- http-provider: deterministic replay of each scripted response, request headers recorded, no non-loopback socket opened
- crash runner kills and resumes a toy process; `runCli` captures exit code/stdout/stderr and enforces the François budget mode

**Done when**

```sh
pnpm --reporter=silent unit:check U2.10 && ls docs/v3/probes/P1.md docs/v3/probes/P2.md docs/v3/probes/P3.md docs/v3/probes/P4.md
```

#### U2.INT — Gate G2 — integrate Wave 2; 'hands' skeleton: a fake agent through the REAL gate chain, executor, journal, approvals and SQLite

- **Origin:** new gate (DESIGN has 5 waves; this plan has 7, see PLAN §8) · **Size:** ~450 lines of test + integration fixes · **Depends on:** U2.01, U2.02, U2.03, U2.04, U2.05, U2.06, U2.07, U2.08, U2.09, U2.10
- **Read first:** DESIGN §10.1, §2.6.2, §4.1, §4.5; docs/v3/requests/*.md filed during the wave; docs/v3/probes/P*.md (apply the decision rules: they fix what U4.08 builds)
- **Owns:** *all structural paths (§3 rule 2)*, `tests/integration/skeleton/**`, `docs/v3/gates/G2.md`

**Deliverables**

- Requests applied; probe verdicts turned into decisions recorded in `docs/v3/gates/G2.md` (capability values, pause mode, fd framing, refresh serialisation).
- `tests/integration/skeleton/hands.itest.ts`: FakeRuntime agent in a temp git worktree — `read_file`, `write_file` inside ownership, a write OUTSIDE ownership (`tool.denied`), an allowed exact-argv `run_command` through the real L0 executor, an `ask` rule => `approval.requested` => MAC-signed `approve` applied by the engine => proceeds, `submit_result`; real PolicyEngine + PathResolver + CommandPolicy + Redactor + KeyStore/HMAC + EffectJournal + SQLite; crash between intent and done of `write_file` then `Resumer` => verifier says `done`, no double write; a forged MAC leaves the approval pending.
- `gen-schemas`, `.build/gate-2/`, `pack-check`, rollback checkpoint.

**Tests first (TDD)**

- the hands skeleton is written first and is the gate; the G1 skeleton stays green

**Done when**

```sh
pnpm --reporter=silent verify && pnpm exec vitest run tests/integration/skeleton && node scripts/build.ts --out .build/gate-2 && node scripts/pack-check.ts .build/gate-2 && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G2
```

### W3 — Orchestration: context, run snapshot, supervisor, worktrees + provisioning, phase executors, phase contracts, commit/merge, project model, providers + telemetry

**Mode:** parallel — all units at once, then the integrator alone.

**Goal.** Compose the pipeline inside core against the Wave-0 internal ports: ContextBuilder, RunSnapshotter/PinReader over the content-addressed store, AgentSupervisor (the one RuntimeEvent -> Envelope mapper), WorktreeService + Provisioner, the persisted phase step machine, the six phase contracts, Cohorte-owned commits and the plumbing merge; plus the deterministic project model (scan, init, drift, reconcile --plan) and providers/telemetry.

**Green state at the gate.** Runnable FakeRuntime path, full pipeline (programmatic, no CLI yet): on a two-surface temp repo a `feature@1` run goes IDLE -> PREFLIGHT -> BUILD (two implementers in parallel worktree slots) -> TEST -> REVIEW (finding) -> FIX -> TEST -> REVIEW (clean) -> SHIP -> COMPLETED on real SQLite and real git; an in-process host crash mid-BUILD followed by `Resumer` still ends COMPLETED with exactly one commit per `Cohorte-Effect` key and an unchanged user checkout.

**Exit check.**

```sh
pnpm --reporter=silent verify && pnpm exec vitest run tests/integration/skeleton && node scripts/build.ts --out .build/gate-3 && node scripts/pack-check.ts .build/gate-3 && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G3
```

| Unit | Title | Depends on | Size |
|---|---|---|---|
| U3.01 | core/context: ContextBuilder — deterministic manifest, trust tiers, exclusions, reduction, prompt/task rendering, inline skills | U2.INT, U2.03, U0.08 | ~1900 lines |
| U3.02 | Run files + run snapshot: content-addressed BlobStore, RunFiles, EphemeralSpool; RunSnapshotter + PinReader (spec 16) | U2.INT, U1.08, U2.09 | ~2000 lines |
| U3.03 | core/supervisor: AgentSupervisor — spawn by key, the ONE total RuntimeEvent -> Envelope mapper, retries, escalation, nudges, accounting stamps | U2.INT, U1.06, U1.08, U2.06 | ~2300 lines |
| U3.04 | core/worktrees + provision: slots outside the repo, checkpoints, ledger audit, quarantine + reset, journaled dependency provisioning | U2.INT, U1.05, U1.08, U1.04 | ~2300 lines |
| U3.05 | core/phase executors: the persisted step machine (plan -> ... -> integrate) and the CheckPhaseExecutor for TEST | U2.INT, U1.08, U1.09 | ~2000 lines |
| U3.06 | core/phase contracts: PREFLIGHT, BUILD, TEST, REVIEW, FIX, SHIP for the three profiles | U2.INT, U2.05, U2.06 | ~2200 lines |
| U3.07 | core/integration: CommitService (ownership audit + secret scan + trailers), MergeService (plumbing + CAS + revalidation), review refs, git transition effects | U2.INT, U1.05, U1.08, U2.02 | ~2000 lines |
| U3.08 | project-model I: deterministic repository scan, Project Model, `init` plan/apply, `discover` document | U2.INT, U2.09, U1.05 | ~2000 lines |
| U3.09 | project-model II: desired state, five field classes, six-class drift diff, provenance/hash guard, `reconcile --plan` | U2.INT, U2.09, U1.05 | ~1900 lines |
| U3.10 | providers + telemetry: static tier routing, provider allowlist + pinned endpoints, billing table, quota header parsers; sealed logger, accounting reducers | U2.INT, U2.09, U0.07 | ~1900 lines |
| U3.INT (integrator) | Gate G3 — integrate Wave 3; full-pipeline skeleton: build -> test -> review -> fix -> clean -> ship with FakeRuntime, real git, real SQLite, crash + resume | U3.01, U3.02, U3.03, U3.04, U3.05, U3.06, U3.07, U3.08, U3.09, U3.10 | ~600 lines of test + integration fixes (the heaviest gate before G4) |

#### U3.01 — core/context: ContextBuilder — deterministic manifest, trust tiers, exclusions, reduction, prompt/task rendering, inline skills

- **Origin:** DESIGN U2.3 (split 1/2) · **Size:** ~1900 lines · **Depends on:** U2.INT, U2.03, U0.08
- **Read first:** DESIGN §2.2.3 (ContextManifest, ContextEntry, PromptRef, TaskInput), §2.5 (ContextBuilder, PinReader), §2.10 (prompts/skills/conventions rows), §2.3.3 (context.built), §7.1 (context manifests row), spec 7, §9 (context row); <SCRATCH>/understand/v2-doctrine.md (what stays doctrine vs what is control logic)
- **Owns:** `packages/core/src/context/**`, `packages/core/test/context/**`

**Deliverables**

- `createContextBuilder().build(plan, pin, workspace)`: entries in deterministic order (tier, then id) with source, sha256, bytes, token estimate; five tiers `system | doctrine | data | task | prior-results` and trust labels — `agent-output` and `untrusted-repository` can NEVER sit above `data`; repository content framed as untrusted data; exclusions (secrets, outside ownership, size, binary) LISTED in the manifest (R9); token limit + deterministic reduction `excerpt -> outline -> dropped` (`summary-with-refs` = interface only).
- Renderer: system prompt with a STABLE prefix and a variable suffix; `TaskSpec` -> task file (`TaskInput`, hash recorded); prompts resolved through `PinReader` (`agents/<role>`, project overrides reported in `RunPlan.promptOverrides`); skills selected deterministically by `appliesWhen` and INLINED (never Pi's skill mechanism); `conventions.md` with trust `human`; `Continuation.note` rendering (a `TaskInput`; the RUNTIME delivers it after `task`, DESIGN 2.2.3 — the builder never merges it into the task file); the `context.built` draft. CONTRACT (DESIGN 2.2.3): `systemPrompt` = tiers `system` + `doctrine`, `task` = tiers `data` + `task` + `prior-results`; the manifest is provenance only. Skill `checks` are DECLARATIVE: rendered as text in the doctrine tier, never run, never a `CommandRule` (DESIGN 2.10, D-25).

**Tests first (TDD)**

- determinism: same inputs => same `manifestSha256`; stable prefix / variable suffix across two agents of one role
- secret + out-of-ownership exclusions appear in `exclusions`; slash-less deny pattern == `**/<p>`
- an artifact produced by an agent can never be placed in a tier above `data`; reduction order is deterministic at the limit
- prompt override is reported; a prompt whose CAS hash differs is refused (through `PinReader`)
- tier placement: every entry of tier `system|doctrine` is in the system prompt file and nowhere else; every other entry is in the task file; a skill that declares a check changes neither the `AgentPlan.grant` request nor the `PolicySnapshot` digest

**Done when**

```sh
pnpm --reporter=silent unit:check U3.01
```

#### U3.02 — Run files + run snapshot: content-addressed BlobStore, RunFiles, EphemeralSpool; RunSnapshotter + PinReader (spec 16)

- **Origin:** DESIGN U1.1 (blob/files/spool) + U2.3 (split 2/2) · **Size:** ~2000 lines · **Depends on:** U2.INT, U1.08, U2.09
- **Read first:** DESIGN §0.2 (I9), §2.3.2 (ephemeral column), §2.4 (BlobStore, RunFiles, EphemeralSpool), §4.1 (fs.snapshot.materialize), §4.3 (#3), §6.1, §6.2, spec 16
- **Owns:** `packages/persistence/src/blob/**`, `packages/persistence/src/files/**`, `packages/persistence/src/spool/**`, `packages/persistence/test/blob/**`, `packages/persistence/test/files/**`, `packages/persistence/test/spool/**`, `packages/core/src/snapshot/**`, `packages/core/test/snapshot/**`

**Deliverables**

- `createBlobStore` (`state/cas/<sha256>`, read-only files, hash RE-VERIFIED ON EVERY READ => `security/pin-tampered`), `createRunFiles` (`runs/<runId>/{snapshot,agents/<id>/<n>,artifacts,stream,pids}`, sensitive artifacts flagged, gzip-after hook), `createEphemeralSpool` (2 segments x 4 MiB, no fsync, `tail` ordered by `(sequence, sub)`). All three run the Wave-0 port conformance suites (`blobStoreConformance`, `runFilesConformance`, `spoolConformance`) UNCHANGED — the same suites the in-memory implementations of `U0.06` pass. `RunFiles` exposes the gzip/expiry primitives that `cohorte gc` (`U4.05`) drives for `retention.*`.
- `createRunSnapshotter`: `capture` the eight items of spec 16 into `RunSnapshotManifest` (the schema is the `core` contract `core/src/contract/snapshot-manifest.ts`, incl. `config.trust`; app version + git hash, packages, bundles == bundle-manifest, asset tree hashes, schema versions + table version, prompts, skills, resolved config/ownership/policy/conventions hashes, spec, environment incl. pinned PATH + sandbox + runtime capabilities, `RuntimePin`) and MATERIALISE every byte a run will read into the CAS through the journaled `fs.snapshot.materialize` effect; `verify`; `createPinReader` (serves by logical path from the CAS, re-hashes on every read).

**Tests first (TDD)**

- CAS: tampered blob => `security/pin-tampered`; `put` idempotent; partial materialisation re-run converges to the same digest (crash point #3)
- spool: rotation, tail ordering with interleaved sequences, a SIGKILLed reader leaves the writer unaffected
- snapshot manifest is schema-valid and its digest stable; a mid-run edit of a prompt / config / ownership / spec file is INVISIBLE through `PinReader`

**Done when**

```sh
pnpm --reporter=silent unit:check U3.02
```

#### U3.03 — core/supervisor: AgentSupervisor — spawn by key, the ONE total RuntimeEvent -> Envelope mapper, retries, escalation, nudges, accounting stamps

- **Origin:** DESIGN U2.4 (split 1/2) · **Size:** ~2300 lines · **Depends on:** U2.INT, U1.06, U1.08, U2.06
- **Read first:** DESIGN §0.1 (C4), §0.2 (I8), §2.2.5 (RuntimeEvent), §2.3.3 (agent.*, model.*, retry.*, escalation.* rows), §2.5.2 (RetryPolicy), §2.5.4, §3.5 (structured result, budget belt), §3.7 (layers 5-6), §7.2 (retries row), §12.1 (two declarations drift); <SCRATCH>/understand/v2-code.md (dead-agent roll-call tables)
- **Owns:** `packages/core/src/agents/supervisor/**`, `packages/core/test/supervisor/**`

**Deliverables**

- `createAgentSupervisor().runAgents`: spawn through the journal (`agent.spawn`, key `<runId>:<agentId>:<incarnation>`); concurrency cap `budgets.concurrency` (default 3, ~200 MB RSS per Pi child) + `serializeWith`; pause/resume/cancel fan-out; roll-call / dead-agent detection. Before spawning incarnation n+1 of an agent it drains `ApprovalService.approvedUnconsumed` through `ToolHostReplay.replayApproved` (DESIGN 4.5) and hands the outcomes to the note builder; every non-retry respawn is a `reincarnate(cause)` edge (`recovery | park | pause-expiry`).
- The ONE `RuntimeEvent -> Envelope` mapper, implementing the FROZEN table `RUNTIME_EVENT_TARGETS` of `U0.08` (`tool.call.rejected` -> `tool.rejected`, `agent.paused/resumed` -> `agent.state.changed`, `agent.message.accepted`, `runtime.warning`, `tool.call.delivered` folded into `tool.completed.waitedMs`), `satisfies`-total over both unions, appending in batches <= 50 ms with ephemerals stamped behind the pending batch of their agent (DESIGN 2.3.2); every runtime-originated text sealed before it becomes an event.
- Accounting stamps decided by Cohorte, never by the engine: `authMode` / `billing` / `monetaryCost` from the `BillingTable` port (codex => `not_applicable`; a metered leg is NEVER `not_applicable`), per-response assertion (`effectiveModel`/`authSource` vs the plan) => `security/auth-mode-violation`; quota/auth errors => suspended stop signals.
- Retry policy (bounded backoff on the injected Clock, every retry visible as `retry.scheduled`, `SpawnRequest` minus `incarnation` byte-identical), escalation application (`escalation.applied`), nudges (<= 2 host notes, then `validation/agent-no-result`), first ACCEPTED `submit_result` is final (abort the rest), `completed` = exit completed + accepted schema-valid output + per-agent checks.

**Tests first (TDD)**

- mapper totality: a unit test enumerates BOTH unions; an unmapped runtime event type fails compilation
- FakeRuntime + `makeStore()`: retry byte-identity (FakeLedger); bounded visible backoff; nudge policy; `submit_result` batched with another tool
- runtime crash => new incarnation of the SAME attempt (counts against `maxIncarnations`); budget breach => terminate + abort
- `model-request` with a wrong `authSource`/`baseUrl` => BLOCKED signal; codex leg `monetaryCost: not_applicable`, metered leg a number
- concurrency cap and `serializeWith` ordering honoured
- park: an approval wait longer than `parkAfterMinutes` (FixedClock) => checkpoint, abort, `waiting -> spawning` with `reason: 'park'`, attempt unchanged; after `approve`, the host replay runs BEFORE the spawn and the note carries its result

**Done when**

```sh
pnpm --reporter=silent unit:check U3.03
```

#### U3.04 — core/worktrees + provision: slots outside the repo, checkpoints, ledger audit, quarantine + reset, journaled dependency provisioning

- **Origin:** DESIGN U2.4 (split 2/2) · **Size:** ~2300 lines · **Depends on:** U2.INT, U1.05, U1.08, U1.04
- **Read first:** DESIGN §2.5 (WorktreeService, Provisioner), §4.1 (git.worktree.*, provision.command), §4.3 (#8, #21), §4.4 (step 8 + checkpoint cadence), §5.1, §5.2, §5.7, §5.9, §7.4 (S-71), ADR-0021; <SCRATCH>/understand/v2-security-isolation.md (worktree isolation lessons)
- **Owns:** `packages/core/src/worktrees/**`, `packages/core/src/provision/**`, `packages/core/test/worktrees/**`, `packages/core/test/provision/**`

**Deliverables**

- `createWorktreeService`: root default `~/.cohorte/worktrees/<projectKeyId>/<runId>/` (OUTSIDE the repo; a `git.worktreeRoot` override is legal only OUTSIDE the built-in protected roots — `.cohorte/worktrees` is refused by the config loader, DESIGN D-10); slots = one per surface + `_integration` + `_review-<n>`; every id through `ID_PATTERN`, every path canonicalised under the root; `acquire` = journaled `git.worktree.add` or slot reuse with `switchToNewBranch` at the integration head (own branch per agent, one holder at a time); `checkpoint` (through the `CommitService` port); `release`; ledger `audit` (changed paths + sha256 vs `worktree_ledger`); `quarantineAndReset` (patch artifact + journaled `git.worktree.reset` + same-tx `compensateEffects` + ledger clear); GC on terminal states (remove if clean, `branch -d` merged only).
- `createProvisioner().ensure(slot)`: the human-owned `provision.argv` as a COHORTE-RUN journaled effect keyed by `(slot, sha256 of the configured lockfiles at HEAD)`, marker under the worktree's gitdir (unreachable by agents), executor profile = slot + `cacheDirs`, `network: 'unrestricted'` ONLY when `provision.network` (+ one-time `provision-network` approval when attended). The three properties of DESIGN 5.7: (1) env = the L0 allowlist + the allowlisted `provision.env` names, default `npm_config_store_dir = cacheDirs[0]` (the scratch `HOME` would hide the store); no usable store => `configuration/provision-store-unavailable`; (2) after install, `nlink == 1` asserted on a sample (direct deps' `package.json` + 200 random files) — no hardlink into the shared store; (3) a dependency MANIFEST digest recorded in `worktrees.deps_manifest_sha256`, `verifyDependencies(slot)` for the check executor (stat-level under L1, full content under L0), `provision.dependencyDirs` handed to every agent/check `ExecRequest` as `fs.readOnly`, `provision.writableCaches` wiped before each check sequence. `resetClean(slot, to)` for `_integration`.

**Tests first (TDD)**

- real git in temp repos with a throwaway HOME: slot reuse keeps the directory, new branch per agent; ids failing `ID_PATTERN` rejected
- ledger audit three outcomes: explained (work kept) / unexplained + in-doubt command (quarantine + reset + compensated) / unexplained (BLOCKED signal)
- the user's checkout digest is identical before and after every operation
- provisioning: idempotent by key + marker; re-provision after a lockfile change; S-71 a `postinstall` canary never runs
- S-74 (unit half): a provision whose files have `nlink > 1` (fixture store with hardlinks) fails the effect; with clone-or-copy it passes
- S-73 (unit half): mutating a file under `node_modules` after provisioning => `verifyDependencies` reports `security/deps-tampered`; writable caches are excluded and wiped
- provisioning env: only the four allowlisted names reach the package manager; the store is found although `HOME` is a scratch dir

**Done when**

```sh
pnpm --reporter=silent unit:check U3.04
```

#### U3.05 — core/phase executors: the persisted step machine (plan -> ... -> integrate) and the CheckPhaseExecutor for TEST

- **Origin:** DESIGN U2.5 (split 1/3) · **Size:** ~2000 lines · **Depends on:** U2.INT, U1.08, U1.09
- **Read first:** DESIGN §2.5.2 (GenericPhaseExecutor, CheckPhaseExecutor, PhaseOutcome), §4.2 (E7, E8), §4.3 (#7-#9, #14, #17), §4.1 (check.command), spec 11.2
- **Owns:** `packages/core/src/phases/executor/**`, `packages/core/test/phases-executor/**`

**Deliverables**

- `GenericPhaseExecutor`: step machine persisted in `phases.step` — `plan -> provision -> context -> spawn -> await -> collect -> verify -> commit -> integrate -> done`; EVERY step is idempotent and starts by reading what a previous crash left; each sub-step ends with one tx `{events; projections; putPhase(step = next)}`; a phase completes only after deterministic validation of its outputs; completed agents are never re-spawned.
- `CheckPhaseExecutor` (TEST, no LLM): `config.checks` through the SAME gate + `Executor` as `agt_system_checks` in the `_integration` slot; the fixed sequence of DESIGN 2.5.2: (1) `Provisioner.verifyDependencies` (mismatch => `errored`, `security/deps-tampered`); (2) `treeDigest(_integration)` computed ONCE, before the first check — every `CheckResult` and every `check.command` key (`check:<runId>:<name>:<treeDigest>`) is bound to it; (3) typecheck -> lint -> test, stop at the first non-`passed`; (4) ALWAYS afterwards: artefact list as `file.changed{detectedBy:'post-command-scan'}` severity info, then the journaled `WorktreeService.resetClean(_integration, integrationHead)` and an assertion that the digest equals step 2. Outcomes: all passed => `passed`; failed and none errored => `failed{checks-red}`; any `errored` after the contract's bounded `tool-transient` retries => `suspended{stop: check-environment}` (T16) — never FIX.
- Crash points wired: `plan.after-commit`, `provision.*`, `spawn.*`, `agent.after-exit-before-collect`, `phase.before-completed-commit`.

**Tests first (TDD)**

- re-entry at EVERY step with `FaultInjector` and fake ports => same outcome, no duplicated agent/effect
- `agent.after-exit-before-collect`: an accepted result is collected from the artifact without re-spawn
- check executor: ordering, stop at first red, digest binding, same digest => same key => a single `done`
- outputs failing the phase `outputSchema` => `failed{outputs-invalid}`, never `passed`
- a check that writes `coverage/` and a snapshot file: results stay bound to the pre-sequence digest, no `security/write-outside-ownership`, `_integration` is clean and at the integration head afterwards, the next TEST computes the same digest
- a check that errors (spawn failure / timeout / sandbox denial) => `check-environment`, not `checks-red`; tampered dependencies => errored without running any check

**Done when**

```sh
pnpm --reporter=silent unit:check U3.05
```

#### U3.06 — core/phase contracts: PREFLIGHT, BUILD, TEST, REVIEW, FIX, SHIP for the three profiles

- **Origin:** DESIGN U2.5 (split 2/3) · **Size:** ~2200 lines · **Depends on:** U2.INT, U2.05, U2.06
- **Read first:** DESIGN §2.5.2 (PhaseContract + the phase table), §2.5.1 (bugfix@1, review@1 paragraphs), §2.9, §5.5, §9 (roles row, state-machine row, CLI verb semantics), ADR-0018, ADR-0020; <SCRATCH>/understand/v2-doctrine.md (role doctrine, readiness rules); <SCRATCH>/understand/v2-code.md (readiness / review inputs)
- **Owns:** `packages/core/src/phases/contracts/**`, `packages/core/test/phases-contracts/**`

**Deliverables**

- Six `PhaseContract`s with `resolveInputs` (run state + artifacts + snapshot ONLY), `planAgents`, `outputSchema`, `checks`, `budget`, `stop`, `retry`, `approvals`, `assemble`: PREFLIGHT (`Readiness`, spec completeness in TS, every spec path resolves to exactly one surface by longest SEGMENT prefix; patch variant = repro + regression test), BUILD (one `implementer` per surface with tasks), TEST (no agents), REVIEW (one `reviewer` per touched surface + `security-reviewer` when ownership lists it, immutable ref, coverage guard `unreviewed`, `assemble` = review math), FIX (one `fixer` per surface owning >= 1 open fix item; claims never close a finding), SHIP minimal (approved digest == current, human approval by default, `ShipReport`). The TEST contract also DEFINES the grant of `agt_system_checks` (DESIGN 2.5.2): tool `run_command` only, commands = the `project-checks` exact rules, `read: **`, `write: **` inside `_integration` only, default deny sets, dependency dirs read-only; and its retry policy = bounded `tool-transient` retries before an `errored` verdict.
- `AgentPlan` construction: `promptId`, tools per role, `AgentGrantRequest`, `modelTier` from routing defaults (resolution itself goes through the `ModelResolver` port), budgets, workspace kind (`slot | readonly-ref | none`), `serializeWith` for `shared` paths; `review` profile with/without `withFix`.

**Tests first (TDD)**

- per-contract tables for `resolveInputs` / `planAgents` / `assemble`
- unowned spec path => approval draft (`unowned-path`); NOT-READY => `spec-not-ready`
- reviewer plans carry no write/execute tool and a `readonly-ref` workspace; FIX plans only surfaces with open fix items
- SHIP with a stale digest returns the T15 outcome; review profile delivers the verdict as the product
- the system-checks grant: write globs cover `coverage/**` inside `_integration`, deny sets still win, no other tool is granted

**Done when**

```sh
pnpm --reporter=silent unit:check U3.06
```

#### U3.07 — core/integration: CommitService (ownership audit + secret scan + trailers), MergeService (plumbing + CAS + revalidation), review refs, git transition effects

- **Origin:** DESIGN U2.5 (split 3/3) · **Size:** ~2000 lines · **Depends on:** U2.INT, U1.05, U1.08, U2.02
- **Read first:** DESIGN §0.2 (I11), §4.1 (git.* rows), §4.3 (#15, #16), §5.3, §5.4, §5.5, §5.8, §2.5.1 (effects column), ADR-0007, ADR-0008
- **Owns:** `packages/core/src/integration/**`, `packages/core/test/integration-services/**`

**Deliverables**

- `createCommitService`: ledger audit -> ownership audit of EVERY changed path against the agent's write globs (catches writes done by commands; `security/write-outside-ownership`) -> secret scan (`security/secret-staged` => BLOCKED) -> journaled `git.commit` with message `cohorte(<specId>): <surface> <phase>#<iteration>` and trailers `Cohorte-Run`, `Cohorte-Agent`, `Cohorte-Effect`, `Cohorte-Tree-Digest`; kinds `result | checkpoint`; identity per `git.commitIdentity`; ledger cleared, `checkpoint_sha` / `last_tree_digest` updated.
- `createMergeService().integrate`: lock `integration:<runId>`, deterministic agent order, head check, SECOND ownership audit on `changedPaths(mergeBase, from)`, `mergeTree`, conflict => `git.merge.conflicted` + `conflict/merge` (never resolved or forced by Cohorte), `commitTree` + `updateRefCas` through the journal, revalidation (fast-forward `_integration`, new `treeDigest`).
- `TransitionEffectRunner` implementations for the git effect ids: `create-integration-branch`, `mint-review-ref` (+ review-ref immutability check `security/review-ref-mutated`), `record-approved-digest` (incl. `{waivedBy:'skip'}`), `record-skip` (stores the waiver `(phase, integration treeDigest, justification, actor)` in `runs.skip_waivers_json` and then runs the entry effects DERIVED by `entryEffectsOf(table, phase)`: skipping TEST mints the review ref, skipping REVIEW records the approved digest), `checkpoint-worktrees`, `freeze-worktrees`.

**Tests first (TDD)**

- crash after the git commit, before `done` => trailer match => `done`, NO second commit (crash point #15); merge head already carries the trailer => `done` (#16)
- a formatter-style write outside ownership is caught at commit AND at merge; a staged secret blocks
- `updateRefCas` race => `unexpected-repo-change`; conflict path emits `git.merge.conflicted`
- review ref never moves; mutated review worktree digest is detected (S-13)
- skip TEST => review ref minted at the integration head; skip REVIEW => approved digest recorded with `waivedBy: 'skip'` and T14's guard holds; a merge after the skip changes the digest and the waiver no longer applies

**Done when**

```sh
pnpm --reporter=silent unit:check U3.07
```

#### U3.08 — project-model I: deterministic repository scan, Project Model, `init` plan/apply, `discover` document

- **Origin:** DESIGN U2.6 (split 1/2) · **Size:** ~2000 lines · **Depends on:** U2.INT, U2.09, U1.05
- **Read first:** DESIGN §2.10 (the `.cohorte/` table), §9 (discovery + `.cohorte/` rows), §7.3 (`unknown-ambiguous` fixture row), spec 12, spec 14, ADR-0012; <SCRATCH>/understand/v2-profile-tests-ci.md (V2 stack detection heuristics worth keeping)
- **Owns:** `packages/project-model/src/scan/**`, `packages/project-model/src/init/**`, `packages/project-model/test/scan/**`, `packages/project-model/test/init/**`

**Deliverables**

- `scanRepository`: deterministic, offline analysis (files, manifests, lockfiles, git, scripts, languages, frameworks, CI, Docker, tests, paths, licences, visible risks) => `ProjectModel` where every field carries its class (`human | generated | derived | observed | mixed`) + provenance, and ambiguity becomes an entry of `unknowns` — NEVER an invented command.
- `planInit` / `applyInit`: `.cohorte/{manifest,config,ownership,project}.yaml`, `.cohorte/.gitignore`, `generated/` skeleton; `manifest.generated[]` records `templateSha256` + `renderedSha256` (the previous-hash guard of spec 14); idempotent; never overwrites an existing human file; `--semantic` is refused (`configuration/phase-not-available`).

**Tests first (TDD)**

- scan on three synthetic shapes (ts monorepo, frontend/backend, two lockfiles + no test script): determinism (same tree => same bytes), unknowns listed, no invented command
- init: idempotent second run; existing human file preserved; manifest hash guard recorded; output validates against the Wave-0 schemas

**Done when**

```sh
pnpm --reporter=silent unit:check U3.08
```

#### U3.09 — project-model II: desired state, five field classes, six-class drift diff, provenance/hash guard, `reconcile --plan`

- **Origin:** DESIGN U2.6 (split 2/2) · **Size:** ~1900 lines · **Depends on:** U2.INT, U2.09, U1.05
- **Read first:** DESIGN §9 (reconcile row), §7.1 (drift classification row), §7.2 (reconciliation row), §6.4 (D1), spec 13, spec 14 (provenance paragraph)
- **Owns:** `packages/project-model/src/desired/**`, `packages/project-model/src/drift/**`, `packages/project-model/src/reconcile/**`, `packages/project-model/src/import/README.md`, `packages/project-model/test/desired/**`, `packages/project-model/test/drift/**`, `packages/project-model/test/reconcile/**`

**Deliverables**

- Desired state derived from Project Model + human config + Cohorte templates + skill versions; actual-state reader; the diff engine distinguishing absence / expected change / human change / conflict / potential deletion / unknown.
- `planReconcile({ scan })` (the scanner is INJECTED so this unit never imports U3.08): READ-ONLY plan document; a generated file is replaceable only if its current hash == `renderedSha256`; a human override is never in an apply plan — a collision is `CONFLICT`; `--apply` => `configuration/phase-not-available` in V3.0. `src/import/README.md` names the V2 importer seam.

**Tests first (TDD)**

- `drift.test.ts`: five field classes incl. `mixed`; six diff classes; a human override never appears in an apply plan; generated file replaced only when the hash still matches
- `reconcile.itest.ts`: `--plan` is read-only (tree digest unchanged); clean init => `operations: []`; human edit of a generated file => `CONFLICT` entry

**Done when**

```sh
pnpm --reporter=silent unit:check U3.09
```

#### U3.10 — providers + telemetry: static tier routing, provider allowlist + pinned endpoints, billing table, quota header parsers; sealed logger, accounting reducers

- **Origin:** DESIGN U1.7 (providers half) + U1.8 (telemetry half) · **Size:** ~1900 lines · **Depends on:** U2.INT, U2.09, U0.07
- **Read first:** DESIGN §0.2 (I8), §3.7 (layers 4, 6 + billing table), §3.8 (quota rows), §2.10 (routing, authentication), §7.1 (budgets, routing row), spec 10, spec 19, ADR-0005, ADR-0006; <SCRATCH>/understand/pi-auth.md (+ Verification: silent API billing hazard, Anthropic stealth mode); <SCRATCH>/list-models.mjs output notes if present
- **Owns:** `packages/providers/src/resolve/**`, `packages/providers/src/billing/**`, `packages/providers/src/quota/**`, `packages/providers/test/resolve/**`, `packages/providers/test/billing/**`, `packages/providers/test/quota/**`, `packages/telemetry/src/logger/**`, `packages/telemetry/src/accounting/**`, `packages/telemetry/test/logger/**`, `packages/telemetry/test/accounting/**`

**Deliverables**

- `resolveModel` (V3.0 static tier table: `coding`/`reasoning` -> `gpt-5.5`, `fast`/`cheap` -> `gpt-5.4-mini`, validated FAIL-CLOSED at run start), provider allowlist + pinned `baseUrl` (`https://chatgpt.com/backend-api` for `openai-codex`), `AuthPolicy` (subscription default, API keys opt-in, the Anthropic triple opt-in), NO automatic cross-provider fallback (ADR-0006).
- `BILLING` table + `costOf`: `openai-codex` => subscription / plan-limits / `not_applicable`; Anthropic-via-Pi => `api` / metered / estimate (NEVER `not_applicable`); API-key legs => catalogue price; versioned price catalogue file; `parseQuotaHeaders` (`x-ratelimit-*`, `retry-after`, `x-codex-*`).
- `createLogger` (stderr/file NDJSON, `SealedText` only, NEVER stdout), usage accounting reducers, local metrics snapshot.

**Tests first (TDD)**

- `resolve.test.ts`: tiers, overrides, never a fallback to a non-allowlisted provider, unknown tier fails closed
- `billing.test.ts`: `monetaryCost` is `not_applicable` IFF `billing = plan-limits`; the Anthropic opt-in is always a number; opt-in invalid unless all three acknowledgements
- header parser fixtures (with and without reset information)
- logger writes nothing to stdout; an unsealed string does not typecheck; reducers are order-independent where they must be

**Done when**

```sh
pnpm --reporter=silent unit:check U3.10
```

#### U3.INT — Gate G3 — integrate Wave 3; full-pipeline skeleton: build -> test -> review -> fix -> clean -> ship with FakeRuntime, real git, real SQLite, crash + resume

- **Origin:** new gate (see PLAN §8) · **Size:** ~600 lines of test + integration fixes (the heaviest gate before G4) · **Depends on:** U3.01, U3.02, U3.03, U3.04, U3.05, U3.06, U3.07, U3.08, U3.09, U3.10
- **Read first:** DESIGN §10.1, §4.2, §4.4, §5, §2.5; docs/v3/requests/*.md filed during the wave
- **Owns:** *all structural paths (§3 rule 2)*, `tests/integration/skeleton/**`, `docs/v3/gates/G3.md`

**Deliverables**

- Requests applied; `pnpm verify` green.
- `tests/integration/skeleton/pipeline.itest.ts` with a TEST-LOCAL composition of the whole core (the production composition root is U4.01 and should be derived from this file): two-surface temp repo, `.cohorte/` written by `applyInit`, frozen spec, `feature@1`: PREFLIGHT -> BUILD (two implementers, two slots, commits, merge) -> TEST (exact-argv checks) -> REVIEW (seeded finding) -> FIX -> TEST -> REVIEW clean -> SHIP -> COMPLETED; in-process crash mid-BUILD + `Resumer` => COMPLETED, exactly one commit per `Cohorte-Effect` key, integration digest stable, user checkout digest unchanged, `RunSnapshotDocument` projection validates.
- `gen-schemas`, `.build/gate-3/`, `pack-check`, rollback checkpoint.

**Tests first (TDD)**

- the pipeline skeleton is written first and is the gate; G1 + G2 skeletons stay green

**Done when**

```sh
pnpm --reporter=silent verify && pnpm exec vitest run tests/integration/skeleton && node scripts/build.ts --out .build/gate-3 && node scripts/pack-check.ts .build/gate-3 && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G3
```

### W4 — Run host + CLI + E2E fixtures (first spec-29-shaped green through the BUILT CLI); L1 sandbox, Pi child, prompts

**Mode:** parallel — all units at once, then the integrator alone.

**Goal.** The published application: composition root and detached run host, pure-reader observers and MAC-signing controllers, every CLI verb of DESIGN §9 (human + --json + --panel), fixture repositories + fake scripts + the first E2E tests; and, off the critical path, the L1 OS sandbox backends, the Pi child (the only Pi-importing code) with conformance + tripwires + auth canary, and the shipped prompts/skills.

**Green state at the gate.** The G-demo through the immutable gate build: `cohorte init` on the ts-monorepo fixture -> `cohorte spec freeze add-greeting` -> `cohorte run add-greeting --runtime fake --script fixtures/scripts/happy.yaml --detach --json` -> `cohorte tail <run> --json` from a second process -> `kill -9` the host mid-BUILD -> `cohorte resume <run>` -> COMPLETED with exactly one commit per effect key. PiRuntime passes the same conformance suite as FakeRuntime on the faux provider.

**Exit check.**

```sh
pnpm --reporter=silent verify && node scripts/check-prompts.ts && node scripts/build.ts --out .build/gate-4 && node scripts/pack-check.ts .build/gate-4 && COHORTE_E2E_BUILD_DIR=.build/gate-4 pnpm exec vitest run --project e2e tests/e2e && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G4
```

| Unit | Title | Depends on | Size |
|---|---|---|---|
| U4.01 | apps/cli host: composition root, detached `__host`, AssetSource, InstallInspector, run plan + sandbox default | U3.INT | ~2300 lines |
| U4.02 | apps/cli observers + controllers: SIGKILL-safe pure readers, replay from sequence, MAC-signed inbox commands, `start` | U3.INT | ~1900 lines |
| U4.03 | CLI commands A — run & control verbs: run, resume, pause, cancel, shutdown, approve, deny, retry, skip, review, fix, ship, run-tool, send | U3.INT, U0.10 | ~1800 lines |
| U4.04 | CLI commands B — read verbs + presentation: status, inspect, logs/tail, diff, error rendering, --panel adapters, --format=line | U3.INT, U0.10 | ~2000 lines |
| U4.05 | CLI commands C — project verbs + doctor: init, doctor, discover, reconcile --plan, config, spec, policy explain, migrate, gc, update --check, brainstorm | U3.INT, U0.10, U3.08, U3.09 | ~2300 lines |
| U4.06 | E2E fixtures + fake scripts + first E2E tests (happy path, review->fix->clean, the G-demo) — red until gate G4 | U3.INT, U2.10, U1.06 | ~2300 lines |
| U4.07 | security/sandbox L1: in-house Seatbelt + bubblewrap backends, probes, brain profile wrapper | U3.INT, U1.04 | ~1600 lines (off the critical path) |
| U4.08 | runtime-pi CHILD — the only Pi-importing code: entry, forwarding tools, normaliser, budgets, auth modes; conformance on faux, tripwires, auth canary — skeleton (b), part 2 | U3.INT, U1.07, U2.10 | ~2500 lines (off the critical path) |
| U4.09 | Shipped assets: prompts (system, agents, phases) + skills ported from V2 doctrine, `check-prompts` (no control logic in Markdown) | U3.INT, U0.08 | ~1500 lines (mostly Markdown) |
| U4.INT (integrator) | Gate G4 — integrate Wave 4; the G-demo through the immutable gate build (detach, tail, kill -9, resume, COMPLETED) | U4.01, U4.02, U4.03, U4.04, U4.05, U4.06, U4.07, U4.08, U4.09 | integration fixes; the longest gate |

#### U4.01 — apps/cli host: composition root, detached `__host`, AssetSource, InstallInspector, run plan + sandbox default

- **Origin:** DESIGN U2.7 (split 1/2) · **Size:** ~2300 lines · **Depends on:** U3.INT
- **Read first:** DESIGN §0.3, §1.2 (L5, ports implemented by apps/cli), §1.3 (entryOverride rule), §1.4, §2.8 (fatal handlers), §4.7, §6.2, §6.3, §2.6.6 (default `native` rule), §2.3.3 (RunPlan, pipeline.started), ADR-0004, ADR-0022, ADR-0023; tests/integration/skeleton/pipeline.itest.ts (the G3 test-local composition: derive `createRunHost()` from it); <SCRATCH>/understand/francois.md (clients kill their process group after 10 s)
- **Owns:** `apps/cli/src/compose/**`, `apps/cli/src/host/**`, `apps/cli/src/assets/**`, `apps/cli/src/pin/**`, `apps/cli/test/compose/**`, `apps/cli/test/host/**`, `apps/cli/test/assets/**`, `apps/cli/test/pin/**`

**Deliverables**

- `createRunHost()` — the ONLY place that names a concrete runtime, store, executor, key store; runtime selection (`pi` | `fake` + `--script`); `sandboxWrapper` injected into `createPiRuntimeProvider`; the L1 backends are imported from `@cohorte/security/sandbox` in ONE file, `compose/defaults.ts`, which this unit's tests never load (they inject `sandboxBackends`) because U4.07 is writing that area during this wave; `RunPlan` construction incl. the computed `sandbox.require` default (`native` when the runtime is a real model runtime and any role holds `run_command`, else `best-effort`), metered providers, prompt overrides, and `RunPlan.trust` (from the config loader's trust block; the T04 fact `config.trust-satisfied` is re-evaluated by the HOST, which is what resolves the config into the snapshot).
- `cohorte __host --run <id>`: spawned DETACHED from the run's PINNED install dir after its `dist/**` hashes verify (never from whichever CLI the user typed), stdio -> `runs/<id>/host.log`, `unref()`; lease + heartbeat mirror; inbox poll 250 ms + `fs.watch` of the poke file; idle exit / pause keep-alive — idle exit is SUSPENDED while a quota wake-up is armed and `policy.quota.autoResume` is on (plan windows reset after hours; bound: a `resetsAt` more than 24 h ahead is treated as unknown), DESIGN 2.5.3 —; `unhandledRejection` + `uncaughtException` handlers that commit `FAILED` + checkpoint (`cause:'fatal'`) and exit 1; refuses uid 0 (`security/root-refused`); guard `host.outside-target` (`security/runtime-inside-target`); `--foreground` for CI/tests; EPIPE swallowed; static ESM graph only (no `import(` after start).
- `AssetSource` (embedded prompts/skills/schemas/migrations + manifest verification + cross-check with the compiled-in `__ASSETS_TREE_SHA256__`) and `InstallInspector` (bundle paths + hashes == `bundle-manifest.json`); `HostSpawner` implementation of the W0 `CliContext` contract.

**Tests first (TDD)**

- host lifecycle with a fake engine: lease/heartbeat, poke wake-up, idle exit; fatal handler commits FAILED + checkpoint
- refuses uid 0 (stubbed); refuses to run from inside the target repo or a worktree root
- asset tamper => verification fails; bundle-manifest mismatch => `security/runtime-pin-mismatch`
- the host is spawned from `runs.pinned_install_dir`, not `process.argv[1]`; the token `entryOverride` does not occur under `apps/cli/src` (check-layers)
- sandbox default table: fake runtime => best-effort; pi + `run_command` => native; `native` + no backend => run refuses to start
- quota auto-resume with `FixedClock`: QUOTA_EXCEEDED with `resetsAt` = now + 500 min => the host is still alive after `idleExitMinutes`, fires the wake-up at `resetsAt` and resumes; with `autoResume: false` (or `resetsAt` > 24 h) it idle-exits and the run stays QUOTA_EXCEEDED

**Done when**

```sh
pnpm --reporter=silent unit:check U4.01
```

#### U4.02 — apps/cli observers + controllers: SIGKILL-safe pure readers, replay from sequence, MAC-signed inbox commands, `start`

- **Origin:** DESIGN U2.7 (split 2/2) · **Size:** ~1900 lines · **Depends on:** U3.INT
- **Read first:** DESIGN §0.2 (I12), §2.3.2 (durable vs ephemeral table), §2.3.4 (routes table, exit codes), §2.3.5, §4.5, §4.7, §7.4 (S-35), ADR-0004, ADR-0019, ADR-0022; <SCRATCH>/understand/francois.md, francois-vision.md (R1, R4, R5)
- **Owns:** `apps/cli/src/observe/**`, `apps/cli/src/control/**`, `apps/cli/test/observe/**`, `apps/cli/test/control/**`

**Deliverables**

- `Observer`: status documents through the U2.06 projection; `logs|tail --follow [--since-seq N] [--replay K] [--ephemeral]` = durable events by `sequence` (poll 250 ms) merged with the spool tail in `(sequence, sub)` order; first line = `snapshot`; `heartbeat` every 15 s; exit codes per the W0 table (DESIGN 2.8 / 4.7): an observer started by `run`, or given `--wait`, exits 0 on COMPLETED, the `ErrorClass` code of `run.lastError` on FAILED/BLOCKED, 4 on a suspended state, 16 on CANCELLED; plain `status`/`logs`/`tail` exit 0 once the run is terminal or suspended; `inspect` reads (`InspectDocument`, incl. `diff` and `artifact` with the byte cap) are served by the same pure reader; NO lock, NO write, NO temp file, NO environment variable required (everything from `cwd` walk-up and `HOME`).
- `Controller`: sign with the project key (lazy create), `enqueueCommand` (`INSERT ... ON CONFLICT DO NOTHING`), touch `inbox.poke`, wait <= `--wait` (default 8 s, under François' 10 s kill), exit codes 0 completed / 3 rejected / 4 accepted-but-pending / 2 usage; spawns a detached host when none is alive and the command needs one (`policy.approvals.autoResume`).
- `start`: `{ run row IDLE, signed start command }` in ONE `transact('project', null, …)` using `putRun` + `tx.enqueueCommand` (the `U0.06` contract; the CLI writes only what it knows — the host-computed columns stay NULL until T04), then host spawn, returns `{ runId }` (`--detach` within 2 s).

**Tests first (TDD)**

- S-35 (unit half): SIGKILL of an observer mid-read does not affect the writer
- replay from `--since-seq` is exclusive and gapless; ordering with interleaved ephemerals; late client gets `snapshot` first
- controller with no host alive: `approve` leaves a grant / pending row and exits 4 or spawns per policy; duplicate `commandId` idempotent; same id + other body => conflict
- `start` is one transaction (crash point #1: a second `start` with the same `commandId` creates no second run)
- observer exit codes: a fake store driven to COMPLETED / FAILED(validation) / BLOCKED(security) / WAITING_APPROVAL / CANCELLED yields 0 / 11 / 13 / 4 / 16 under `--wait`, and 0 without it; `inspect --artifact` above the cap is truncated with `truncated: true`

**Done when**

```sh
pnpm --reporter=silent unit:check U4.02
```

#### U4.03 — CLI commands A — run & control verbs: run, resume, pause, cancel, shutdown, approve, deny, retry, skip, review, fix, ship, run-tool, send

- **Origin:** DESIGN U2.8 (split 1/3) · **Size:** ~1800 lines · **Depends on:** U3.INT, U0.10
- **Read first:** DESIGN §2.3.4, §2.5.1 (command matrix), §4.5, §4.6, §4.7, §9 (CLI row + verb semantics paragraph), §2.8 (exit codes), spec 21
- **Owns:** `apps/cli/src/commands/run/**`, `apps/cli/src/commands/resume/**`, `apps/cli/src/commands/pause/**`, `apps/cli/src/commands/cancel/**`, `apps/cli/src/commands/approve/**`, `apps/cli/src/commands/deny/**`, `apps/cli/src/commands/retry/**`, `apps/cli/src/commands/skip/**`, `apps/cli/src/commands/review/**`, `apps/cli/src/commands/fix/**`, `apps/cli/src/commands/ship/**`, `apps/cli/test/commands-control/**`, `apps/cli/src/commands/shutdown/**`, `apps/cli/src/commands/run-tool/**`, `apps/cli/src/commands/send/**`

**Deliverables**

- Each verb fills its W0 stub and talks ONLY to the W0 `CliContext` ports (so it is testable with fakes while U4.01/U4.02 are built in parallel): human output + stable `--json`, `--yes`, `--wait`, `--detach`, `--foreground`, `--runtime`, `--script`, `--phase`, `--model`, `--profile`.
- Semantics fixed by DESIGN §9: `run` validates, starts, then BECOMES AN OBSERVER (Ctrl-C detaches and prints `cohorte status <runId>`); `review --ref|--base/--head|<run-id>` starts a `review`-profile run; `fix <run-id>` = `retry{target:{kind:'phase',state:'FIX'}}`; `ship <run-id>` shows and resolves the pending `ship` approval; `resume --ack blocked-inspected`; confirmation per policy for mutating verbs; `approve --answer <option>`; `shutdown <run> [--grace-ms]`, `run-tool` and `send` (= `agent.send`) fill their W0 stubs — the last two answer `configuration/phase-not-available` unless `policy.admin.runTool` / `policy.steer.enabled`. `run` (and `review`) apply the PROJECT-CONFIG TRUST rule of DESIGN 2.10.1 before anything is written: on `untrusted` they print the diff of loosening keys and ASK (TTY), accept `--trust-project-config`, and otherwise fail closed with `security/project-policy-untrusted` (exit 13) — no run row, no process.

**Tests first (TDD)**

- per verb with a fake `CliContext`: the exact `CommandEnvelope` (type + payload) produced; exit codes 0/2/3/4 and the WAIT rule (`run` on a run that ends FAILED exits with the class code, not 0); `--json` documents validate against `schemas/*.json`
- `run` with `--json` prints NDJSON envelopes only on stdout (logs go to stderr)
- usage errors are exit 2 with cause / impact / next action
- trust: hostile fixture config + no TTY => exit 13, zero envelopes produced; `--trust-project-config` => the start payload proceeds and the plan says `grantedBy: 'cli-flag'`; a granted record then an edited loosening key => asks again

**Done when**

```sh
pnpm --reporter=silent unit:check U4.03
```

#### U4.04 — CLI commands B — read verbs + presentation: status, inspect, logs/tail, diff, error rendering, --panel adapters, --format=line

- **Origin:** DESIGN U2.8 (split 2/3) · **Size:** ~2000 lines · **Depends on:** U3.INT, U0.10
- **Read first:** DESIGN §1.2 (net 4: cold-start budget), §2.3.5 (documents + panel paragraph), §2.8 (human output), §4.7 (observers), §9 (François row), §7.5 (AC-07), spec 18, spec 21; <SCRATCH>/understand/francois.md (today's `--panel` shapes that must keep working); <SCRATCH>/understand/v2-code.md (François --panel shapes in V2)
- **Owns:** `apps/cli/src/commands/status/**`, `apps/cli/src/commands/logs/**`, `apps/cli/src/commands/tail/**`, `apps/cli/src/commands/diff/**`, `apps/cli/src/render/**`, `apps/cli/src/panels/**`, `apps/cli/test/commands-read/**`, `apps/cli/test/render/**`, `apps/cli/test/panels/**`, `apps/cli/src/commands/inspect/**`

**Deliverables**

- `status [run-id] [--watch|--json]` (run document or `ProjectStatusDocument`), `logs` / `tail`, `diff <run-id>` (per-surface diffs of the integration branch; `--json` = `RunDiffDocument`), `inspect <run> --agent|--context|--approval|--effect|--snapshot|--locks|--diff|--artifact <id>` (`--json` = `InspectDocument`; R2, R6, R9 depend on it).
- `render/`: the spec-21 error rendering (`cause / impact / run / next action / exit code`) for every `ErrorClass`; human tree view; `--format=line` over `Envelope.summary`; **`render/sanitize.ts`** — EVERY human-facing string (approval previews, summaries, finding texts, output tails) has C0/C1 control characters other than `\n` and `\t` rendered as visible escapes; `--json` output is never altered (DESIGN 2.3.6).
- `panels/`: `--panel=<runs|approvals|agents|usage>` presentation adapters over the two documents (NOT protocol): no tabs, <= 512 chars per line, ALWAYS exit 0.
- Read-only verbs never load core/runtime code (lazy) and need no environment variable.

**Tests first (TDD)**

- golden `--json` documents validate against the published schemas; panel shape rules; line format
- error rendering table over all 13 classes with the documented exit codes
- read-only verbs work with a scrubbed environment and with no host alive; unknown event types / open-enum values are rendered, not crashed on (forward tolerance)
- S-54: an approval preview, a summary and a finding text containing `\x1b[2K` and a C1 CSI are rendered ESCAPED in the tree view, `--format=line` and every panel; `inspect`/`diff` `--json` validate against their schemas

**Done when**

```sh
pnpm --reporter=silent unit:check U4.04
```

#### U4.05 — CLI commands C — project verbs + doctor: init, doctor, discover, reconcile --plan, config, spec, policy explain, migrate, gc, update --check, brainstorm

- **Origin:** DESIGN U2.8 (split 3/3) · **Size:** ~2300 lines · **Depends on:** U3.INT, U0.10, U3.08, U3.09
- **Read first:** DESIGN §0.3 (the L0 sentence doctor prints), §2.4 (doctor --verify-state), §2.6.6 (SandboxCapabilities verbatim), §3.9 (capabilities table doctor prints), §5.9 (gc), §9 (CLI row, seams answering phase-not-available), §11 (D-17), spec 9 (doctor), 21; <SCRATCH>/understand/v2-code.md (the V2 doctor check framework worth porting: statuses + exact fix commands)
- **Owns:** `apps/cli/src/commands/init/**`, `apps/cli/src/commands/doctor/**`, `apps/cli/src/commands/discover/**`, `apps/cli/src/commands/reconcile/**`, `apps/cli/src/commands/config/**`, `apps/cli/src/commands/spec/**`, `apps/cli/src/commands/policy/**`, `apps/cli/src/commands/migrate/**`, `apps/cli/src/commands/gc/**`, `apps/cli/src/commands/update/**`, `apps/cli/src/commands/brainstorm/**`, `apps/cli/src/doctor/**`, `apps/cli/test/commands-project/**`, `apps/cli/test/doctor/**`

**Deliverables**

- `init [path] [--yes]` (applyInit + lazy project key + `.cohorte/.gitignore`), `discover` (prints the deterministic scan, writes nothing), `reconcile --plan`, `config get|set|validate`, `spec validate|freeze`, `policy explain -- <argv...>`, `migrate --check|--apply` (exit 3 when pending), `gc --dry-run|--apply` — the OWNER of `retention.*` (spec 19, DESIGN 5.9, ADR-0010): gzip `sensitive` files older than `compressAfterDays`, delete transcripts + wire logs older than `transcriptsDays`, artifacts older than `artifactsDays`, the spool one day after run end, purge events only through `runs.purgeable`, drop unreferenced CAS blobs; it NEVER touches a file of a non-terminal run; ages on the injected `Clock` —, `config trust --show|--grant|--revoke` (DESIGN 2.10.1), `update --check` (offline: installed vs pinned asset versions).
- Seams answer `configuration/phase-not-available` with a clear message: `brainstorm`, `discover --semantic`, `reconcile --apply`, `update --apply`.
- `doctor [--json] [--panel] [--verify-state]`: check framework over the W0-frozen check list — node version, git >= 2.38, state dir on a local filesystem, sandbox capabilities VERBATIM from `probeSandbox()` (incl. the L0 sentence, and `partial` — never `enforced` — until the platform's escape self-test S-28/S-29 passed), the detected package store with the exact `~/.cohorte/config.yaml` line to add (DESIGN 5.7), an armed quota wake-up, a run started from a linked development build, runtime capabilities verbatim, search backend (`rg` or the `git grep` fallback), locks, migrations, gitignore, uid != 0, key modes, low-memory warning for `budgets.concurrency`; `--verify-state` rebuilds projections from the log through `evolve` into a `MemoryStateStore`, diffs them, verifies chain + anchors + approval MACs. `--json` = `DoctorReport`. This unit owns `apps/cli/src/doctor/**` EXCEPT the sub-path `apps/cli/src/doctor/checks/auth/**` (a W0 stub filled by `U5.05`).

**Tests first (TDD)**

- each verb with a fake `CliContext`; `--json` validates against schemas; exit codes (migrate pending = 3)
- every seam returns `configuration/phase-not-available` and exit 10
- `doctor --json` sandbox block == what the probe observed; degradations are reported, never hidden
- `--verify-state`: a tampered projection => `corruption/projection-mismatch`; tampered chain => `security/event-chain-broken`
- `apps/cli/test/commands-project/gc-retention.test.ts` with `FixedClock`: compress-after, transcript expiry, artifact expiry, spool expiry; a NON-terminal run's files are untouched; `--dry-run` output == what `--apply` does

**Done when**

```sh
pnpm --reporter=silent unit:check U4.05
```

#### U4.06 — E2E fixtures + fake scripts + first E2E tests (happy path, review->fix->clean, the G-demo) — red until gate G4

- **Origin:** DESIGN U2.9 · **Size:** ~2300 lines · **Depends on:** U3.INT, U2.10, U1.06
- **Read first:** DESIGN §7.0, §7.3 (fixture table), §10.5 (Green state G2 = this plan's G4 demo), §5.7, §3.10 (FakeScript), spec 25.3, spec 29 bullet 1; apps/cli/src/contract/** and packages/protocol (the tests are written against the W0 CLI/protocol contracts from day 1)
- **Owns:** `fixtures/repos/ts-monorepo/**`, `fixtures/repos/frontend-backend/**`, `fixtures/scripts/happy.yaml`, `fixtures/scripts/review-fix.yaml`, `fixtures/specs/**`, `tests/e2e/support/**`, `tests/e2e/happy/**`, `tests/e2e/review-fix/**`, `tests/e2e/demo/**`, `tests/integration/fixtures/**`

**Deliverables**

- Fixture BUILDERS `fixtures/repos/<name>/build.ts` producing a fresh git repo per test (never a committed `.git`): `ts-monorepo` (pnpm, 2 packages, 2 surfaces, vitest; `.cohorte/` with `checks` argv and an OFFLINE-capable `provision.argv` = `pnpm install --frozen-lockfile --ignore-scripts --offline`, lockfile generated against the versions already in the machine's pnpm store; `tests/e2e/support` writes the throwaway HOME's `~/.cohorte/config.yaml` with `provision.cacheDirs` = the machine's real store path so that the Provisioner can set `npm_config_store_dir` although `HOME` is a scratch dir, and passes `--trust-project-config` because a fixture's `checks` / `provision.argv` are loosening keys (DESIGN 2.10.1, 5.7)) and `frontend-backend` (ownership split, `shared` surface with `approval: human`, a contract file).
- `fixtures/scripts/happy.yaml`, `review-fix.yaml` (round 1 finding with location + reproduction, round 2 clean), frozen specs under `fixtures/specs/` (`add-greeting`).
- `tests/e2e/` through the BUILT CLI only (`runCli`, `$COHORTE_E2E_BUILD_DIR`, throwaway HOME): happy path; review -> fix -> clean; `demo/` = detach, tail from a second process with `--since-seq`, `kill -9` the host mid-BUILD, `resume`, COMPLETED, exactly one commit per `Cohorte-Effect` key.
- HONEST CHECK SEMANTICS: this unit's own check proves the fixtures and scripts (they build, validate against the FakeScript/spec/config schemas) and that the E2E files are discovered; the E2E tests themselves turn green at gate G4 (they need U4.01-U4.05 integrated).

**Tests first (TDD)**

- `tests/integration/fixtures/*.itest.ts`: each builder yields a valid repo (git facts, `.cohorte/` validates, checks argv are exact rules); scripts validate against `fake-script.schema.json`; specs freeze
- E2E tests written FIRST against the W0 contracts; expected red until G4

**Done when**

```sh
pnpm --reporter=silent unit:check U4.06 && pnpm exec vitest list --project e2e tests/e2e/happy tests/e2e/review-fix tests/e2e/demo
```

#### U4.07 — security/sandbox L1: in-house Seatbelt + bubblewrap backends, probes, brain profile wrapper

- **Origin:** DESIGN U1.3 (split 3/3) · **Size:** ~1600 lines (off the critical path) · **Depends on:** U3.INT, U1.04
- **Read first:** DESIGN §0.3, §2.6.6 (L1 row + policy paragraph), §3.6, §7.4 (S-25..S-27), §12.1 (Linux bwrap risk), §12.2 (A-2), ADR-0003; <SCRATCH>/understand/toolchain.md §8 (Seatbelt verified on Darwin 25; Linux documented, not run); <SCRATCH>/spike/child/out/09-sandbox-macos.txt (the Seatbelt profile the spike ran the SDK host under); docs/v3/probes/P3.md
- **Owns:** `packages/security/src/sandbox/**`, `packages/security/test/sandbox/**`

**Deliverables**

- `createSeatbeltBackend` and `createBubblewrapBackend`: PURE profile / argv generators (`wrap`), DENY-BY-DEFAULT on both platforms (DESIGN 2.6.6 — the `(allow default)` profile the toolchain research verified lets agent-written test code reach `open`/`osascript`, i.e. LaunchServices/AppleEvents processes OUTSIDE the sandbox, and signal the run host; `--ro-bind / /` leaves docker, D-Bus and agent sockets connectable). Seatbelt: `(deny default)` + explicit allows for `process-exec`, `process-fork`, `file-read*` minus `denyRead`, `file-write*` on the `fs.readWrite` roots minus `fs.readOnly`, `sysctl-read`, a MINIMAL `mach-lookup` list, `signal` to self/children only; the golden test asserts that `network*`, `lsopen`, `appleevent-send`, `job-creation` and `signal (target others)` are never allowed. bubblewrap: an EXPLICIT root set (`/usr`, `/bin`, `/lib*`, `/etc` read-only, node, PATH dirs, each `fs.readOnly` root `--ro-bind`, each `fs.readWrite` root `--bind`), `--tmpfs /run --tmpfs /tmp`, `--unshare-net --unshare-pid --unshare-ipc --unshare-uts --new-session --die-with-parent --cap-drop ALL`, a private `XDG_RUNTIME_DIR` (+ cgroup v2 through `systemd-run --user --scope` AROUND bwrap when present); `probe()` per backend incl. the AppArmor userns restriction with its exact remediation note.
- `wrapForPolicy(SandboxPolicy) -> argv` for the BRAIN child (DESIGN 3.6: `deny default`, `deny process-fork`, state dirs writable, provider port outbound) — injected into runtime-pi by the composition root, since runtime-pi may not import security.
- `require: native` + unavailable backend => `security/sandbox-unavailable`; degradations are asserted through `probeSandbox()`, never silently skipped. `probe()` runs the platform's ESCAPE SELF-TEST (cached per Cohorte version + OS build): until it passes, `filesystem`/`network`/`processEscape` are reported `partial`, never `enforced`, and `native` is not satisfied. Do NOT put `native` on the default/CI path for Linux before P3 has run there.

**Tests first (TDD)**

- golden-file tests of both generators (paths with spaces, multiple roots, denyRead set)
- on macOS, REAL Seatbelt through the U1.04 executor: S-25 no network (an allowed `curl` fixture rule fails closed), S-26 no write outside the worktree, S-27 no read of the denyRead set, **S-28** `open -a`, `open <file>` and `osascript` from an allowed command cannot create a canary outside the worktree and cannot signal the host; a write into the slot's `node_modules` (an `fs.readOnly` root inside a write root) fails; the fixture's real `node`/`pnpm`/`vitest` checks still RUN under the deny-default profile (assumption A-9)
- on Linux: **S-29** `connect()` to a Unix socket outside the worktree (and to `/var/run/docker.sock` / `$XDG_RUNTIME_DIR/bus` when present) fails — executed when `bwrap` works, otherwise skipped WITH the probe's reason and the capability reported as missing
- brain profile: fork denied, IPC channel intact (fake brain through the wrapper)

**Done when**

```sh
pnpm --reporter=silent unit:check U4.07
```

#### U4.08 — runtime-pi CHILD — the only Pi-importing code: entry, forwarding tools, normaliser, budgets, auth modes; conformance on faux, tripwires, auth canary — skeleton (b), part 2

- **Origin:** DESIGN U1.6b · **Size:** ~2500 lines (off the critical path) · **Depends on:** U3.INT, U1.07, U2.10
- **Read first:** DESIGN §3.1, §3.4 (the near-final listing), §3.5, §3.6, §3.7 (six layers), §3.8, §3.9 (capabilities table), §3.10 (fake provider, two tiers), §1.3 (never-bundled test entry), §7.2 (tripwires + auth rows), §7.4 (S-40..S-46), §12.2, ADR-0001, ADR-0015; docs/v3/probes/P1.md, P2.md, P4.md + docs/v3/gates/G2.md (the decisions this unit MUST follow); <SCRATCH>/spike/child/REPORT.md, <SCRATCH>/spike/sdk/REPORT.md, <SCRATCH>/understand/pi-sdk.md, pi-auth.md, pi-tools.md, pi-delta-*.md (Verification sections override bodies); <SCRATCH>/pi-live (0.85.1). SAFETY: tests use InMemoryCredentialStore / a temp authPath ONLY — never read, print or copy ~/.pi/agent/auth.json
- **Owns:** `packages/runtime-pi/src/child/**`, `packages/runtime-pi/test/support/**`, `packages/runtime-pi/test/child/**`, `packages/runtime-pi/test/conformance/**`, `packages/runtime-pi/test/auth/**`, `packages/runtime-pi/test/tripwires/tw-*.itest.ts`, `packages/runtime-pi/test/tripwires/type-proof.ts`

**Deliverables**

- `child/entry.ts` per DESIGN 3.4: `boot()` (Pi version equality, verified prompt, `ModelRuntime.create({authPath, modelsPath:null, allowModelNetwork:false})` — WITHOUT `refreshOnCreate:false`: the default create-time refresh (offline here) is what fills the auth snapshot, model-runtime.js:51-57/:97-103 —, explicit model, baseUrl check, `assertAuth` decided on LIVE secret-free calls (`checkAuth(p).type === 'oauth'`, `listCredentials()` contains `{providerId: p, type: 'oauth'}`, `getProvider(p).auth.apiKey === undefined`) with `isUsingSubscription` / `getProviderAuthStatus` as cross-checks only after an explicit `refresh({ providers: [p], allowNetwork: false })`, `SettingsManager.inMemory(..., {projectTrusted:false})`, the literal 11-method `ResourceLoader`, `tools` ALLOWLIST + forwarding `customTools` only, everything assigned BEFORE the first `prompt()`: `toolExecution='sequential'`, `transport='sse'`, `shouldStopAfterTurn`, the `streamFunction` wrapper written with pi-ai's `lazyStream` (the `StreamFn` contract forbids throwing or returning a rejected promise, pi-agent-core types.d.ts:3-13: a budget breach or an abort while parked must end as an error STREAM), the production GUARD FETCH installed through `options.fetch` (origin == pinned `baseUrl` origin, no `x-api-key`/`api-key` header, `provider.request` frame with `{origin, authScheme, refused}`; never a header value), the CHAINED `onResponse`), Pi VALUES obtained through `child/load-pi.ts` only (the one rule-g exemption; `loadFrom: 'bundle'` builds its specifier from the pinned install path), `signalOf(e, origin)` = the ONLY place that looks at engine error classes (`instanceof ModelsError` or the structural form) and produces the `ErrorSignal` the parent classifies, delivery of `task` then `note` (two user messages when Pi can carry them, else the fixed separator: rule 12 holds either way), engine stop reasons `pending`/`deferred` normalised to `error` + `runtime.warning`, `runPrompt` (rejection => typed `settled`), normaliser (NO Pi type crosses the channel), budget, latch, attestation, settle/close, `--selftest`.
- Auth child modes (`auth-status`, `auth-login`, `auth-logout`): `login()` bridged to `auth.show`/`auth.ask`, its returned `Credential` DROPPED UNREAD; Cohorte code never calls `readStoredCredential`, `getAuth()` or `pi auth print-*` (check-layers rule e).
- `test/support/agent-host.test-entry.ts` — a separate entry that is NEVER a bundle entry: imports the production `boot()` and injects a `ProviderSetup` (in-process faux provider, or the real `openai-codex` provider with a dummy credential + injected `fetch`).
- DAY-1 CHECKPOINT (pre-agreed): if the SDK-in-child host is not green on the Node IPC channel by the first working session, switch `child/**` to the already-executed `runRpcMode` host behind the SAME parent and frame protocol — nothing outside `packages/runtime-pi/src/child/**` changes.

**Tests first (TDD)**

- the Wave-0 `runtimeConformance` suite green on PiRuntime (parent + real Pi loop + faux provider)
- tripwires (permanent, fail loudly on any Pi bump): hostile repo has zero effect (`.pi/settings.json` sessionDir, `.pi/SYSTEM.md`, `AGENTS.md`); allowlist => `Tool bash not found`; a typo in the allowlist fails attestation; `terminate` ends the run; `shouldStopAfterTurn`; abort while a tool waits; EOF while waiting; empty-file transcript trick; `tool_call` is STILL fail-open by omission; A-1 wrapper seen for every request; `prompt()` rejection => typed `settled`; **`tw-auth-snapshot`** (with `refreshOnCreate:false` the snapshot accessors are false although a credential is stored; after `refresh()` they agree with the live calls); **`tw-stream-contract`** (breaching `maxModelRequests`, and aborting while parked at the model boundary, both end with `settled` + a typed cause, ZERO unhandled rejections, ZERO extra model requests); **`tw-credential-lock`** (a locked temp `authPath` yields `ModelsError` code `'auth'` with the "Credential store … failed" text => the parent classifies it transient); **`tw-continuation-note`** [A-8]; **`tw-guard-fetch`** (the guard sees every request of a run; a foreign origin or an `x-api-key` header is refused before any byte leaves); `type-proof.ts` compile-time API proof; import-weight and no-non-loopback-socket audits
- `auth-canary.itest.ts` S-40..S-46: parent env canaries never reach a request; stored `api_key` credential => AUTH_REQUIRED/`mode-mismatch`; expired OAuth + failing refresh => AUTH_REQUIRED; ambient source refused; `baseUrl` mismatch => BLOCKED; codex `not_applicable` vs Anthropic opt-in a number; rule-(e) symbols absent from the repo
- at most 2 Pi children concurrently in tests (~200 MB RSS each)
- the identifier `guardFetch` is PRESENT in the built `agent-host.mjs` (it is production code, not a test hook) while `faux`, `registerNativeProvider`, `InMemoryCredentialStore` stay absent

**Done when**

```sh
pnpm --reporter=silent unit:check U4.08 && node scripts/check-layers.ts
```

#### U4.09 — Shipped assets: prompts (system, agents, phases) + skills ported from V2 doctrine, `check-prompts` (no control logic in Markdown)

- **Origin:** DESIGN U1.11 · **Size:** ~1500 lines (mostly Markdown) · **Depends on:** U3.INT, U0.08
- **Read first:** DESIGN §0.2 (I10), §1.2 (check-prompts), §2.7 (submit_result wording), §2.9 (AgentOutput field names), §2.10 (prompts/skills rows), §3.5 (structured result), §7.1 (last row), §9 (roles row), spec 4.1, spec 8; <SCRATCH>/understand/v2-doctrine.md (the ~75 CL-* control-logic rules: each one lives in TypeScript now and must NOT reappear in a prompt; doctrine per role); legacy/v2/core/agents, legacy/v2/core/commands (source doctrine)
- **Owns:** `prompts/**`, `skills/**`, `scripts/check-prompts.ts`, `tests/integration/assets/**`

**Deliverables**

- `prompts/system/{base,untrusted-data,submit-result}.md`, `prompts/agents/{implementer,fixer,reviewer,security-reviewer}.md` (exercised in V3.0) + reserved ids with minimal doctrine for the other spec-8 roles, `prompts/phases/**`, `prompts/discovery/README.md` (seam); front matter with unique ids.
- `skills/_shared`, `skills/testing`, `skills/security-review` as `skills/<id>/{SKILL.md,skill.yaml}` — `skill.yaml` validates against the W0 `SkillManifest` schema; `checks` are `{ argv: [...] }` entries and DECLARATIVE (surfaced in context, never auto-run, no command rule); a skill cannot grant a permission.
- `scripts/check-prompts.ts`: fails on transition / verdict / stop vocabulary under `prompts/**` and `skills/**` (spec 4.1, spec 29 bullet 2); wired into `pnpm lint` by U4.INT.

**Tests first (TDD)**

- `tests/integration/assets/*.itest.ts`: front-matter ids unique; every role exercised in V3.0 has a prompt; every `skill.yaml` validates; tool names and `AgentOutput` field names used in prompts exist in the catalogue/schema
- `check-prompts` catches a planted 'then move to REVIEW' sentence and passes on the shipped tree

**Done when**

```sh
pnpm --reporter=silent unit:check U4.09 && node scripts/check-prompts.ts
```

#### U4.INT — Gate G4 — integrate Wave 4; the G-demo through the immutable gate build (detach, tail, kill -9, resume, COMPLETED)

- **Origin:** DESIGN gate G2 · **Size:** integration fixes; the longest gate · **Depends on:** U4.01, U4.02, U4.03, U4.04, U4.05, U4.06, U4.07, U4.08, U4.09
- **Read first:** DESIGN §10.1, §10.5 (Green state G2), §4.7, §7.3; docs/v3/requests/*.md filed during the wave
- **Owns:** *all structural paths (§3 rule 2)*, `docs/v3/gates/G4.md`

**Deliverables**

- Requests applied; `check-prompts` added to `pnpm lint`; `pnpm verify` green; conformance suite green on BOTH runtimes.
- `.build/gate-4/` built, packed and installed; U4.06's E2E tests green against it — in particular `tests/e2e/demo` (the spec-29-shaped demo). From this gate on, every exit check runs the E2E project through the gate build.
- Rollback checkpoint; `docs/v3/gates/G4.md` lists every cross-unit fix made.

**Tests first (TDD)**

- the E2E project is the gate

**Done when**

```sh
pnpm --reporter=silent verify && node scripts/check-prompts.ts && node scripts/build.ts --out .build/gate-4 && node scripts/pack-check.ts .build/gate-4 && COHORTE_E2E_BUILD_DIR=.build/gate-4 pnpm exec vitest run --project e2e tests/e2e && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G4
```

### W5 — Hardening: crash-at-every-transition, security table end to end, more E2E, Pi in the loop, auth CLI, packaging + hash manifest, schema-compat + migrations, protocol integration, dogfood

**Mode:** parallel — all units at once, then the integrator alone.

**Goal.** Prove the properties spec 29 asks for with named tests: the real-SIGKILL crash matrix over a recorded golden run, the S-* security table end to end (incl. L1 and the control plane), the remaining spec-25.3 E2E fixtures, PiRuntime composed in the full loop on the faux provider, the auth/providers/models verbs, the packaging job (tarball allowlist, asset + pin tamper), schema compatibility + state migrations, protocol/approvals/retries integration suites, and the six dogfooding tests of spec 16 on the Cohorte repository itself.

**Green state at the gate.** Every CI job of DESIGN 7.6 except `acceptance` has a green local equivalent against the gate build on macOS; the FakeRuntime E2E path still runs through the built CLI; Cohorte (fake runtime, copy install) adds a small feature to a clone of Cohorte in a worktree while its own runtime stays pinned.

**Exit check.**

```sh
pnpm --reporter=silent verify && node scripts/check-prompts.ts && node scripts/build.ts --out .build/gate-5 && node scripts/pack-check.ts .build/gate-5 && COHORTE_E2E_BUILD_DIR=.build/gate-5 pnpm exec vitest run --project e2e && node scripts/schema-compat.ts && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G5
```

| Unit | Title | Depends on | Size |
|---|---|---|---|
| U5.01 | Crash at every transition: golden-run recorder, real-SIGKILL every-pair matrix, meta-test, sharding | U4.INT, U2.10, U4.06 | ~1500 lines |
| U5.02 | Security E2E: the S-* table through the built CLI, `permissions-secrets` fixture, L1 probes, control-plane forgery, prompt injection | U4.INT, U4.07, U2.10 | ~2200 lines |
| U5.03 | E2E II: frontend/backend, unknown-ambiguous, provider faults, vuln-then-fix, concurrent runs | U4.INT, U4.06 | ~2200 lines |
| U5.04 | Pi in the loop: the full slice composed programmatically with PiRuntime + faux provider (pause, cancel, approval over IPC, brain crash) | U4.INT, U4.08, U4.01 | ~1200 lines |
| U5.05 | CLI auth / providers / models verbs through the child auth modes + doctor auth checks with billing caveats | U4.INT, U4.08, U3.10 | ~1300 lines |
| U5.06 | Packaging + hash manifest + runtime pin: the packaging CI job, asset tamper, pin tamper, cold-start budget | U4.INT, U0.10 | ~1300 lines |
| U5.07 | Schema compatibility (five checks) + state migrations: golden instances, structural diff, forward tolerance, refuse-then-migrate | U4.INT, U1.01, U0.G | ~1600 lines |
| U5.08 | Integration suites: event protocol golden stream (validated with ajv), approvals, retries | U4.INT, U4.01 | ~1400 lines |
| U5.09 | Dogfood: D1-D6 on a working-tree copy of the Cohorte repository, the repo's own `.cohorte/`, side-by-side `dogfood-install` | U4.INT, U4.06 | ~2000 lines |
| U5.INT (integrator) | Gate G5 — integrate Wave 5: all hardening suites green on the gate build | U5.01, U5.02, U5.03, U5.04, U5.05, U5.06, U5.07, U5.08, U5.09 | integration fixes |

#### U5.01 — Crash at every transition: golden-run recorder, real-SIGKILL every-pair matrix, meta-test, sharding

- **Origin:** DESIGN U3.1 · **Size:** ~1500 lines · **Depends on:** U4.INT, U2.10, U4.06
- **Read first:** DESIGN §4.1, §4.3 (registry + the 22 rows), §4.4, §7.3 (crash paragraph), §7.5 (AC-04), §7.6 (crash-matrix job), spec 25.3 'crash à chaque transition'
- **Owns:** `tests/crash/**`

**Deliverables**

- `tests/crash/every-transition.e2e.ts`: (1) record the golden `ts-monorepo` scripted run and its `(point, occurrence)` hit list; (2) FOR EACH PAIR start the run with a detached host and `COHORTE_CRASH_AT=<name>#<n>` (real `SIGKILL`, no `finally`), wait for the host to die, `cohorte resume`, assert against the golden final state: same terminal state, same integration tree digest, the same set of effect keys with exactly one `done` each, no two commits with the same `Cohorte-Effect` trailer, gapless sequence + valid chain + valid anchors, zero leftover processes (pid/startToken sweep), zero leftover worktrees, a `ResumeReport` consistent with the crash point; (3) META-TEST: a name in `CRASHPOINTS` never hit fails the suite.
- Sharding by `CRASH_SHARD=i/n` (CI runs the real-SIGKILL matrix on EVERY PR, sharded); an in-process thrown-exception mode as a fast local smoke only.

**Tests first (TDD)**

- the matrix is the test; first commit of work = the recorder + the meta-test (red on unhit points), then the per-pair assertions

**Done when**

```sh
pnpm --reporter=silent unit:check U5.01
```

#### U5.02 — Security E2E: the S-* table through the built CLI, `permissions-secrets` fixture, L1 probes, control-plane forgery, prompt injection

- **Origin:** DESIGN U3.2 · **Size:** ~2200 lines · **Depends on:** U4.INT, U4.07, U2.10
- **Read first:** DESIGN §0.2 (all invariants), §0.3, §7.3 (`permissions-secrets` row), §7.4 (every S-* id, EV-14/15), §7.5 (AC-03), §7.6 (security job), spec 23; <SCRATCH>/understand/v2-security-isolation.md (the 11 confirmed evasions, as end-to-end regression ideas)
- **Owns:** `tests/security/**`, `fixtures/repos/permissions-secrets/**`, `fixtures/scripts/security/**`

**Deliverables**

- `fixtures/repos/permissions-secrets` builder: `.env`, symlink to `/etc`, hardlink, `.git/hooks`, husky dir, README prompt injection.
- End-to-end cases with named ids: MUST-DENY paths through a running pipeline; redaction of an echoed secret in DB, logs, blobs and model-facing text (S-50..S-53); `policy-violation` stop after N denials; BLOCKED on a write outside ownership done BY A COMMAND; S-20..S-27 under L1 on macOS (degradations asserted through `doctor --json`, never skipped silently); S-30..S-35 control plane (forged MAC => rejected and the approval stays pending; missing MAC; replayed `commandId`; tampered event row; rewritten chain without the key; `UPDATE events` blocked; zombie host fenced; SIGKILL of the CLI observer does not affect the run); S-60 rogue runtime; S-61 prompt injection (both calls denied, run continues, two `tool.denied`); S-70 hook canary; S-71 provisioning scripts canary; S-72 host refuses uid 0; and the ids added by the design revision: S-28 (macOS escape via `open`/`osascript`/signal) and S-29 (Linux Unix-socket escape; skipped WITH the probe's reason on darwin), S-36 separation of identities (no agent tool-call sequence yields an accepted command, a resolved approval or an event with `source: human|client`), S-37/S-38 project-config trust (hostile config => `security/project-policy-untrusted`, zero processes; granted then edited => new ask), S-53 extended (a canary on the brain child's stderr is absent from `host.log`), S-54 terminal injection, S-73 dependency integrity (a check cannot modify `node_modules` under L1; detected before the next TEST under L0), S-74 no hardlink into the package store.

**Tests first (TDD)**

- one test per S-id, named by the id; AC-03 is derivable by id

**Done when**

```sh
pnpm --reporter=silent unit:check U5.02
```

#### U5.03 — E2E II: frontend/backend, unknown-ambiguous, provider faults, vuln-then-fix, concurrent runs

- **Origin:** DESIGN U3.3 (+ the fixture rows of 7.3 not covered by U4.06) · **Size:** ~2200 lines · **Depends on:** U4.INT, U4.06
- **Read first:** DESIGN §7.3 (fixture table rows 2, 3, 5, 6, 7), §5.6 (locks, zones), §2.5.3 (stop reasons -> states), §3.8, ADR-0006, spec 25.3
- **Owns:** `tests/e2e/frontend-backend/**`, `tests/e2e/unknown/**`, `tests/e2e/provider-faults/**`, `tests/e2e/vuln/**`, `tests/e2e/concurrent/**`, `fixtures/repos/unknown-ambiguous/**`, `fixtures/scripts/faults/**`, `fixtures/scripts/vuln/**`, `fixtures/scripts/concurrent/**`, `fixtures/scripts/frontend-backend/**`

**Deliverables**

- `frontend-backend`: ownership split, `shared` surface with `approval: human`, serialized agents, contract-file exact-match stop. `unknown-ambiguous` builder (two lockfiles, no test script): `init` lists unknowns and never invents a command; `reconcile --plan` stable.
- `provider-faults` scripts: timeout, 429 with reset => QUOTA_EXCEEDED, 401 => AUTH_REQUIRED, then `resume`; assertion that NO silent fallback to another provider or to API billing occurs. `vuln-then-fix`: a security finding with location + reproduction => FIX => re-review clean.
- `concurrent`: two runs on `ts-monorepo` — overlapping zones refused (`conflict/zone-reserved` naming the holder), disjoint zones coexist, project lock exclusive for `migrate --apply`, host takeover.

**Tests first (TDD)**

- one E2E file per spec-25.3 bullet, through the built CLI

**Done when**

```sh
pnpm --reporter=silent unit:check U5.03
```

#### U5.04 — Pi in the loop: the full slice composed programmatically with PiRuntime + faux provider (pause, cancel, approval over IPC, brain crash)

- **Origin:** DESIGN U3.4 · **Size:** ~1200 lines · **Depends on:** U4.INT, U4.08, U4.01
- **Read first:** DESIGN §1.3 (Pi + faux only through `createRunHost()` from tests), §3.5, §3.10 (tier a), §4.5, §4.6, §7.2, §7.5 (AC-06), §11 (D-19); SAFETY: InMemoryCredentialStore only; never the user's Pi auth file
- **Owns:** `tests/integration/pi-faux/**`

**Deliverables**

- `createRunHost()` composed from tests with `createPiRuntimeProvider({ entryOverride: <never-bundled test entry> })`: the same scripted slice the fake runtime runs, driven by the REAL Pi loop on the faux provider; pause / resume (tool boundary, and model boundary per the P1 verdict), cancel ladder, approval held over IPC then granted, brain crash => new incarnation of the same attempt with a reconciliation note, heartbeat loss, budget breach.

**Tests first (TDD)**

- each scenario is an `*.itest.ts`; at most 2 children at a time; the durable event sequence of the Pi run equals the fake run's after normalisation (AC-06 evidence)
- parked approval on the REAL Pi loop: the wait exceeds `parkAfterMinutes` (FixedClock) => brain aborted; `approve` => the host replays the stored call, then the next incarnation receives `task` + the continuation `note` (conformance rule 12 on Pi) and never re-issues the call

**Done when**

```sh
pnpm --reporter=silent unit:check U5.04
```

#### U5.05 — CLI auth / providers / models verbs through the child auth modes + doctor auth checks with billing caveats

- **Origin:** DESIGN U3.5 · **Size:** ~1300 lines · **Depends on:** U4.INT, U4.08, U3.10
- **Read first:** DESIGN §2.2.1 (AgentRuntimeProvider.authStatus/login/logout, LoginInteraction), §2.2.7 (ProviderAuthStatus), §3.4 (auth modes paragraph), §3.7 (layer 6 + the D2 paragraph), §9 (CLI row), §11 (D-5), spec 10.1, ADR-0005, ADR-0015; <SCRATCH>/understand/pi-auth.md (+ Verification). SAFETY: tests run against a temp authPath / in-memory store; never the real credential store
- **Owns:** `apps/cli/src/commands/auth/**`, `apps/cli/src/commands/providers/**`, `apps/cli/src/commands/models/**`, `apps/cli/test/commands-auth/**`, `apps/cli/src/doctor/checks/auth/**`, `apps/cli/test/doctor-auth/**`

**Deliverables**

- `auth login|status|logout` through `AgentRuntimeProvider` (the ENGINE's credential store, shared with François, R7): owned timeout + cancel, prompt teardown, every text sealed before display; status shows provider, billing (`plan-limits | metered`), origin, caveats — WITHOUT ever reading a token; `--json` = `AuthStatusDocument`. ACCOUNT LABEL (DESIGN D-24): Pi 0.85.1 exposes the account id only through the banned, token-bearing `readStoredCredential()`, so `auth status` and `doctor` print `account: not exposed by the engine` (`accountLabelNote`), `accountLabel` stays absent and `authStatusWithoutSecret` is `partial`; a runtime that does expose a label is shown as is.
- `providers list|test`, `models list` (static tier table + allowlist); doctor auth checks module `apps/cli/src/doctor/checks/auth/**` (a W0 stub created by `U0.10`, listed in the W0-frozen check list, excluded from `U4.05`'s ownership): auth state per allowlisted provider, the per-token-billing and provider-terms caveats for the Anthropic opt-in, `unknown-transient` never mapped to AUTH_REQUIRED.

**Tests first (TDD)**

- verbs against a fake `AgentRuntimeProvider` and against the Pi child auth modes with a temp authPath; login timeout / Ctrl-C teardown; sealed error text
- `--json` validates; no token-shaped string in any output (canary credential); exit codes
- D-24: with a canary credential whose `accountId` is a canary string, NO output of `auth status` / `doctor` (human, `--json`, panel) contains it, and the `not exposed by the engine` note is present

**Done when**

```sh
pnpm --reporter=silent unit:check U5.05
```

#### U5.06 — Packaging + hash manifest + runtime pin: the packaging CI job, asset tamper, pin tamper, cold-start budget

- **Origin:** DESIGN U3.6 (packaging + pin half) · **Size:** ~1300 lines · **Depends on:** U4.INT, U0.10
- **Read first:** DESIGN §1.4, §1.2 (net 4), §3.9, §6.2, §6.3, §7.5 (AC-08), §7.6 (packaging job), spec 26, spec 29 bullet 8; <SCRATCH>/understand/toolchain.md §3 (leak of devDependencies, silent inlining)
- **Owns:** `tests/packaging/**`

**Deliverables**

- `tests/packaging/*.e2e.ts` on a PRIVATE build (`node scripts/build.ts --out .build/U5.06`): `pnpm pack` from `.publish` -> `npm i --ignore-scripts <tgz>` in an empty dir -> `cohorte --version`, `doctor --json`, `agent-host.mjs --selftest`; `verifyAssets` ok then tamper => fail; tarball contains ONLY `dist/ assets/ LICENSE README.md package.json`; no `@cohorte/*`, no `devDependencies`, no `scripts`, no test-hook strings (`faux`, `registerNativeProvider`, `InMemoryCredentialStore`); `cli.mjs` imports no `@earendil-works/*`; `bundle-manifest.json` == sha256 of every file under `dist/`; `assets/manifest.json` `treeSha256` == the constant compiled into the bundle. Also asserted: the `node_modules` link of a linked build is NOT in the tarball; a real `npm install` yields the `install-lock` pin artifact that a linked build lacks; `agent-host.mjs` CONTAINS `guardFetch` (production code).
- Pin tamper: a byte appended to the installed `agent-host.mjs` => next spawn `security/runtime-pin-mismatch` => BLOCKED; `resume` with a changed bundle is REFUSED (no adopt flag); cold start `cohorte status --panel=runs` < 300 ms.

**Tests first (TDD)**

- the packaging job is the test

**Done when**

```sh
node scripts/build.ts --out .build/U5.06 && COHORTE_E2E_BUILD_DIR=.build/U5.06 pnpm --reporter=silent unit:check U5.06
```

#### U5.07 — Schema compatibility (five checks) + state migrations: golden instances, structural diff, forward tolerance, refuse-then-migrate

- **Origin:** DESIGN U3.6 (schema-compat + migrations half) · **Size:** ~1600 lines · **Depends on:** U4.INT, U1.01, U0.G
- **Read first:** DESIGN §0.1 (C3), §2.3.2 (compat rules), §2.4 (migrate, StoreInfo), §6.3 (#5), §6.4 (D5 mechanics), §7.1 (migrations row), §7.6 (schema-compat + migrations jobs), spec 20, spec 25; scripts/schema-compat.ts `--self` mode written at G0 (hand-over: this unit now owns the file)
- **Owns:** `scripts/schema-compat.ts`, `fixtures/state/**`, `fixtures/schema-compat/golden/**`, `tests/integration/migrations/**`, `tests/integration/schema-compat/**`

**Deliverables**

- `scripts/schema-compat.ts` full job: (1) `gen-schemas --check`; (2) every schema compiles under `ajv/dist/2020` strict; (3) golden instances of every past release validate under the new schemas; (4) structural diff vs the last release baseline — removed property, new `required`, narrowed closed enum, changed type or changed DURABILITY is BREAKING; (5) forward tolerance: the previous release's OPEN schema accepts the new golden stream. Baseline = `fixtures/schema-compat/golden/3.0.0/` (no release tag exists yet on this branch).
- `fixtures/state/`: golden SQLite DB fixtures per state schema version; `tests/integration/migrations`: every fixture -> head; refuse-then-migrate flow (`status` refuses with the exact instruction, `migrate --check` exits 3, `migrate --apply` backs up first, old run readable).

**Tests first (TDD)**

- each of the five checks has a failing fixture (a planted breaking change) and a passing one
- migration fixtures readable after migrate; incompatible version never deletes a run

**Done when**

```sh
pnpm --reporter=silent unit:check U5.07 && node scripts/schema-compat.ts
```

#### U5.08 — Integration suites: event protocol golden stream (validated with ajv), approvals, retries

- **Origin:** DESIGN §7.2 rows 'retries, approvals' + 'event protocol' (unowned in DESIGN §10) · **Size:** ~1400 lines · **Depends on:** U4.INT, U4.01
- **Read first:** DESIGN §2.3.2, §2.3.3, §4.5, §7.2 (rows 5, 6), §7.5 (AC-05), spec 17, spec 25.2
- **Owns:** `tests/integration/protocol/**`, `tests/integration/approvals/**`, `tests/integration/retries/**`, `fixtures/schema-compat/golden-stream/**`

**Deliverables**

- `protocol`: the golden NDJSON of a full fake run validates against `schemas/events.schema.json` with AJV (an independent implementation); replay from `--since-seq`; `(sequence, sub)` ordering with ephemerals, INCLUDING under 50 ms batching (no delta of message n+1 before `agent.message.completed` of message n; no `tool.progress` before its `tool.started`); the stream contains every field spec 29 bullet 5 lists (auth mode, provider, tokens, quota, model, tools, files, approvals). The recorded stream is saved as the golden for U5.07.
- `approvals`: held 'for hours' on the fake clock, `approve` with no host alive, a park checkpoint does NOT change the grant key, an approved write is applied by the host after park (the model is not asked to re-issue), a real pre-state change => `superseded` + nothing executed + a re-issue opens a new ask. `retries`: FakeScript `fail{retryable}` + fixed clock => bounded backoff, every retry visible as `retry.scheduled`, FakeLedger byte-identity.

**Tests first (TDD)**

- each bullet above is one `*.itest.ts`, composed through `createRunHost()`

**Done when**

```sh
pnpm --reporter=silent unit:check U5.08
```

#### U5.09 — Dogfood: D1-D6 on a working-tree copy of the Cohorte repository, the repo's own `.cohorte/`, side-by-side `dogfood-install`

- **Origin:** DESIGN U4.1 · **Size:** ~2000 lines · **Depends on:** U4.INT, U4.06
- **Read first:** DESIGN §6 (all), §6.4 (D1-D6 table), §5.1, §5.7, §7.5 (AC-09, AC-10, AC-11), spec 16, spec 29 bullets 9-11, ADR-0023
- **Owns:** `tests/dogfood/**`, `.cohorte/manifest.yaml`, `.cohorte/config.yaml`, `.cohorte/ownership.yaml`, `.cohorte/project.yaml`, `.cohorte/.gitignore`, `.cohorte/specs/**`, `scripts/dogfood-install.ts`, `fixtures/scripts/dogfood/**`

**Deliverables**

- The Cohorte repo's own `.cohorte/`: one surface per package, `shared` = root config with `approval: human`, `checks` + offline `provision` argv.
- `scripts/dogfood-install.ts`: packs and installs into `<HOME>/.cohorte/versions/<version>-<bundleSha8>/` SIDE BY SIDE (tests pass a throwaway HOME); `--link-deps` (the default in tests, no network) copies the staged `.publish` tree and links its `node_modules` to `apps/cli/node_modules` exactly like `build.ts --out` (PLAN F-7); without the flag it `npm install`s the tarball (network; release checklist only). The dogfood `.cohorte/config.yaml` carries loosening keys (`checks`, `provision.argv`): the tests pass `--trust-project-config`, and D1 additionally asserts that WITHOUT it a non-TTY run ends in `security/project-policy-untrusted`.
- `tests/dogfood/d1..d6.e2e.ts` on a COPY of this repository in a temp dir: because nothing is committed on this branch (PLAN F-2) a `git clone --local` would yield the V2 tree, so the helper snapshots the WORKING TREE (`git ls-files -co --exclude-standard` -> copy -> `git init` + one commit inside the temp dir; equivalent to DESIGN's `git clone --local` once commits exist). FakeRuntime, the active binary = a copy install: D1 init + `reconcile --plan` => `operations: []`, then human edit preserved / generated edit => CONFLICT; D2 a scripted implementer adds `apps/cli/src/commands/hello.ts` + test, provisioning from the lockfile, the repo's REAL vitest in `_integration`, review finds a seeded flaw, fixer fixes, clean => COMPLETED, main checkout digest unchanged; D3 prompt/config/asset overwritten mid-run => pinned hashes still served; D4 byte appended to the install's `agent-host.mjs` => BLOCKED, resume refused, restore => continues, version B side by side pins B; D5 N -> N+1 state migration stays readable; D6 five unauthorised writes to the active runtime/state => five `tool.denied{overridable:false}`, zero bytes changed, and the host refuses to start from inside the repo.

**Tests first (TDD)**

- D1-D6, one file each, named by id

**Done when**

```sh
pnpm --reporter=silent unit:check U5.09
```

#### U5.INT — Gate G5 — integrate Wave 5: all hardening suites green on the gate build

- **Origin:** DESIGN gate G3 · **Size:** integration fixes · **Depends on:** U5.01, U5.02, U5.03, U5.04, U5.05, U5.06, U5.07, U5.08, U5.09
- **Read first:** DESIGN §10.1, §7.6; docs/v3/requests/*.md filed during the wave
- **Owns:** *all structural paths (§3 rule 2)*, `docs/v3/gates/G5.md`

**Deliverables**

- Requests applied; product fixes found by the hardening units landed (each listed in `docs/v3/gates/G5.md` with the test id that found it); root scripts `test:crash`, `test:security`, `test:dogfood`, `test:packaging`, `ci:<job>` added so that local == CI.
- `.build/gate-5/`; the WHOLE e2e project (e2e, security, crash, dogfood, packaging) green against it; `schema-compat` green; rollback checkpoint.

**Tests first (TDD)**

- the full e2e project is the gate

**Done when**

```sh
pnpm --reporter=silent verify && node scripts/check-prompts.ts && node scripts/build.ts --out .build/gate-5 && node scripts/pack-check.ts .build/gate-5 && COHORTE_E2E_BUILD_DIR=.build/gate-5 pnpm exec vitest run --project e2e && node scripts/schema-compat.ts && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G5
```

### W6 — Definition of done: acceptance suite, docs, live smoke runbook, CI workflows, release gate

**Mode:** parallel — all units at once, then the integrator alone.

**Goal.** Close V3.0: one executable check per spec-29 V3.0 bullet, the V3 documentation (protocol reference generated from the catalogue, error codes, exit codes, security model, ADR refresh, README/CHANGELOG), the opt-in live smoke + runbook, the complete CI of DESIGN 7.6 with `publish.yml` kept under its filename and environment, and the release checklist that ends with the human-operated real Cohorte-on-Cohorte run.

**Green state at the gate.** `pnpm ci:local` runs every CI job's command locally and is green; AC-01..AC-12 pass; docs build; the only remaining items are human-operated and budgeted: the live smoke and the real dogfood run with the maintainer's Codex subscription.

**Exit check.**

```sh
pnpm --reporter=silent ci:local && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G6
```

| Unit | Title | Depends on | Size |
|---|---|---|---|
| U6.01 | Acceptance suite: AC-01..AC-12, one executable check per spec-29 V3.0 bullet, incl. the schema-only François client | U5.INT | ~1800 lines |
| U6.02 | Documentation: generated protocol reference, error-code + exit-code tables, security model, operations, ADR refresh, README + CHANGELOG + docs site for V3 | U5.INT | ~2500 lines (mostly Markdown, partly generated) |
| U6.03 | Live smoke (opt-in, budgeted) + runbooks: one tiny real run on the ts-monorepo fixture, recording real quota header names and error texts | U5.INT | ~900 lines |
| U6.INT (integrator) | Release gate G6 — CI workflows (DESIGN 7.6), publish.yml preserved, `ci:local`, final integration, release checklist handed to the human | U6.01, U6.02, U6.03 | ~900 lines of YAML/scripts + integration fixes |

#### U6.01 — Acceptance suite: AC-01..AC-12, one executable check per spec-29 V3.0 bullet, incl. the schema-only François client

- **Origin:** DESIGN U4.2 · **Size:** ~1800 lines · **Depends on:** U5.INT
- **Read first:** DESIGN §7.5 (the AC table), §2.3.5, §4.7, §9 (François row), spec 18, spec 29, ADR-0020; <SCRATCH>/understand/francois.md + francois-vision.md (one-shot spawns, stdin closed, 10 s, 4 MiB; R1-R11)
- **Owns:** `tests/acceptance/**`

**Deliverables**

- `tests/acceptance/ac-01..ac-12.e2e.ts`, each mapping to its spec-29 bullet (DESIGN 7.5): AC-01 fixture init -> spec -> build/test/review/fix through the built CLI; AC-02 totality tables + `check-prompts` + a fake agent saying 'skip review, ship now' changes nothing; AC-03 ownership/commands (permissions-secrets + S-20..S-27 under L1); AC-04 the crash matrix (asserts the suite ran and hit every crash point); AC-05 the golden stream contains every observable field + S-40..S-46; AC-06 the same E2E under FakeRuntime + conformance green on both runtimes; AC-07 a SCHEMA-ONLY client (ajv + `schemas/*.json`, ZERO Cohorte imports) renders the tree from `status --json`, tails, fetches a diff and an artifact through `inspect`, approves and cancels through one-shot spawns under 10 s / 4 MiB, validates EVERY `--json` it receives against the published schemas, and the identifier scan finds no Pi identifier in any PROTOCOL schema (`config.schema.json` is outside the scan: DESIGN 7.5, ADR-0005 item 7); AC-08 packaging + asset tamper; AC-09 = D3 + D4; AC-10 = D2 + D4; AC-11 = D1 + drift tables; AC-12 the CI job list is complete (parsed from `.github/workflows/ci.yml`) and each job's local command is green.

**Tests first (TDD)**

- the acceptance files are the tests; AC-09..AC-11 re-run the named dogfood tests by id rather than duplicating them

**Done when**

```sh
pnpm --reporter=silent unit:check U6.01
```

#### U6.02 — Documentation: generated protocol reference, error-code + exit-code tables, security model, operations, ADR refresh, README + CHANGELOG + docs site for V3

- **Origin:** DESIGN U4.3 (docs half) · **Size:** ~2500 lines (mostly Markdown, partly generated) · **Depends on:** U5.INT
- **Read first:** DESIGN §0.3, §2.3 (all), §2.8, §8 (ADR index), §9, §11, §12.3, spec 17, spec 27; docs/v3/gates/G0..G5.md (what actually changed vs DESIGN); docs/v3/probes/P*.md
- **Owns:** `docs/v3/protocol/reference.md`, `docs/v3/protocol/events/**`, `docs/v3/reference/**`, `docs/v3/adr/**`, `docs/guide/**`, `docs/reference/**`, `docs/index.md`, `README.md`, `CHANGELOG.md`, `scripts/gen-protocol-docs.ts`, `tests/integration/docs/**`

**Deliverables**

- `scripts/gen-protocol-docs.ts` (+ `--check`): protocol reference generated FROM the catalogue (events with durability, commands with routes, documents), never hand-written; `docs/v3/reference/{error-codes,exit-codes,cli,security-model,operations,configuration}.md`; the L0/L1 trust-boundary statement verbatim from DESIGN 0.3. `security-model.md` covers the three identities (DESIGN 2.6.7), the project-config trust classes and the first-run prompt (2.10.1, ADR-0026), and the deny-default L1 profiles with their escape tests; `configuration.md` marks every key with its trust class; the deviations D-23..D-26 are listed.
- ADR refresh (`docs/v3/adr/**`) from the gate reports and probe verdicts (every provisional decision stays marked provisional); README for V3 (install, quick start with the fake runtime, subscription-first auth, what V2 users must know: `legacy/v2`, no importer in 3.0), CHANGELOG `3.0.0` entry; the VitePress site (`docs/guide`, `docs/reference`, `docs/index.md`) updated — the brand `assets/` links keep working.

**Tests first (TDD)**

- `tests/integration/docs/*.itest.ts`: `gen-protocol-docs --check` is fresh; every error code of the catalogue is documented; every CLI verb of the registry is documented; no dead relative link under `docs/v3`

**Done when**

```sh
pnpm --reporter=silent unit:check U6.02 && node scripts/gen-protocol-docs.ts --check && npm --prefix docs ci && npm --prefix docs run build
```

#### U6.03 — Live smoke (opt-in, budgeted) + runbooks: one tiny real run on the ts-monorepo fixture, recording real quota header names and error texts

- **Origin:** DESIGN U4.4 · **Size:** ~900 lines · **Depends on:** U5.INT
- **Read first:** DESIGN §3.8 (observability limit), §6.4 (last paragraph), §7.0 (live project), §7.6 (live-provider job), §12.2 (A-6, A-7), §12.3 (#7), spec 25 'tests live séparés, opt-in et budgetés'; SAFETY: this is the ONLY unit whose code may touch a real login, and only when a HUMAN runs it with COHORTE_LIVE=1. The agent building it never runs it live, never reads ~/.pi/agent/auth.json, ~/.codex or any credential file.
- **Owns:** `tests/live/**`, `docs/v3/runbooks/**`

**Deliverables**

- `tests/live/*.live.ts` behind `COHORTE_LIVE=1` with a HARD token cap: real login check through `auth status` (no token read), one tiny frozen spec on `ts-monorepo` with `--runtime pi`, recording the real quota header NAMES and error TEXTS as fixtures for the classifier (A-7) and the `constrainedSampling` degradation (A-6); without the env var every test skips with a reason.
- `docs/v3/runbooks/live.md` (how a human runs it, the budget, what to commit back as fixtures) and `docs/v3/runbooks/release.md` (the release checklist ending with the REAL Cohorte-on-Cohorte run: `--runtime pi`, the maintainer's Codex subscription, a small frozen spec such as `cohorte version --json`, human review of the integration branch).

**Tests first (TDD)**

- `vitest list -c vitest.live.config.ts` finds the files; with `COHORTE_LIVE` unset the run exits 0 with every test skipped and a printed reason

**Done when**

```sh
pnpm exec vitest list -c vitest.live.config.ts && pnpm --reporter=silent test:live
```

#### U6.INT — Release gate G6 — CI workflows (DESIGN 7.6), publish.yml preserved, `ci:local`, final integration, release checklist handed to the human

- **Origin:** DESIGN U4.3 (CI half) + gate G4 · **Size:** ~900 lines of YAML/scripts + integration fixes · **Depends on:** U6.01, U6.02, U6.03
- **Read first:** DESIGN §1.4 (step 6: publish.yml filename + environment), §7.6 (every job), §10.1, §12.3; <SCRATCH>/understand/v2-profile-tests-ci.md (OIDC trusted publishing is bound to the workflow FILENAME `publish.yml` and the ENVIRONMENT `npm-publish`); docs/v3/probes/P3.md (the documented userns remediation the ubuntu security job applies)
- **Owns:** *all structural paths (§3 rule 2)*, `scripts/ci-local.ts`, `docs/v3/gates/G6.md`

**Deliverables**

- `.github/workflows/ci.yml`: `lint`, `typecheck` (`tsc -b` AND `tsc -p tsconfig.tests.json`), `unit` / `integration` (matrix Node 24.16.0, 24.x, 26.x x ubuntu, macos), `schema-compat`, `security` (ubuntu installs `bubblewrap` + applies the P3 remediation; macOS runs the Seatbelt cases; degradations asserted through `doctor --json`), `migrations`, `packaging`, `e2e-fake`, `crash-matrix` (sharded, every PR), `dogfood`, `acceptance`, `legacy-v2`; scheduled `pi-latest` (`tsc -p tsconfig.tests.json` — what makes `type-proof.ts` fail on an API change — + tripwires + conformance against Pi `latest`, early warning only); manual `live-provider` (`workflow_dispatch`). Every job body is ONE `pnpm ci:<job>` script so that `pnpm ci:local` (`scripts/ci-local.ts`) runs exactly what CI runs.
- `publish.yml` REWRITTEN IN PLACE for V3 (publishes from `apps/cli/.publish`, `--provenance`), keeping its FILENAME and the `npm-publish` ENVIRONMENT, now depending on `ci` through `workflow_call`; `docs.yml` and `discord-releases.yml` unchanged. WARNING recorded in G6.md: until this unit lands, merging the branch to `main` would break the V2-shaped `publish.yml`.
- Final integration: requests applied, `pnpm ci:local` green, rollback checkpoint G6, `docs/v3/gates/G6.md` = release readiness report + the human decisions of DESIGN 12.3 still open.

**Tests first (TDD)**

- AC-12 (from U6.01) parses `ci.yml` and checks the job list is complete and each job maps to a `ci:<job>` script

**Done when**

```sh
pnpm --reporter=silent ci:local && COHORTE_CHECKPOINT_DIR="${COHORTE_CHECKPOINT_DIR:?set an absolute dir outside the repository}" node scripts/checkpoint.ts G6
```

## 8. Traceability

### 8.1 The delivery judge's must-fix list -> where this plan answers it

| # | Must-fix | Answer |
|---|---|---|
| 1 | Drop `isolatedDeclarations` | `U0.01` `tsconfig.base.json` (`isolatedDeclarations: false`, ADR-0016); `tsc -b` stays declaration-only |
| 2 | Freeze in W0 everything two units build against | complete runtime conformance suite + host-protocol frames `U0.03`; DDL + complete store suite + `MemoryStateStore` `U0.06`; tool catalogue + internal ports + factory signatures `U0.08`; reference reducer + tables `U0.09`; rule 7: no later unit edits a W0 contract file |
| 3 | Eliminate intra-wave dependencies | validated mechanically: in a parallel wave only the integrator depends on same-wave units. Engine no longer needs SQLite or `reduce` from a sibling (kernel + memory store in W0; SQLite re-run at G1); Pi child (`U4.08`) comes after the parent (`U1.07`) and the fake HTTP provider (`U2.10`); commands vs host decoupled by the W0 `CliContext` (`U0.10`); `doctor` lives in `U4.05`, `auth` in `U5.05`; `GIT_ENV`, temp-repo, `FixedClock`, `SeqIds`, `FaultInjector`, `MemoryStateStore` are all W0 |
| 4 | Every "hand" has an owner | tool catalogue `U0.08`, implementations `U2.03` + `U2.04`; filesystem / artifact / snapshot adapters for a core that may not import `node:fs`: `U3.02` (+ port table in `U0.08`); worktree dependency provisioning `U3.04`; CLI verb registry pre-registered in `U0.10` |
| 5 | Shared build outputs are a hazard | rule 6; `build.ts` refuses the shared `dist`; immutable `.build/gate-<n>`; private build dirs (`U5.06`); no unit check contains `pnpm build` |
| 6 | Per-unit typecheck isolation | `tsconfig.checks/<unit>.json` generated from `plan.json` + foreign-diagnostic downgrade in `unit-check` + contract AND per-area subpath exports so nobody imports a barrel with an active unit (`U0.01`, rules 4-5) |
| 7 | Test discovery defined once and verified | `U0.01`: suffix-based `projects`, canary per root, self-test reproducing the judge's two failing invocations, exclusions for `legacy/ .cohorte/ .build/` |
| 8 | Ownership of `schemas/` after W0 | integrators only (rule 2); units authoring TypeBox never touch `schemas/*.json`; freshness = `gen-schemas --check` without git (F-2), run at gates and in CI |
| 9 | Wave-gate checkpoint compatible with "never commit" | `scripts/checkpoint.ts` at every gate (rule 8); legacy move + workflows scripted in `U0.01`; `publish.yml` handled in `U6.INT` (F-5) |
| 10 | Start from the spike-executed Node IPC channel; concurrency default 3-4 | `U0.03` (transport-agnostic frames), `U1.07` (IPC first, fd 3/4 alternate), `U4.08` (`runRpcMode` fallback); `budgets.concurrency = 3` (`U0.07` defaults, `U3.03`) |
| 11 | Scope discipline | the plan builds exactly DESIGN §9 "In V3.0"; DESIGN (written after the judgement) keeps L1 and HMAC in V3.0 — here they are leaf units off the critical path (`U4.07`, `U2.02`), `native` is never on the default Linux/CI path before P3 ran (F-3); the "deliberately not built" list of DESIGN §9 has no unit |
| 12 | Size the critical path; split the monoliths; Pi off the critical path; packaging in W0 | monolith splits in §9; Pi units are leaves; packaging path proven by `U0.10` and re-proven at every gate. W0 is serial BY CONSTRAINT of this run (PC-5): ten small units instead of two steps |
| 13 | Toolchain hygiene | `typebox 1.3.7` exact via catalog + overrides, no `tsx`, per-entry `onlyImport` asserted by `pack-check` (`U0.01`, `U0.10`) |
| 14 | One home for shared vocabulary before W0 starts | `packages/protocol/src/vocabulary.ts` (`U0.04`) for pipeline vocabulary; `@cohorte/base` for ids, errors, usage, model refs (`U0.02`); `protocol` never imports `core`, `persistence` never imports `core` |

### 8.2 Spec 25 -> units

| Spec 25 item | Units |
|---|---|
| 25.1 state transitions, guards | `U0.09`, `U2.05` · policy engine, ownership `U1.02`, `U1.03`, `U2.01`, `U2.06` · budgets, routing `U2.06`, `U3.10` · context manifests `U3.01` · schemas `U0.04`, `U0.05`, `U0.07` · redaction `U2.02` · idempotency keys `U0.06`, `U1.08` · Git path handling `U1.02`, `U1.05` · migrations `U1.01`, `U5.07` · drift classification `U3.09` |
| 25.2 fake runtime + fake provider: spawn, streaming, tool interception, pause/resume | `U0.03` (suite), `U1.06`, `U1.07`, `U4.08` · retries, approvals `U2.08`, `U3.03`, `U5.08` · event protocol `U5.08` · SQLite `U1.01` · worktrees `U1.05`, `U3.04` · reconciliation `U3.09` |
| 25.3 TypeScript monorepo | `U4.06` · frontend/backend `U4.06` (fixture) + `U5.03` · unknown project `U5.03` · permissions and secrets `U5.02` · crash at every transition `U5.01` · provider timeout / rate limit `U5.03` · review finds then fixes a flaw `U4.06`, `U5.03` · concurrent run `U5.03` · dogfooding `U5.09` |
| "La CI MUST" | `U6.INT` (jobs), each job's content owned by the unit above; live provider tests separate, opt-in, budgeted: `U6.03` |

### 8.3 Spec 29 (V3.0 bullets) -> acceptance check -> evidence units

| Spec 29 bullet | Check (`U6.01`) | Evidence built by |
|---|---|---|
| fixture init -> spec -> build/test/review/fix without manual orchestration | AC-01 | `U4.06`, `U4.INT` |
| workflow and stops decided by TypeScript, not a prompt | AC-02 | `U0.09`, `U2.05`, `U4.09` |
| no write outside ownership, no refused command | AC-03 | `U1.02`, `U1.03`, `U2.01`, `U2.04`, `U3.07`, `U4.07`, `U5.02` |
| interrupted run resumes without a dangerous duplicate | AC-04 | `U1.08`, `U1.10`, `U5.01` |
| subscription mode, provider, tokens, quotas, model, tools, files, approvals observable; no API billing without activation | AC-05 | `U0.05`, `U3.03`, `U3.10`, `U4.08`, `U5.08` |
| Pi replaceable by a fake runtime | AC-06 | `U0.03`, `U1.06`, `U4.08`, `U5.04` |
| François can display and control through the protocol without knowing Pi | AC-07 | `U0.04`, `U0.05`, `U4.02`, `U4.04` |
| prompts, schemas and code packaged and hashed | AC-08 | `U0.10`, `U5.06` |
| an update does not change an active run | AC-09 | `U3.02`, `U4.01`, `U5.09` (D3, D4) |
| Cohorte modifies Cohorte in a worktree, new code only at the next run | AC-10 | `U5.09` (D2, D4) + the human-operated real run (`U6.03` runbook) |
| `reconcile --plan` detects drift, destroys no human override | AC-11 | `U3.09`, `U5.09` (D1) |
| unit, integration, E2E, security and migration tests pass in CI | AC-12 | `U6.INT` |

### 8.4 Design-critique findings -> where this plan answers them

| # | Finding (severity) | DESIGN | Delivered by |
|---|---|---|---|
| C1 | package graph cannot host the contracts: `config <-> security` cycle, `security -> protocol`, `tools -> persistence`, missing `typebox` (blocker) | 1.1, 1.2, 2.1, 2.6.7, 2.7, 6.1 | `U0.01` (edges + `resolve-edges` test), `U0.02` (`BudgetCounters`), `U0.07` (`GlobMatcher`, canonical-body authenticator), `U0.08` (`RunSnapshotManifest` in core) |
| C2 | G0 red by construction: Pi identifiers in `schemas/config.schema.json` (blocker) | 7.5 AC-07, ADR-0005 #7 | `U0.05`, `U0.G`, `U6.01`: the identifier scan covers the PROTOCOL schemas only |
| C3 | gate builds cannot resolve bare externals (blocker) | 1.4 step 7, 3.9 | `U0.10` (`build.ts --out` link + offline self-run), `U1.07` (`pin()` skips `install-lock`), `U2.10` (`runCli`), `U5.09` (`dogfood-install --link-deps`) |
| C4 | `refreshOnCreate:false` leaves the auth snapshot empty: every spawn would end AUTH_REQUIRED (major) | 3.4, 3.7 layer 3, ADR-0015 | `U4.08` (+ tripwire `tw-auth-snapshot`) |
| C5 | classifier: `ModelsError` `auth`/`oauth` are not discriminators; `instanceof` impossible in the Pi-free area (major) | 3.3 `ErrorSignal`, 3.8 | `U0.03` (frame shape), `U1.07` (pure table), `U4.08` (`signalOf`, tripwire `tw-credential-lock`) |
| C6 | `streamFunction` wrapper violates the StreamFn no-throw contract (major) | 3.4, 3.5 | `U4.08` (`lazyStream`, tripwire `tw-stream-contract`) |
| C7 | macOS injects `__CF_USER_TEXT_ENCODING`: exact env allowlist refuses every spawn (major) | 2.6.6, 3.7 layer 1 | `U0.07` (`OS_INJECTED_ENV`), `U0.03` (`diffAttestation`), `U1.04` (S-20), `U1.07` |
| C8 | `start` not expressible atomically; NOT NULL columns only the host can compute (major) | 2.4, 4.3 #1/#3, 4.7 | `U0.06` (`StoreTx.enqueueCommand`, nullable columns, conformance case), `U1.01`, `U4.02` |
| C9 | no protocol target for several durable runtime events (major) | 2.3.3 mapping table | `U0.05` (`tool.rejected`, `agent.message.accepted`, `runtime.warning`), `U0.08` (mapping table as frozen data), `U3.03` |
| C10 | spec-17.2 commands without a verb; `--json` outputs without a schema (major) | 2.3.4, 2.3.5, D-23 | `U0.04`, `U0.05` (documents), `U0.10` (verbs + JSON output map), `U0.G`, `U4.02`, `U4.03`, `U4.04` |
| C11 | no lifecycle edge for a reincarnation that is not a retry (major) | 2.5.4 | `U0.09`, `U2.06`, `U1.10`, `U3.03` |
| C12 | approvals: park checkpoint breaks the command grant key; liveness depends on the model re-issuing (major) | 4.5, 2.5 (`ToolHostReplay`), ADR-0025 | `U0.08` (ports), `U2.07`, `U2.08`, `U3.03`, `U5.08` |
| C13 | table totality: environmental TEST failure has no exit; `skip` has no entry effects (major) | 2.3.1, 2.5.1 T16/T33, 2.5.3 | `U0.04`, `U0.09`, `U2.05`, `U3.05`, `U3.07` |
| C14 | tests are typechecked only during their own wave (major) | 1.2, 7.0, 7.6 | `U0.01` (`tsconfig.tests.json`), `U6.INT` |
| C15 | `search` / `git_diff` bypass `denyRead` (major) | 2.7 | `U2.03` (S-14, S-15), `U1.02` (`GlobMatcher`) |
| C16 | L1 executor profile weaker than claimed (major) | 0.3, 2.6.6 | `U4.07` (deny-default profiles, escape self-test, S-28/S-29), `U4.05` (doctor `partial`), `U5.02` |
| C17 | provisioning: writable `node_modules`, hardlinks into the store, scratch HOME hides the store (major) | 5.7, 2.10 `provision.*` | `U0.07` (schema), `U2.09` (validation), `U3.04` (Provisioner), `U3.05` (verify before TEST), `U4.06`, `U5.02` (S-73, S-74) |
| C18 | every security-lowering switch honoured from the repository file (major) | 2.10.1, ADR-0026, D-26 | `U0.07` (key classes, `TrustStore` port), `U2.02` (trust store), `U2.09` (resolution), `U2.05` (T04 guard), `U4.01`, `U4.03`, `U4.05` (`config trust`), `U5.02` (S-37/S-38) |
| C19 | test-only workspace edges undeclared (major) | 1.1, 1.2 | `U0.01` |
| c20 | `accountLabel` can never be populated on Pi 0.85.1 (minor) | D-24, 2.2.7, 3.9 | `U5.05` |
| c21 | retention has no owner (minor) | 5.9, ADR-0010 | `U4.05` (`gc`) |
| c22 | `U5.05` must write a doctor module it does not own (minor) | — | `U0.10` (stub), `U4.05` (excluded sub-path), `U5.05` (owned paths) |
| c23 | `SkillManifest` has no owner; skill checks undefined (minor) | 2.10, D-25, ADR-0011 | `U0.07`, `U0.G`, `U3.01`, `U4.09` |
| c24 | in-repo worktree root legal but unusable (minor) | 2.6.3, 5.1, D-10, ADR-0021 | `U1.02` (path-table case), `U2.09` (refusal) |
| c25 | child stderr written raw to `host.log` (minor) | 3.2, I7 | `U1.07`, `U5.02` (S-53) |
| c26 | provisional ADRs frozen as closed wire enums / names (minor) | 2.3.1, 2.3.3, 2.3.4, 2.4 DDL | `U0.04`, `U0.05`, `U0.06` |
| c27 | context installation unspecified (minor) | 2.2.3, rule 12, 3.3 | `U0.03`, `U1.06`, `U1.07`, `U3.01`, `U4.08` |
| c28 | observers exit 0 on FAILED (minor) | 2.8, 4.7 | `U0.10` (table), `U4.02`, `U4.03` |
| c29 | ephemeral ordering under batching (minor) | 2.3.2 | `U1.08`, `U3.03`, `U5.08` |
| c30 | `git_diff` base for reviewers; `approval_request` answer (minor) | 2.7, 2.3.4 | `U0.04`, `U0.08`, `U2.03`, `U2.04`, `U2.08` |
| c31 | terminal control characters in human-facing text (minor) | 2.3.6 | `U1.08` (summary), `U4.04` (sanitiser), `U5.02` (S-54) |
| c32 | layer 5 was an echo (minor) | 3.7 layer 5 | `U0.03` (`provider.request` frame), `U1.07`, `U4.08` (guard fetch), `U5.06` (packaging assertion) |
| c33 | quota auto-resume vs idle exit (minor) | 2.5.3 | `U4.01` |
| c34 | checks leaving artefacts break the digest binding (minor) | 2.5.2, 4.1 | `U3.05`, `U3.06` (system-checks grant) |
| c35 | separation of identities unmentioned (minor) | 2.6.7 | `U1.09` (actor normalisation), `U5.02` (S-36) |
| c36 | no W0 in-memory `RunFiles`/`BlobStore`/spool; bundle load needs a computed `import()` (minor) | 2.4, 1.2 rule g | `U0.06`, `U0.01` (rule g exemption), `U4.08` (`load-pi.ts`) |

## 9. Differences from DESIGN §10, and the unit mapping

DESIGN §10 remains the description of WHAT is built. This plan changes HOW it is cut, for four reasons: the run's constraints (sequential Wave 0, one integrator unit per wave), the ten-seat cap, zero intra-wave dependencies, and the size cap per unit.

| DESIGN §10 unit | This plan | Why split / moved |
|---|---|---|
| U0.1 scaffold + base + vocabulary | `U0.01`, `U0.02`, `U0.04` (vocabulary), `U0.10` | oversized serial unit |
| U0.A · U0.B · U0.C | `U0.03` · `U0.04` + `U0.05` + `U0.06` · `U0.07` + `U0.08` + `U0.09` | sequential W0 (PC-5); size |
| U0.P probes | `U2.10` | not a contract; shares code with the fake HTTP provider; P3 cannot run locally (F-3) |
| G0 | `U0.G` | — |
| U1.1 sqlite store | `U1.01` (store + migrations), `U3.02` (blob / files / spool, with the run snapshot that uses them) | size |
| U1.2 security/decide | `U1.02` paths, `U1.03` commands, `U2.01` gate stages + engine | ~3400 lines with the ported tables |
| U1.3 security/exec + redact + auth | `U1.04` L0 executor, `U2.02` redact + HMAC, `U4.07` L1 backends | size; L1 off the critical path |
| U1.4 git · U1.5 runtime-fake · U1.6a Pi parent | `U1.05` · `U1.06` · `U1.07` | — |
| U1.6b Pi child | `U4.08` | its conformance run needs the parent (`U1.07`) and its auth canary needs the fake HTTP provider (`U2.10`): an intra-wave dependency in DESIGN |
| U1.7 config loader + providers | `U2.09`, `U3.10` | seat cap; config is first consumed in W3 (`U3.02`, `U3.08`, `U3.09`), providers in W4 |
| U1.8 telemetry + testkit rest | `U3.10` (telemetry), `U2.10` (testkit) | seat cap |
| U1.9 core/pure | `U0.09` (kernel), `U2.05` decisions, `U2.06` accounting | PC-3; ~4500 lines |
| U1.10 core/engine (skeleton a) | `U1.08` durability, `U1.09` engine, `U1.10` resume | judged "very large" |
| U1.11 assets | `U4.09` | seat cap; first needed by the G4 build |
| G1 | `U1.INT` (now also runs FakeRuntime in the skeleton) | — |
| U2.1 tools | `U2.03`, `U2.04` | ~3300 lines |
| U2.2 toolhost + approvals | `U2.07`, `U2.08` | size |
| U2.3 context + snapshot | `U3.01`, `U3.02` | size |
| U2.4 agents + worktrees | `U3.03`, `U3.04` | size |
| U2.5 phases | `U3.05` executors, `U3.06` contracts, `U3.07` commit + merge | size |
| U2.6 project-model | `U3.08`, `U3.09` | ~3500 lines |
| U2.7 host + observers + controllers | `U4.01`, `U4.02` | size |
| U2.8 commands | `U4.03`, `U4.04`, `U4.05` | size |
| U2.9 e2e-fake | `U4.06` | same "red until the gate" semantics, stated honestly in its check |
| G2 (first spec-29-shaped green) | `U4.INT`; new intermediate gates `U2.INT`, `U3.INT` carry programmatic skeletons so integration risk is paid in three instalments, not one | — |
| U3.1 · U3.2 · U3.3 · U3.4 · U3.5 | `U5.01` · `U5.02` · `U5.03` · `U5.04` · `U5.05` | — |
| U3.6 packaging + pin + schema-compat + migrations | `U5.06`, `U5.07` | size |
| (DESIGN 7.2 rows with no owner in §10: protocol stream, approvals, retries) | `U5.08` | every suite needs an owner |
| U4.1 dogfood | `U5.09` (moved one wave earlier so acceptance can reference D1-D6 without an intra-wave dependency) | — |
| U4.2 acceptance · U4.3 docs + CI · U4.4 live smoke | `U6.01` · `U6.02` + `U6.INT` (CI: `.github/**` is structural) · `U6.03` | — |

## 10. Risks of this plan, and decisions that need the human

| # | Risk | Containment |
|---|---|---|
| R1 | Wave 0 is eleven serial steps: a slow unit delays everything | units are small and their checks whole-tree; `dependsOn` edges allow `U0.03 ∥ U0.04` and `U0.06 ∥ U0.07` if the orchestrator is later allowed to parallelise W0; the two largest (`U0.06`, `U0.07`) say which half to do first |
| R2 | A wrong Wave-0 contract stalls ten units | contracts are near-final in DESIGN §2; complete conformance suites + `MemoryStateStore` + echo runtime prove them in W0; rule 7 request path; three programmatic skeleton gates (G1-G3) find contract bugs before the CLI exists |
| R3 | Integrators G3 and G4 carry the heaviest integration | G3 composes the core in a test file that `U4.01` then turns into `createRunHost()`; G4 starts from E2E tests already written by `U4.06`; both gates list every cross-unit patch in their report |
| R4 | Ten agents on one machine: CPU/RAM contention, flaky timing tests | `unit-check` caps vitest at 2 workers; at most 2 Pi children; time-dependent logic runs on `FixedClock`; W5's heavy suites (`U5.01`, `U5.02`, `U5.09`) are sharded and may be scheduled in two halves |
| R5 | E2E provisioning of the pnpm fixture needs an offline store — and the L0 env's scratch `HOME` hides it | `U4.06` generates the fixture lockfile against versions already in the store and its harness writes the throwaway HOME's `~/.cohorte/config.yaml` with `provision.cacheDirs` = the machine's real store path (so the Provisioner sets `npm_config_store_dir`, DESIGN 5.7); CI primes the store with the root install. Fixture configs carry loosening keys (`checks`, `provision.argv`): the E2E harness passes `--trust-project-config` |
| R9 | The deny-default L1 profile breaks a real toolchain on some machine | DESIGN A-9: the `security` job runs the fixture's real checks under L1 on both OSes; `best-effort` still uses the partial backend; every widening of the golden profile is reviewed |
| R6 | vitest 5.0.x is two weeks old | fallback pin 4.1.11 is an integrator decision (lockfile) recorded in the gate report; the APIs used (`projects`, `test.extend`, `test.for`) are the verified ones |
| R7 | P3 (Linux sandbox) stays unexecuted until CI exists | pre-agreed fallback is the default (F-3); `U6.INT` makes the ubuntu `security` job the first executor of P3 |
| R8 | `publish.yml` would break `main` if the branch merged early | F-5: no merge before G6 |

**Decisions for the human (none blocks Wave 0):**

- **H1** Install ripgrep on this machine and in CI (`brew install ripgrep` / `apt-get install ripgrep`), or accept the `git grep` fallback as the default search backend (F-1).
- **H2** Rollback checkpoints between waves: scratchpad patch + tarball (default, set `COHORTE_CHECKPOINT_DIR`) or lead-only commits on `feat/v3-rewrite` (DESIGN 12.3 #6).
- **H3** The five product decisions of DESIGN 12.3 #1-#5 (Node floor, default `sandbox.require: native`, Anthropic-via-Pi metered opt-in, no runtime-adopt flag, external worktree root) — the plan implements DESIGN's provisional choice for each.
- **H4** The live smoke and the real Cohorte-on-Cohorte run (`U6.03` runbooks) spend the maintainer's ChatGPT subscription quota; both are opt-in release gates operated by a human.
- **H5** Whether W0 may run `U0.03 ∥ U0.04` and `U0.06 ∥ U0.07` in parallel (saves two serial steps; paths are disjoint, but both checks call the whole-tree `tsc -b`, so the two checks of a pair must still run one after the other).
