# Cohorte V3.0 — Design of record

**Status:** design of record for the V3.0 milestone (SPEC §28) · **Date:** 2026-09-18 · **Normative input:** `docs/v3/SPEC.md`
**Decisions:** every decision that the spec leaves open is PROVISIONAL and recorded as an ADR under `docs/v3/adr/` (index in §8).
**Revision 2 (same day):** amended after the adversarial design critique — 3 blockers, 16 majors, 17 minors, all applied. §12.4 records the six
that were applied with a different mechanism than proposed; `PLAN.md` §8.4 maps every finding to the units that deliver its fix; ADR-0026 is new.
**Conventions in this document:** "spec N" = section N of `SPEC.md`; R1-R11 = François requirements (francois-vision); F1-F7 / D1-D10 = facts and
provisional decisions of the lead's brief; **[85]** = read in the published `@earendil-works/*` 0.85.1 packages; **[X]** = executed against 0.85.1
(delta reports and the two spikes); **[A-n]** = an assumption still to be pinned by a named test (§12.2). MUST / SHOULD / MAY as in the spec.

This design takes the *contract-first* proposal as its spine (two public frontiers, host-delegated tools, conformance suites), grafts the
*security-durability-first* control-plane and git hardening, and the *dogfood-mvp-first* delivery order (packaging and two walking skeletons first,
recorded crash points, content-addressed pin). Every Pi statement below is aligned with 0.85.1 evidence; where a proposal was wrong
(`streamFn`, `readStoredCredential`, `onResponse` on non-2xx, Anthropic accounting, `isolatedDeclarations`) the corrected fact is stated inline.

---

## 0. Thesis, invariants, trust boundary

### 0.1 Thesis

Cohorte V3 has two public frontiers (spec 32): `AgentRuntime` (towards Pi) and the Cohorte Protocol (towards François). Five rules follow.

| # | Rule | Consequence |
|---|---|---|
| C1 | **A runtime is a brain, never hands.** The `AgentRuntime` contract gives a runtime tool *descriptions* and a `ToolHost`; it never gives it an executor. | The spec-9 gate chain, the isolated executor, approvals, idempotency and audit exist once, in the run host, and are exercised identically by `PiRuntime` and `FakeRuntime`. Pi's unconfined built-ins (F2) are not wrapped: they do not exist in the child. |
| C2 | **Three contracts.** Public: `runtime-contract`, `protocol`. Private but versioned: `AgentHostProtocol` between the `runtime-pi` parent and its per-agent child. | Pi types live in one directory (`packages/runtime-pi/src/child/**`). A Pi break is absorbed in the child; a transport change is absorbed behind the host protocol. |
| C3 | **TypeBox is the only place a wire shape is written.** `schemas/*.json` are generated and committed; writers validate with a *strict* compile; published schemas are *open*. | Forward compatibility is a property of the generator, checked by the `schema-compat` CI job. |
| C4 | **`protocol` and `runtime-contract` do not import each other.** Shared vocabulary lives in the leaf `@cohorte/base`; agent-level events are declared twice ("Pi-shaped, not Pi-typed"); one total mapper in `core` joins them. | R10 holds by construction; the two frontiers version independently. |
| C5 | **Durable vs ephemeral is part of the type** (D7). The store only ever sees durable, *sealed* events. | Replay, resume and crash tests are defined over durable events only; streaming volume can never threaten the store. |

### 0.2 Invariants (each has an enforcement mechanism and a test id; ids are referenced throughout)

| Id | Invariant | Enforced by | Proved by |
|---|---|---|---|
| I1 | The only code path that touches a worktree, spawns a process for an agent, or runs git for an agent is `ToolHost.handleToolCall()` in the run host — and its sibling `ToolHostReplay.replayApproved()`, which enters the **same** chain at stage 1 for an approved call whose requester is gone (4.5) | `RuntimeCapabilities.toolExecution: 'host-delegated'` literal; `RuntimeHostBindings` contains no executor; child registers forwarding tools only | runtime conformance suite on FakeRuntime and PiRuntime; S-60 |
| I2 | Fail closed: missing/invalid policy, unknown tool, schema mismatch, gate exception, unverifiable digest ⇒ nothing executes | gate default branch is `deny`; configuration errors abort before any spawn | V2 cases C1-C4 inverted (§7.4) |
| I3 | No model-influenced text ever reaches a shell. `run_command` is `argv[]` executed with `shell:false`; the only shell use in the product is the constant `ulimit` wrapper of the L0 executor whose script is a compile-time constant and whose arguments are positional | `Executor` has no string form; `CommandRequest` has no `script` field | EV-01..EV-15 |
| I4 | Gate inputs (policy, ownership, grants, approvals, check results) are never read from an agent-writable location — and the repository's own config cannot *loosen* them without the local user's consent (2.10.1) | policy = hashed snapshot in host memory + CAS; `.cohorte/**`, `.git`, `.pi/**` are protected classes; state DB, keys and trust records are outside every write root; provisioned dependencies are read-only for agent code (5.7) | EV-14/15, S-10, S-37/S-38, S-73 |
| I5 | Events first, then effects: an effect without a committed `intent` row cannot start | `EffectJournal.run()` is the only caller of `Executor`, `GitPort` mutators and `AgentRuntime.spawn` | crash matrix (§7.3) |
| I6 | One writer per run, fenced | run lease with a monotonically increasing fencing token asserted as the first statement of every write transaction | S-34 |
| I7 | Nothing unredacted is persisted, logged or sent to a model | `Sealed<T>` brand minted only by `Redactor`; `StoreTx.appendEvents`, the logger and `RuntimeToolResult` accept only sealed values; a runtime child's stdout/stderr are pipes sealed line by line by the parent, never a raw file (3.2) | type-level test (kept live by `tsconfig.tests.json`) + S-50..S-54 |
| I8 | Subscription mode can never become API billing silently; a metered leg is never accounted as `not_applicable` | §3.7 (six layers) | S-40..S-46 |
| I9 | The runtime of an active run is immutable | `RuntimePin` + snapshot captured at run start, re-verified before every spawn and at resume; host refuses to run from inside the target repo | §6.4 |
| I10 | The LLM never decides a phase, a stop, a retry, an escalation or a verdict | versioned transition tables + pure loop controller; verdict computed from findings; `scripts/check-prompts.ts` | unit tables (§7.1) |
| I11 | Ownership is enforced twice: at tool time (canonical path) and at commit/merge time (diff audit) | `PathResolver` + `CommitService.auditOwnership` | S-13, e2e `permissions-secrets` |
| I12 | A client can die, be SIGKILLed or never exist without affecting a run | detached run host; observers are pure readers; control = MAC-authenticated idempotent commands in a durable inbox | S-35 |

### 0.3 Trust boundary of the control plane (stated, not implied)

Cohorte runs as the invoking user. What an *allowlisted command* (for instance `pnpm test` executing an agent-written test) can reach depends on the
sandbox level, and the design says so everywhere it matters (`doctor`, `RunPlan.sandbox`, `pipeline.started`, every `tool.started`).

| | L0 (process hygiene only) | L1 (OS sandbox: Seatbelt / bubblewrap) |
|---|---|---|
| Filesystem outside the worktree | **reachable as the user** (advisory gate only) | write denied outside the worktree; read denied for the `denyRead` set; the slot's `node_modules` is read-only for agent commands and checks (5.7) |
| `.cohorte/state/cohorte.db`, `~/.cohorte/keys/*`, Pi `auth.json`, `~/.ssh` … | **readable and writable** ⇒ an allowed command can forge an inbox command or steal the OAuth token | denied (in `denyRead`, outside every write root) |
| Network | **reachable** ⇒ exfiltration possible | none: no network allow in a `(deny default)` profile / `--unshare-net`, **and no host Unix socket** (`--tmpfs /run`, private `XDG_RUNTIME_DIR`: docker, D-Bus, ssh-agent, gpg-agent sockets are unreachable) |
| Escape through another process (`open`, `osascript`, LaunchServices, AppleEvents, `systemd-run`), signalling the run host | **possible** | denied: `lsopen`, `appleevent-send`, job creation and `signal (target others)` are denied; minimal `mach-lookup` list (2.6.6) |
| What Cohorte still guarantees | out-of-ownership writes cannot be *integrated* (I11); commands flagged `network` are denied; every call is audited | spec 9 sandbox MUSTs and spec 29 bullet 3 hold for commands **on a platform where the escape tests S-28 (macOS) / S-29 (Linux) pass; until they do, `doctor` and `SandboxCapabilities` report filesystem and network as `partial`, never `enforced`** |

Therefore: **`sandbox.require` defaults to `native` whenever the runtime is a real model runtime and any role holds `run_command`**; `best-effort`
is an explicit opt-in **of the local user** recorded in the run plan (and the default only for the deterministic fake runtime): it is honoured
from the user-scope config, a CLI flag or a recorded trust grant, **never from the repository's own `.cohorte/config.yaml` alone** (2.10.1,
ADR-0026). Command MACs and the hash chain authenticate the control plane against anything that cannot read `~/.cohorte/keys`; under L0 that is
*not* true of an allowed command, and `doctor` prints exactly that sentence (ADR-0003, ADR-0022).

### 0.4 Headline decisions

| Topic | Decision | § / ADR |
|---|---|---|
| Pi | `@earendil-works/pi-coding-agent` **0.85.1 exact**, imported only under `packages/runtime-pi/src/child/**` | 3, ADR-0001 |
| Embedding | **Candidate C, SDK-in-child**: one Cohorte-owned child per `(agentId, incarnation)`, forwarding tools only, Cohorte-owned IPC on the Node `'ipc'` channel; `runRpcMode` host = pre-validated fallback inside `runtime-pi` | 3.1 |
| Provider | `openai-codex` via Pi OAuth (subscription). Anthropic-via-Pi = explicit opt-in, **accounted as metered** | 3.7, ADR-0005 |
| Store | `node:sqlite` behind an async `StateStore` with synchronous transaction bodies; `MemoryStateStore` as second implementation | 2.4, ADR-0002 |
| Transport | NDJSON only; detached run host; pure-reader observers; MAC-authenticated command inbox | 4.7, ADR-0004, ADR-0022 |
| Sandbox | L0 always; L1 (Seatbelt + bubblewrap, in-house) **in V3.0**; default `native` for model runtimes | 2.6.6, ADR-0003 |
| Commands | argv only, pinned-PATH realpath resolution, non-overridable trampoline deny set | 2.6.4, ADR-0024 |
| Recovery | fresh incarnation + file ledger + checkpoint commits + replay classes; approvals are pre-state-bound one-shot grants; an approved call whose requester is gone is replayed **by the host** when the binding still matches | 4, ADR-0025 |
| Project-config trust | keys that *loosen* security take effect only with the local user's consent (user config, CLI flag, or a trust-on-first-use grant bound to a hash); the repository file alone can only tighten | 2.10.1, ADR-0026 |
| Node floor | `"node": "^24.16.0 \|\| >=26.1.0"` (needs the human's sign-off) | 11, ADR-0017 |
| TypeScript | toolchain.md flags **except `isolatedDeclarations: false`** (verified conflict with TypeBox consts: TS9010/TS9013 on TS 7.0.2) | 11, ADR-0016 |

---

## 1. Package graph

### 1.1 Packages

All internal packages are `"private": true`, ESM-only, source-first (`"exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }`),
scope `@cohorte/*`. Only `apps/cli` is published, as `cohorte`.

| Package (path) | Responsibility | Public API (barrel) | Workspace deps · third-party |
|---|---|---|---|
| `@cohorte/base` (`packages/base`) | Leaf vocabulary shared by both frontiers: branded ids, `ErrorInfo`/`ErrorClass`, `TokenUsage`, `QuotaInfo`, **`BudgetCounters`**, `ModelRef`, `AuthMode`, `MonetaryCost`, `Redaction`, `Sealed<T>` brand + `Redactor` *interface*, `JsonValue`, canonical JSON + sha256, `Clock`/`IdSource`, `Result`. No I/O except `node:crypto`. | §2.1 | — · typebox |
| `@cohorte/runtime-contract` (`packages/runtime-contract`) | Frontier 1: `AgentRuntime`, `AgentRuntimeProvider`, `ToolHost`, `SpawnRequest` and parts, `RuntimeEvent`, `RuntimeCapabilities`, `RuntimeSnapshot`, `RuntimePin`. Subpath `./conformance`: the suite every runtime must pass. | §2.2 | base · typebox |
| `@cohorte/protocol` (`packages/protocol`) | Frontier 2: envelope, **pipeline vocabulary** (states, profiles, stop reasons, agent states, roles, severities), event catalogue with durability, commands, `RunSnapshotDocument`, `ProjectStatusDocument`, `AgentOutput`/`Finding`, NDJSON codec, strict/open schema transforms. | §2.3 | base · typebox |
| `@cohorte/config` (`packages/config`) | Schemas + loaders for `.cohorte/{manifest,config,ownership}.yaml`, spec files and `skill.yaml` (`SkillManifest`); policy *data* shapes (`CommandRule`, `SymlinkPolicy`, `NetworkPolicyConfig`, …); the **key-trust classification** (`tighten-only` / `loosen`, 2.10.1) and the `TrustStore` port; defaults; comment-preserving writes; config migrations. It imports **neither `security` nor `runtime-contract`** (that would be a project-reference cycle: `security` imports `config`), which is why `RunSnapshotManifest` lives in `core`. | §2.10 | base, protocol · typebox, yaml |
| `@cohorte/persistence` (`packages/persistence`) | `StateStore` contract, `MemoryStateStore`, `SqliteStateStore` (`node:sqlite` behind `SqlDriver`), migration runner, hash chain + MAC anchors, `BlobStore` (content-addressed), `RunFiles`, `EphemeralSpool`. Subpath `./conformance`. | §2.4 | base, protocol · — |
| `@cohorte/security` (`packages/security`) | `PolicyEngine`, the five pure gate stages, `PathResolver`, `CommandPolicy` + `ProgramProfile`s, `Redactor` implementation (the only minter of `Sealed<T>`), `Executor` + sandbox backends L0/L1, capability probe, `CommandAuthenticator` (HMAC over a canonical body handed in by the caller: no `protocol` type is named) + `KeyStore`, and **`GlobMatcher`** — the one implementation of the glob semantics of 2.6.3, consumed by `tools` and `core` through the contract so nobody configures `picomatch` a second time. `src/decide/**` is pure; `src/exec/**`, `src/auth/**` are effectful. | §2.6 | base, runtime-contract (types), config (types) · picomatch, typebox (`PolicyVerdict`, `AgentGrant`, `SandboxCapabilities` are `[S]`) |
| `@cohorte/git` (`packages/git`) | Hardened `git` runner (no shell, hooks off), worktrees, branches, `treeDigest`, commits with trailers, plumbing merge with CAS, immutable review refs, per-surface diffs, changed-path scan. | §5 | base · — |
| `@cohorte/tools` (`packages/tools`) | The tool catalogue: input/output schemas, model-facing descriptions, `ToolImplementation`s (run *after* the gate, through `Executor`/`PathResolver`), per-tool journal adapters (`verify`, `describeForNote`), `WorkspaceReader` (gated reads for `ContextBuilder`). | §2.7 | base, runtime-contract, protocol, security, git, **persistence (`import type` from `./contract` only: `EffectKind`, `ReplayClass`, `EffectIntent`, `EffectRecord`)** · typebox. Globs go through `security`'s `GlobMatcher`: no `picomatch` dependency here |
| `@cohorte/providers` (`packages/providers`) | Tier → `ModelRef` resolution (V3.0: static), provider allowlist + pinned `baseUrl`, auth-mode policy, `monetaryCost` rule, versioned price catalogue (metered legs only), rate-limit header parsers. | `resolveModel`, `AuthPolicy`, `costOf`, `parseQuotaHeaders` | base, runtime-contract, config · — |
| `@cohorte/telemetry` (`packages/telemetry`) | stderr/file NDJSON logger (accepts `SealedText` only, never stdout), usage accounting reducers, local metrics snapshot. | `createLogger`, `Accounting` | base · — |
| `@cohorte/project-model` (`packages/project-model`) | V3.0 subset (D10): deterministic scan, `init` plan/apply, desired state, five-class field model, six-class drift diff and conflict-free apply for `reconcile --plan/--apply`, provenance/hash guard. Semantic discovery = seam. | `scanRepository`, `planInit`, `applyInit`, `planReconcile`, `applyReconcile`; `./contract`: `ProjectModel`, `DriftReport`, `ReconcilePlan` `[S]` | base, config, git · yaml, typebox |
| `@cohorte/core` (`packages/core`) | Runtime-independent orchestration: transition tables per profile, guards, phase contracts/executors, loop controller, escalation, agent lifecycle, `ContextBuilder`, budgets, review math, `EventWriter`, `CohorteToolHost`, `EffectJournal`, `ApprovalService`, `WorktreeService`, `Provisioner`, run snapshotter + `PinReader`, `Resumer`. `src/contract/` also holds the **`RunSnapshotManifest` schema** (6.1): it embeds `SandboxCapabilities`, `RuntimeCapabilities` and `RuntimePin`, and `core` is the lowest package allowed to import all three. | §2.5 | base, runtime-contract, protocol, config, persistence (**types + conformance only**), security, tools, git, providers, telemetry, project-model · typebox, picomatch |
| `@cohorte/runtime-pi` (`packages/runtime-pi`) | `PiRuntimeProvider`/`PiRuntime` (parent, Pi-free), `AgentHostProtocol`, child entry (the only Pi-importing code), error classifier, auth child modes. | `createPiRuntimeProvider` | base, runtime-contract · typebox; **child only:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, all `0.85.1` exact |
| `@cohorte/runtime-fake` (`packages/runtime-fake`) | Scriptable deterministic `AgentRuntime`. **Shipped** (spec 27 step 5 dry-run; `cohorte run --runtime fake --script f.yaml`). | `createFakeRuntimeProvider`, `FakeScript`, builder | base, runtime-contract · typebox, yaml |
| `@cohorte/testkit` (`packages/testkit`, dev-only, never bundled) | Hermetic `GIT_ENV`, temp-repo fixtures (`test.extend`), `FixedClock`, `SeqIds`, `FaultInjector`, **fake brain child** (speaks `AgentHostProtocol`, imports no Pi), fake HTTP provider, crash harness, `runCli`, golden helpers. | — | everything (dev) |
| `cohorte` (`apps/cli`) | The published package. Composition root, commander CLI (spec 21), run host (`cohorte __host`), observers, controllers, `--panel`/`--format=line` adapters, `AssetSource` (embedded assets + verification). Second bundle entry: `agent-host`. | bin `cohorte` | all non-dev packages · commander, yaml, picomatch, typebox |
| `apps/daemon` | **Not built in V3.0.** A README naming the seam (run host + inbox = daemon kernel). | — | — |

**Test-only workspace edges** (declared by Wave 0 as `devDependencies` with `workspace:*`, because pnpm resolves nothing undeclared and no
unit may touch the lockfile): `@cohorte/testkit` in every package and in `apps/cli`; `@cohorte/runtime-fake` and `@cohorte/persistence` in
`core` (its tests drive the FakeRuntime and `MemoryStateStore`); **every** `@cohorte/*` package in the root `package.json` (for `tests/**` and
`scripts/**`). `layers.json` records them as `dev` edges: legal from `test/**`, `tests/**` and `scripts/**` only — an import from `src/**` into
a package that the importer declares only under `devDependencies` fails `check-layers` (rule d). The cycle `testkit → * → testkit` is
dev-only and produces pnpm's "cyclic workspace dependencies" warning, which is accepted and documented in `docs/v3/workspace.md`.
Wave 0 proves the whole table mechanically: for every package, every name it may import according to the listings of §2 (workspace and
third-party) must resolve from that package's directory (`scripts/test/resolve-edges.test.ts`), and a canary under `packages/core/test`
importing `@cohorte/runtime-fake` must resolve.

Root-level shipped assets (spec 4): `prompts/{system,agents,phases,discovery}/`, `skills/`, `schemas/` (generated, committed),
`migrations/{state,config}/NNNN_*`. `fixtures/` and `tests/` hold cross-package fixtures and suites. V2 moves to `legacy/v2/` (D8), excluded from
every tsconfig, Biome, vitest and bundle glob.

### 1.2 Layering rules (enforced, not advisory)

```text
L0  base
L1  runtime-contract   protocol                     (may import L0 only, and NOT each other: rule C4)
L2  config  persistence  security  git  providers  telemetry  project-model  runtime-pi  runtime-fake
L3  tools
L4  core            (everything in L0-L3 EXCEPT runtime-pi and runtime-fake; persistence as `import type` + ./conformance only)
L5  apps/cli        (composition root: the only place that names a concrete runtime, store, executor, key store)
dev testkit, tests/**
```

Allowed L2→L1/L2 edges are exactly those of the table in 1.1 (e.g. `security` never imports `protocol` — which is why `BudgetCounters` lives in
`base` and why `CommandAuthenticator` signs a canonical body instead of a `CommandEnvelope`; `config` imports neither `security` nor
`runtime-contract`; `runtime-pi` and `runtime-fake` import only `base` and `runtime-contract`). The one L3→L2 edge that is **type-only** is
`tools → persistence` (`import type` from `@cohorte/persistence/contract`), recorded as `typeOnly` in `layers.json` and enforced by
`check-layers` exactly like `core → persistence`. **The graph is acyclic by construction and Wave 0 proves it**: `tsc -b` over the project
references fails on a cycle (TS6202) and on an undeclared edge (TS6307). `core` may import `node:path`, `node:crypto`, `node:events`, `node:timers` and nothing else from Node: no
`node:fs`, `node:child_process`, `node:sqlite`, `node:net`. Every byte of I/O goes through a port with a named L2/L3/L5 implementer:

| Port (declared in `core/src/contract/ports.ts`) | Implemented by |
|---|---|
| `StateStore`, `BlobStore`, `RunFiles`, `EphemeralSpool` | `persistence` |
| `GitPort` | `git` |
| `Executor`, `PathResolver`, `PolicyEngine`, `Redactor`, `CommandAuthenticator`, `KeyStore` | `security` |
| `ToolRegistry`, `WorkspaceReader` | `tools` |
| `AssetSource` (embedded prompts/skills/schemas/migrations + manifest verification), `InstallInspector` (bundle paths + hashes) | `apps/cli` |
| `AgentRuntimeProvider` | `runtime-pi`, `runtime-fake` |
| `Clock`, `IdSource` | `base` (real) / `testkit` (fixed) |

Enforcement, four independent nets:

1. **pnpm strictness.** A workspace package resolves only if declared in the importer's `package.json`; Wave 0 writes every `package.json` with
   exactly the allowed edges as `dependencies` and the test-only edges of 1.1 as `devDependencies`, and nobody else owns those files.
2. **TypeScript project references** mirror the `dependencies` edges (`tsc -b` fails on an undeclared edge, TS6307, and on a cycle, TS6202).
   Test files cannot join the composite projects (`testkit` ↔ packages would be a reference cycle), so they are typechecked by a second,
   non-composite root project, `tsconfig.tests.json` (7.0), which `pnpm verify` and CI run next to `tsc -b`.
3. **`scripts/check-layers.ts`** (CI job `lint`), an import scanner over `{packages,apps}/*/src/**`, fails on: (a) any edge not in `layers.json`;
   (b) `@earendil-works/` outside `packages/runtime-pi/src/child/**` and `packages/runtime-pi/test/**`; (c) a forbidden `node:` import in `core`;
   (d) any import of `testkit` — or of any workspace package the importer declares only under `devDependencies` — from `src/**`, and any
   value import across a `typeOnly` edge; (e) the identifiers `readStoredCredential`, `print-bearer-token`, `print-api-key` anywhere, and
   `.getAuth(` inside `packages/runtime-pi/src/**` (spec 10.1 "sans lire ni exporter le token"); (f) the cast `as Sealed` outside
   `packages/security/src/redact/seal.ts` and `packages/testkit/**`; (g) `import(` outside `apps/cli/src/lazy.ts` (start-up only, §6.3) and
   **exactly one more file, `packages/runtime-pi/src/child/load-pi.ts`**: the child obtains Pi through it (a literal specifier for
   `loadFrom: 'package'`; for `loadFrom: 'bundle'` a specifier built **only** from the pinned install path and the constant suffix
   `dist/bundle/index.js`, never from a frame or an env value). The child runs before any prompt exists, and the file is part of the pinned bundle.
   `scripts/check-contract-words.ts` fails if `phase|pipeline|gate|policy|approval|review|ownership|worktree|finding|pi` appears **as a whole
   camelCase/snake_case token** (so `capabilities` and `RuntimePin` pass, `piSession` does not) in an exported name or schema key of `runtime-contract`. `scripts/check-prompts.ts` fails on transition/verdict vocabulary in `prompts/**` (spec 4.1).
4. **Bundle allowlist.** tsdown `deps.onlyImport` per entry: `cli` → commander, yaml, picomatch, typebox; `agent-host` →
   `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, typebox. `cli.mjs` importing Pi fails the build,
   which is also what keeps read-only verbs under François' 10 s / 4 MiB one-shot budget (F6).

### 1.3 Where fakes and test utilities live

| Thing | Location | Shipped? |
|---|---|---|
| Fake runtime | `packages/runtime-fake` | yes |
| Fake **brain child** (Pi-free, speaks `AgentHostProtocol`) | `packages/testkit/src/fake-brain/` | no |
| Fake provider, in-process (`fauxProvider()` + `modelRuntime.registerNativeProvider`, `InMemoryCredentialStore`) **[X]** | `packages/runtime-pi/test/support/agent-host.test-entry.ts` — a **separate entry file that is never a bundle entry**; it imports the production `boot()` and injects a `ProviderSetup` | no. The shipped `agent-host.mjs` contains no test hook (packaging test greps both bundles for `faux`, `registerNativeProvider`, `InMemoryCredentialStore`) |
| Fake provider, wire level (scripted `openai-codex-responses` endpoint through an **injected `fetch`**, records every request header) | `packages/testkit/src/http-provider/` + the same test entry | no |
| Runtime / store conformance suites | `packages/runtime-contract/src/conformance/`, `packages/persistence/src/conformance/` | no (excluded by bundle allowlist) |
| Fixture repos (spec 25.3) | `fixtures/repos/<name>/build.ts` builders producing a fresh git repo per test; never a committed `.git` | no |
| Golden schema instances | `fixtures/schema-compat/<version>/*.json` | no |
| Crash-point registry | `packages/core/src/durability/crashpoints.ts` (inert without `COHORTE_CRASH_AT`) | registry shipped, harness not |

The parent side of `runtime-pi` accepts `entryOverride` only through `createPiRuntimeProvider({ entryOverride })`; `apps/cli` never passes it
(`check-layers` rule: the token `entryOverride` does not appear under `apps/cli/src`). Pi-through-the-built-CLI is exercised only by the opt-in
live smoke; Pi + faux is exercised by composing `createRunHost()` programmatically from tests.

### 1.4 How ONE npm package `cohorte` is produced

```text
pnpm build            (lead / CI only, never inside a wave: see 10.1 rule 6;  units use  scripts/build.ts --out .build/<unit>/ )
 1. scripts/gen-schemas.ts           TypeBox -> schemas/*.schema.json (open variant); CI fails if `git diff schemas/` is dirty
 2. scripts/embed-assets.ts          prompts/ skills/ schemas/ migrations/ -> apps/cli/assets/** + assets/manifest.json
                                     { manifestVersion, cohorteVersion, algorithm:"sha256", treeSha256, files[{path,size,sha256}] } (byte-order sort)
 3. tsdown (apps/cli)                entries { cli: src/cli.ts, "agent-host": ../../packages/runtime-pi/src/child/entry.ts }
                                     format esm · platform node · target node24.16 · dts:false · sourcemap · code-split chunks allowed under dist/chunks/
                                     define { __ASSETS_TREE_SHA256__, __COHORTE_VERSION__ }     (bundle <-> assets cross-check)
                                     deps { onlyBundle: [], onlyImport: [per-entry allowlist] }  (silent-inlining guard, toolchain.md §3-5)
 4. scripts/stage-publish.ts         apps/cli/.publish/{dist,assets,LICENSE,README.md,package.json}; generated package.json has only
                                     name, version, license AGPL-3.0-only, type, bin, files, engines, dependencies (Pi x3 exact, typebox 1.3.7 exact),
                                     repository — no devDependencies, no scripts, no @cohorte/* names
 5. scripts/write-bundle-manifest.ts .publish/dist/bundle-manifest.json { "<every file under dist/>": sha256 }
 6. pnpm pack (from .publish)        cohorte-3.0.0.tgz; `publish.yml` keeps its FILENAME and ENVIRONMENT (npm trusted publishing is bound to both)
 7. scripts/build.ts --out <dir> ONLY  <dir>/.publish/node_modules -> symlink to <repo>/apps/cli/node_modules   (makes a gate/unit build RUNNABLE offline)
```

Step 7 exists because the bundles keep `commander`, `yaml`, `picomatch`, `typebox` and Pi as **bare external imports** (net 4), and under pnpm's
strict layout the repository root `node_modules` holds only the root devDependencies: a file under `<repo>/.build/gate-<n>/.publish/dist/`
importing `yaml` fails with `ERR_MODULE_NOT_FOUND`, while the same file under `apps/cli/dist/` resolves (reproduced in the toolchain prototype
layout). `apps/cli` re-declares every runtime dependency, Pi included, so its `node_modules` is exactly the dependency set of the published
package; the symlink is never staged, never packed (`pack-check` asserts the tarball allowlist) and never created for the publish build.
`build.ts --out` ends by running `node <dir>/.publish/dist/cli.mjs --version` and `node <dir>/.publish/dist/agent-host.mjs --selftest`
**offline, from `<dir>`**. `pack-check` still proves the real thing (an `npm install`-ed tarball) but needs the network, so only Wave 0,
integrators and the packaging unit run it; every other consumer of a built CLI uses the linked build.

Pi is never inlined (pi-ai loads OAuth flows through a variable-specifier `import()` relative to `import.meta.url`; pi-coding-agent resolves its
package dir from `__dirname` **[X]**). `pnpm-workspace.yaml` carries `overrides` pinning every `@earendil-works/*` to `0.85.1` (pnpm ignores Pi's
shrinkwrap; a caret on 0.x could install two pi-ai copies and break `instanceof ModelsError`) and the `allowBuilds: false` entries pnpm 12 needs for
`@google/genai`, `esbuild`, `protobufjs` **[X]**. The child asserts at start-up that the three Pi package versions are equal.

**The packaging path is retired in Wave 0, not Wave 3:** W0 acceptance installs the tarball in an empty directory with `npm install
--ignore-scripts` and runs `cohorte --version` and `node dist/agent-host.mjs --selftest` (prints the Pi version it imported).

---

## 2. Contracts as TypeScript

**Authoring convention.** Every type marked `[S]` is authored as a TypeBox schema and the TypeScript type is derived
(`export const X = Type.Object({...}); export type X = Static<typeof X>`). Listings show the *static* type for readability. Types not marked `[S]`
are in-process interfaces (they hold functions, promises or `AbortSignal`s) and never cross a process boundary. Compiler flags honoured everywhere:
`erasableSyntaxOnly` (no `enum`, no namespaces, no parameter properties), `verbatimModuleSyntax`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `skipLibCheck: true` (mandatory with Pi's own `.d.ts` under NodeNext **[X]**), and **`isolatedDeclarations: false`**
(§11 D-4). JSON on a wire never contains `undefined`.

### 2.1 `@cohorte/base`

```ts
// ids.ts ─────────────────────────────────────────────────────────────────────────────
/** Token-safe for François' single ${token} slot, for refs and for paths. */
export const ID_PATTERN = '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$';
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId       = Brand<string, 'RunId'>;        // run_<uuidv7 without dashes>
export type AgentId     = Brand<string, 'AgentId'>;      // agt_<role>_<surface|main>[_<n>]   stable across incarnations
export type PhaseRunId  = Brand<string, 'PhaseRunId'>;   // phs_<STATE>_<iteration>
export type EventId     = Brand<string, 'EventId'>;      // evt_<uuidv7 hex>
export type CommandId   = Brand<string, 'CommandId'>;    // cmd_<uuidv7 hex>  (client-generated)
export type ApprovalId  = Brand<string, 'ApprovalId'>;   // apr_<uuidv7 hex>
export type ToolCallId  = Brand<string, 'ToolCallId'>;   // tc_<incarnation>_<ordinal>  (assigned by the runtime PARENT, deterministic)
export type EffectId    = Brand<string, 'EffectId'>;     // eff_<uuidv7 hex>
export type ArtifactId  = Brand<string, 'ArtifactId'>;   // art_<sha256[0:32]>
export type FindingId   = Brand<string, 'FindingId'>;    // fnd_<sha256(identity)[0:16]>
export type SpecId      = Brand<string, 'SpecId'>;
export type SurfaceId   = Brand<string, 'SurfaceId'>;
export type Sha256      = Brand<string, 'Sha256'>;       // 64 lowercase hex
export type IsoInstant  = Brand<string, 'IsoInstant'>;   // RFC 3339 UTC, millisecond precision
export function parseId<B extends string>(kind: B, raw: string): Result<Brand<string, B>, ErrorInfo>;   // the ONLY way to mint a brand from input

// ports.ts ───────────────────────────────────────────────────────────────────────────
export interface Clock { now(): IsoInstant; monotonicMs(): number; sleep(ms: number, signal?: AbortSignal): Promise<void>; }
export interface IdSource { next<B extends string>(prefix: string): Brand<string, B>; }     // real: crypto.randomUUIDv7; tests: seeded counter
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// model.ts [S] ───────────────────────────────────────────────────────────────────────
export type ModelCapability = 'fast' | 'coding' | 'reasoning' | 'vision' | 'cheap';
/** Spec 10, VERBATIM. Thinking level is NOT part of ModelRef: it travels next to it (SpawnRequest.thinking, tier table). */
export interface ModelRef { provider: string; model: string; capability?: ModelCapability; }
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type AuthMode = 'subscription' | 'api';                                   // spec 10: exactly these two
/** A number exists only for a metered leg (authMode 'api'). NEVER 'not_applicable' for a metered leg (I8). */
export type MonetaryCost = 'not_applicable' | { currency: 'USD'; amount: number; basis: 'catalogue' | 'estimate'; priceCatalogVersion: string };

// usage.ts [S] ───────────────────────────────────────────────────────────────────────
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; }
export type QuotaInfo =
  | { known: false }
  | { known: true; source: 'response-headers' | 'error'; provider: string; windows: QuotaWindow[]; observedAt: IsoInstant };
export interface QuotaWindow { name: string; usedPercent?: number; resetsAt?: IsoInstant; limitLabel?: string; }
/** Lives in base (not in the protocol vocabulary) because `security` (BudgetReader, 2.6.1) needs it and may not import `protocol`. `protocol` re-exports it. */
export interface BudgetCounters { tokens?: number; modelRequests?: number; toolCalls?: number; wallClockMs?: number; retries?: number; fixRounds?: number; contextTokens?: number; concurrentAgents?: number; estimatedQuotaPercent?: number; }

// redaction.ts ───────────────────────────────────────────────────────────────────────
export interface Redaction { path: string /* JSON pointer */; reason: 'secret-value' | 'secret-pattern' | 'env-value' | 'private-key' | 'sensitive-path' | 'size'; detector: string; sha256?: Sha256; }   // [S]
declare const sealed: unique symbol;
/** Compile-time proof that a value went through Redactor. Minted ONLY in packages/security/src/redact/seal.ts (check-layers rule f). */
export type Sealed<T> = T & { readonly [sealed]: true };
export type SealedText = Sealed<string>;
export type SealedJson = Sealed<JsonValue>;
export interface Redactor {
  registerSecret(value: string, id: string): void;               // by VALUE (+ base64, hex, URL-encoded forms); values < 8 chars rejected
  sealText(text: string): { text: SealedText; redactions: Redaction[] };
  sealJson<T extends JsonValue>(value: T): { value: Sealed<T>; redactions: Redaction[] };
}

// errors.ts [S]  (taxonomy in 2.8) ───────────────────────────────────────────────────
export type ErrorClass =
  | 'configuration' | 'validation' | 'permission' | 'security' | 'provider-transient' | 'provider-terminal'
  | 'tool-transient' | 'tool-terminal' | 'conflict' | 'budget' | 'timeout' | 'corruption' | 'human-required';
export interface ErrorInfo {
  code: string;                 // stable, "<class>/<slug>"
  class: ErrorClass;
  message: string;              // redacted, single paragraph (the cause)
  impact: string;               // what this means for the run / the user (spec 21 "cause, impact, run, prochaine action")
  retryable: boolean;
  retryAfterMs?: number;
  remediation: string;          // imperative next action
  cause?: ErrorInfo;            // chained, max depth 5
  details?: Record<string, JsonValue>;
}

// canonical.ts ───────────────────────────────────────────────────────────────────────
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export function canonicalJson(v: JsonValue): string;   // sorted keys, no whitespace, NFC strings
export function sha256Hex(data: string | Uint8Array): Sha256;
```

### 2.2 `@cohorte/runtime-contract`

Rules of this package (checked by `check-contract-words`): no orchestration vocabulary and no engine name in any exported identifier or schema
key. `runId`/`agentId` are opaque correlation ids (R10). `role`, tool names and transcript formats are **strings**, never closed unions: adding a
runtime or a tool never edits this contract (spec 30 risk 1).

```ts
import type { AgentId, RunId, ToolCallId, IsoInstant, Sha256, ModelRef, ThinkingLevel, AuthMode, TokenUsage, QuotaInfo, ErrorInfo, JsonValue, SealedText, Clock, IdSource } from '@cohorte/base';

// ── 2.2.1 The runtime — spec 5.1 VERBATIM ────────────────────────────────────────────
export type Unsubscribe = () => void;
export interface AgentRuntime {
  readonly id: string;                 // 'pi' | 'fake' | future 'claude-agent-sdk'
  readonly version: string;            // "<adapter semver>+<engine>.<engine version>", e.g. "3.0.0+pi.0.85.1"
  capabilities(): RuntimeCapabilities;
  spawn(request: SpawnRequest): Promise<RuntimeAgentHandle>;
  send(agentId: string, message: RuntimeMessage): Promise<void>;
  cancel(agentId: string, reason?: string): Promise<void>;
  pause(agentId: string): Promise<void>;
  resume(agentId: string): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): Unsubscribe;
  inspect(agentId: string): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}

/** How a host obtains a runtime. Pinning (spec 16), auth status and login live HERE so the spec interface stays verbatim. */
export interface AgentRuntimeProvider {
  readonly id: string;
  pin(): Promise<RuntimePin>;                                           // identity of the runtime code as installed NOW; called once at run start
  create(bindings: RuntimeHostBindings, pin: RuntimePin): Promise<AgentRuntime>;   // fails security/runtime-pin-mismatch if artifacts differ from `pin`
  authStatus(providers: string[]): Promise<ProviderAuthStatus[]>;      // WITHOUT reading a token (spec 10.1)
  login(provider: string, ui: LoginInteraction, signal: AbortSignal): Promise<ProviderAuthStatus>;   // operates on the ENGINE's credential store (R7)
  logout(provider: string): Promise<void>;
}
export interface LoginInteraction {      // implemented by the CLI; all text is sealed before it is shown or logged
  show(event: { kind: 'open-url'; url: string; instructions?: string } | { kind: 'device-code'; userCode: string; verificationUri: string } | { kind: 'info'; message: string }): void;
  ask(prompt: { kind: 'text' | 'secret' | 'manual-code'; message: string } | { kind: 'select'; message: string; options: { id: string; label: string }[] }): Promise<string>;
}
export interface RuntimeHostBindings {
  toolHost: ToolHost;                                                   // rule C1 — and NOTHING that can execute
  stateDir: (runId: RunId, agentId: AgentId, incarnation: number) => string;   // absolute dir for transcript + wire log
  clock: Clock; ids: IdSource;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: SealedText, fields?: Record<string, JsonValue>) => void;
}

// ── 2.2.2 Rule C1: tools are executed by the host, never by the runtime ─────────────
export interface ToolHost {
  /** Called exactly once per model tool call, in emission order (ordinal), BEFORE any effect. MUST resolve (a rejection is a host bug:
   *  the runtime treats it as isError + agent failure). MUST settle promptly after ctx.signal aborts. MAY take hours (human decision). */
  handleToolCall(call: RuntimeToolCall, ctx: ToolCallContext): Promise<RuntimeToolResult>;
}
export interface RuntimeToolCall {                       // [S]
  runId: RunId; agentId: AgentId; incarnation: number;
  toolCallId: ToolCallId;                                // tc_<incarnation>_<ordinal>
  engineToolCallId?: string;                             // the engine's own id, transcript correlation only
  ordinal: number;                                       // 1-based, per incarnation, gapless
  tool: string;
  input: JsonValue;                                      // as produced by the model after engine-side coercion; host re-validates strictly
}
export interface ToolCallContext { signal: AbortSignal; progress(update: ToolProgress): void; }
export interface ToolProgress { text?: string; bytes?: number; }          // [S]
export interface RuntimeToolResult {                     // [S] content is SEALED: the engine transcript never holds an unredacted tool result (I7)
  isError: boolean;
  content: ToolContent[];
  terminate?: boolean;                                   // host asks the runtime to end the agent loop after this batch
  resultRef?: string;                                    // opaque audit id, stored in the transcript
}
export type ToolContent = { type: 'text'; text: SealedText } | { type: 'image'; mediaType: string; dataBase64: string };

// ── 2.2.3 SpawnRequest: the ten spec-5.1 fields + what spec 6 / 10.1 / 16 require ────
export type AgentRole = string;                          // opaque label; the runtime MUST NOT branch on it

export interface SpawnRequest {                          // [S]
  runId: RunId; agentId: AgentId; role: AgentRole;
  model: ModelRef; systemPrompt: PromptRef; context: ContextManifest;
  tools: ToolGrant[]; sandbox: SandboxPolicy; budget: Budget;
  workingDirectory: string;                              // absolute, canonical; the path the MODEL is told about. The engine process MUST NOT use it as its cwd
  // additions (all required so that no runtime can forget them):
  incarnation: number;                                   // spec 6: spawn is idempotent on (runId, agentId, incarnation)
  thinking: ThinkingLevel;
  auth: AuthRequirement;                                 // spec 10.1 / D3
  task: TaskInput;                                       // the first user message, by reference
  continuation: Continuation | null;                     // a later incarnation of the same attempt
}
export interface AuthRequirement {
  mode: AuthMode; provider: string;
  baseUrl: string;                                       // pinned catalogue endpoint; a runtime that would talk to anything else MUST refuse to spawn
  allowApiKey: boolean;                                  // false unless the run plan carries an explicit api opt-in
}
export interface TaskInput { path: string; sha256: Sha256; bytes: number; }               // rendered by the host into the run snapshot dir
/** `note` is delivered by the runtime AFTER `task` and BEFORE the first model request: as a second user message when the engine can carry two in one prompt,
 *  otherwise appended to the first user message after the fixed separator line "\n\n[cohorte] continuation note\n\n". Either way each text is a byte-identical
 *  contiguous span and `task` comes first (conformance rule 12). */
export interface Continuation { fromIncarnation: number; note: TaskInput; transcript?: TranscriptRef /* used only if continuationFromTranscript = yes */; }
export interface PromptRef { id: string; path: string; sha256: Sha256; bytes: number; }   // [S] runtime MUST verify sha256 before use

/** PROVENANCE ONLY. "Installer le contexte" (spec 5.2) is defined as: every byte the model sees is in exactly two host-rendered files —
 *  `systemPrompt` (tiers `system` + `doctrine`) and `task` (tiers `data` + `task` + `prior-results`) — plus, for a later incarnation,
 *  `continuation.note`. A runtime installs those three and NOTHING else: it never opens `entries[].source`, never re-orders or re-renders
 *  tiers. The manifest travels so that the runtime can record `manifestSha256` on `model.requested` and so that a second runtime has
 *  nothing to guess. */
export interface ContextManifest {                       // [S] spec 7; tiers are trust/priority tiers, not orchestration words
  manifestSha256: Sha256;                                // sha256(canonicalJson(entries)) = "hash du contexte" of spec 19
  tokenLimit: number; tokenEstimate: number;
  entries: ContextEntry[];                               // deterministic order: tier, then id
  reductions: { entryId: string; strategy: 'excerpt' | 'outline' | 'summary-with-refs' | 'dropped'; fromBytes: number; toBytes: number }[];
  exclusions: { pattern: string; reason: 'secret' | 'outside-scope' | 'size' | 'binary' }[];                 // R9
}
export interface ContextEntry {
  id: string;
  tier: 'system' | 'doctrine' | 'data' | 'task' | 'prior-results';
  trust: 'cohorte' | 'human' | 'untrusted-repository' | 'agent-output';   // agent-output and untrusted-repository can never sit above 'data'
  source: { kind: 'asset' | 'project-file' | 'artifact' | 'event-summary' | 'inline'; ref: string };
  sha256: Sha256; bytes: number; tokenEstimate: number;
}

export interface ToolGrant {                             // [S] what the BRAIN needs to know. No paths, no commands, no ownership: that is host policy.
  tool: string;                                          // ^[a-z][a-z0-9_]{1,40}$ ; never differs only by case from another grant
  description: string;
  inputSchema: JsonValue;                                // JSON Schema 2020-12, ONE flat top-level object: no $ref/$defs/oneOf at root (provider flattening)
  effect: 'read' | 'write' | 'execute' | 'network' | 'control';   // ordering hint only
  terminal: boolean;                                     // true for the result tool
}

export interface SandboxPolicy {                         // [S] isolation of the RUNTIME'S OWN agent process (the brain). Tool isolation is host-side.
  require: 'os' | 'os-if-available' | 'process';         // spawn fails security/sandbox-unavailable below `os`
  filesystem: { readOnly: string[]; readWrite: string[]; denyRead: string[] };   // absolute canonical roots
  network: { mode: 'none' | 'provider-only' | 'unrestricted'; allowHosts: string[] };
  env: { allow: string[]; set: Record<string, string> };              // allowlist; nothing else is inherited (D3)
  limits: { maxOldSpaceMb?: number; maxCpuSeconds?: number; maxOpenFiles?: number };
}

export interface Budget {                                // [S] hard ceilings for ONE incarnation; absent = unlimited at this level
  maxTurns?: number; maxModelRequests?: number; maxToolCalls?: number;
  maxInputTokens?: number; maxOutputTokens?: number; maxTotalTokens?: number;
  maxContextTokens?: number;                             // stop (never auto-compact) when the last request's context exceeds this
  maxWallClockMs?: number; maxModelRequestMs?: number;
  maxEngineRetries: number;                              // 0 = every retry is the host's (spec 11.3 "tous les retries sont visibles")
}

// ── 2.2.4 Handle, messages, snapshot ─────────────────────────────────────────────────
export interface RuntimeAgentHandle {
  readonly runId: RunId; readonly agentId: AgentId; readonly incarnation: number;
  readonly session: RuntimeSessionRef; readonly startedAt: IsoInstant;
  readonly process: { pid: number; pgid: number; startToken: string } | null;   // startToken = OS process start time: orphan kill never trusts a bare pid
  readonly exit: Promise<AgentExit>;                     // settles exactly once, never rejects, only AFTER the final RuntimeEvent was delivered
}
export interface RuntimeSessionRef { runtime: string; engineVersion: string; sessionId: string; transcript: TranscriptRef; }   // [S] R8: opaque to clients
export interface TranscriptRef { path: string; format: string /* label, e.g. 'jsonl-v3' | 'fake-ndjson-v1' — never interpreted by core */; }
export interface AgentExit {                             // [S]
  outcome: 'completed' | 'failed' | 'cancelled' | 'crashed';
  stop: AgentStopCause; error?: ErrorInfo; usage: UsageTotals; lastSeq: number;
}
/** The ADAPTER's typed cause, recorded by the host BEFORE it acts. The engine's own stop reason is never a discriminator [X]. */
export type AgentStopCause = 'host-terminated' | 'model-stop' | 'output-truncated' | 'budget' | 'cancelled' | 'engine-error' | 'process-exit';

export type RuntimeMessage =                              // [S]
  | { kind: 'user'; messageId: string; text: string; delivery: 'steer' | 'follow-up' }
  | { kind: 'host-note'; messageId: string; text: string; delivery: 'steer' | 'follow-up' };   // rendered as a user message prefixed "[cohorte]"

export interface RuntimeSnapshot {                        // [S]
  runId: RunId; agentId: AgentId; incarnation: number;
  state: 'starting' | 'running' | 'awaiting-tool' | 'paused' | 'settling' | 'exited';
  pausedAt?: 'tool-boundary' | 'model-boundary';
  turn: number; pendingToolCalls: ToolCallId[];
  requestedModel: ModelRef; effectiveModel?: EffectiveModel; authMode?: AuthMode;
  usage: UsageTotals; contextTokens?: number; contextWindow?: number;
  session: RuntimeSessionRef; lastSeq: number;
  diagnostics: Record<string, JsonValue>;               // pid, rssMb, lastHeartbeatAt, engine flags… never secrets
}
export interface UsageTotals { tokens: TokenUsage; modelRequests: number; toolCalls: number; turns: number; wallClockMs: number; }
export interface EffectiveModel { provider: string; model: string; api?: string; baseUrl?: string; }

// ── 2.2.5 RuntimeEvent: "Pi-shaped, not Pi-typed" ────────────────────────────────────
interface Ev<T extends string, D extends 'durable' | 'ephemeral', P> {
  type: T; durability: D; runId: RunId; agentId: AgentId; incarnation: number;
  seq: number;                                           // per incarnation, strictly increasing over BOTH durabilities
  at: IsoInstant; data: P;
}
export type RuntimeEvent =                                // [S] discriminated on `type`
  | Ev<'agent.spawned',           'durable',   { session: RuntimeSessionRef; requestedModel: ModelRef; tools: string[]; systemPromptSha256: Sha256; effectiveSystemPromptSha256: Sha256; isolation: IsolationReport }>
  | Ev<'agent.started',           'durable',   { taskSha256: Sha256 }>
  | Ev<'agent.turn.started',      'ephemeral', { turn: number }>
  | Ev<'agent.turn.completed',    'durable',   { turn: number; toolCalls: number }>
  | Ev<'agent.message.started',   'ephemeral', { messageId: string; role: 'assistant' | 'user' | 'tool-result' }>
  | Ev<'agent.message.delta',     'ephemeral', { messageId: string; channel: 'text' | 'thinking' | 'tool-input'; contentIndex: number; delta: string }>
  | Ev<'agent.message.completed', 'durable',   { messageId: string; role: 'assistant' | 'user' | 'tool-result'; textSha256: Sha256; textBytes: number; preview: string /* <=512 */; stop?: 'stop' | 'length' | 'tool-use' | 'error' | 'aborted' }>
  | Ev<'model.requested',         'durable',   { requestId: string; model: ModelRef; contextSha256?: Sha256; contextTokensEstimate?: number; attempt: number }>
  | Ev<'model.responded',         'durable',   { requestId: string; requestedModel: ModelRef; effectiveModel: EffectiveModel; authMode: AuthMode; authSource: 'oauth' | 'api-key' | 'none'; durationMs: number; usage: TokenUsage; httpStatus?: number; attempt: number; stop: 'stop' | 'length' | 'tool-use' | 'error' | 'aborted'; quota: QuotaInfo; error?: ErrorInfo }>
  | Ev<'tool.call.requested',     'durable',   { call: RuntimeToolCall }>                       // model asked; nothing ran yet; ToolHost WILL be called
  | Ev<'tool.call.rejected',      'durable',   { engineToolCallId?: string; tool: string; cause: 'unknown-tool' | 'invalid-input' | 'output-truncated'; message: string }>   // engine refused BEFORE the host: ToolHost is NOT called [X]
  | Ev<'tool.call.progress',      'ephemeral', { toolCallId: ToolCallId; update: ToolProgress }>
  | Ev<'tool.call.delivered',     'durable',   { toolCallId: ToolCallId; isError: boolean; terminate: boolean; waitedMs: number }>
  | Ev<'agent.paused',            'durable',   { at: 'tool-boundary' | 'model-boundary' }>
  | Ev<'agent.resumed',           'durable',   Record<string, never>>
  | Ev<'agent.message.accepted',  'durable',   { messageId: string; delivery: 'steer' | 'follow-up' }>
  | Ev<'agent.exited',            'durable',   AgentExit>
  | Ev<'runtime.warning',         'durable',   { code: string; message: string }>;
// authSource 'none' exists only for runtimes that hold no credential (the fake). A fake run reports the authMode its plan requested.
// EVERY durable type above has a named target in the protocol catalogue, or an explicit "not forwarded" rule: the mapping table is in 2.3.3.
// `stop` is a CLOSED five-value set on this frontier: an adapter maps any other engine stop reason (Pi 0.85.1 also has 'pending' and
// 'deferred', pi-ai types.d.ts:287) to 'error' and emits runtime.warning{code:'engine-stop-reason-unmapped'}.
export interface IsolationReport { level: 'os' | 'process' | 'none'; filesystem: 'enforced' | 'advisory'; network: 'enforced' | 'partial' | 'none'; backend: string; }

// ── 2.2.6 Capabilities: honest, tri-state, doctor-reportable ─────────────────────────
export type Cap = { value: 'yes' } | { value: 'no'; why: string } | { value: 'partial'; why: string };
export interface RuntimeCapabilities {                    // [S]
  contractVersion: '1';
  toolExecution: 'host-delegated';                       // the only legal value (C1); present so conformance can assert it
  streaming: Cap; thinkingStream: Cap;
  send: { steer: Cap; followUp: Cap };
  cancelCooperative: Cap; cancelHard: Cap;
  pause: { toolBoundary: Cap; modelBoundary: Cap };
  continuationFromTranscript: Cap;
  processIsolation: Cap; envFiltering: Cap; brainSandbox: Cap; resourceLimits: Cap;
  budgetEnforcement: { turns: Cap; modelRequests: Cap; tokens: Cap; context: Cap; wallClock: Cap; outputTokensPerRequest: Cap };
  hiddenModelCalls: Cap;                                 // 'no' = none possible (compaction and engine retries off)
  usageReporting: Cap; effectiveModelReporting: Cap; quotaReporting: Cap;
  authStatusWithoutSecret: Cap; subscriptionModeAssertion: Cap;
  systemPromptExact: Cap; runtimePinning: Cap;
  platforms: { darwin: Cap; linux: Cap; win32: Cap };
  hints: { memoryPerAgentMb: number; coldStartMs: number; maxConcurrentAgents: number };
}

// ── 2.2.7 Pin and auth status ────────────────────────────────────────────────────────
export interface RuntimePin {                             // [S] spec 16
  runtimeId: string; adapterVersion: string;
  engine: { name: string; version: string } | null;
  node: { version: string; execPath: string };
  artifacts: { role: 'agent-host-bundle' | 'engine-package-tree' | 'install-lock'; path: string; sha256: Sha256; files?: number; bytes: number }[];
  digest: Sha256;                                         // sha256(canonicalJson(all of the above))
}
export interface ProviderAuthStatus {                     // [S] never contains a token, a refresh token or an account secret
  provider: string;
  state: 'oauth' | 'api-key' | 'absent' | 'unknown-transient';    // 'unknown-transient' = credential store locked: NEVER mapped to AUTH_REQUIRED
  subscription: boolean; source?: string; checkedAt: IsoInstant;
  accountLabel?: string;                                  // non-secret account/tenant label WHEN the engine exposes one without a secret. Pi 0.85.1 does not (D-24): always absent there
  billing: 'plan-limits' | 'metered' | 'unknown';         // Cohorte's own table, not the engine's isSubscription flag (§3.7)
  caveat?: string;
}
```

**Conformance suite** (`@cohorte/runtime-contract/conformance`, **delivered complete in Wave 0** with a 60-line in-test echo runtime proving it
runs; executed by `runtime-fake` always and by `runtime-pi` against the faux provider):

1. every `tool.call.requested` is followed by exactly one `ToolHost.handleToolCall` with the same `toolCallId`; no `tool.call.delivered` exists
   without it; a call the engine refuses itself surfaces as `tool.call.rejected` with **no** handler invocation;
2. `seq` strictly increases; `exit` settles after the last event;
3. a second `spawn` with the same `(runId, agentId, incarnation)` rejects with `conflict/incarnation-exists`;
4. `cancel` during a pending `handleToolCall` aborts `ctx.signal` and `exit.outcome === 'cancelled'` within the declared bound;
5. `pause`, then a pending tool result: the result is delivered, and no further `handleToolCall` starts until `resume`; if
   `pause.modelBoundary` is `yes`, no `model.requested` is emitted until `resume` either;
6. a `PromptRef` or `TaskInput` whose file hash differs rejects `spawn` with `security/asset-hash-mismatch`;
7. `maxTurns: 1` yields `exit.stop === 'budget'`; if `budgetEnforcement.modelRequests` is `yes`, `maxModelRequests: 1` yields at most one `model.requested`;
8. `capabilities()` is a pure, schema-valid value;
9. after `close()` no child process or timer survives;
10. every `RuntimeToolResult.content` text handed back is delivered byte-identical to the model (no engine-side rewriting);
11. `AuthRequirement.baseUrl` different from the engine's resolved endpoint rejects `spawn` with `security/auth-endpoint-mismatch`;
12. context installation: a probe model sees `systemPrompt` byte-identical as the system prompt (modulo the engine suffix recorded in
    `effectiveSystemPromptSha256`) and `task` byte-identical at the start of the first user message; with a non-null `continuation` it sees
    `task` **then** `note`, in that order, each as a byte-identical contiguous span, both before the first `model.requested`; nothing else
    from `context` reaches the model. What "the model sees" is observed through the suite's `opts.modelProbe()` hook: the faux provider's
    recorded request context for `runtime-pi`, the recorded model input for `runtime-fake` and the echo runtime.

### 2.3 `@cohorte/protocol` — the Cohorte Protocol v1.0

#### 2.3.1 Pipeline vocabulary (`src/vocabulary.ts`, written first in Wave 0; `core`, `config` and `persistence` import it from here)

```ts
// OPEN ON THE WIRE (spec 32: a provisional ADR is never frozen as a closed wire enum). The TS unions below list the KNOWN values; their wire
// schemas are OpenEnum (2.3.2) for: PipelineProfile (ADR-0018), SandboxReport.level / .backend / .filesystem / .network (ADR-0003),
// Actor.transport (ADR-0004), ResumeReport verdicts, and the authenticator `scheme` (ADR-0022). Adding a profile, a backend, a transport or a
// signature scheme is therefore a MINOR. `core` still switches exhaustively over the KNOWN values and rejects an unknown one at the door.
export type PipelineProfile = 'feature' | 'bugfix' | 'review';                                    // D6 / R3 — OpenEnum on the wire
export type ActivePipelineState = 'BRAINSTORM' | 'SPEC' | 'PREFLIGHT' | 'BUILD' | 'TEST' | 'REVIEW' | 'FIX' | 'SHIP';
export type SuspendedState = 'PAUSED' | 'WAITING_APPROVAL' | 'AUTH_REQUIRED' | 'QUOTA_EXCEEDED';   // spec 11.1 + the two states spec 10.1 names
export type HaltedState = 'FAILED' | 'BLOCKED';                // FAILED: recoverable checkpoint (spec 24). BLOCKED: human inspection mandatory
export type TerminalState = 'COMPLETED' | 'CANCELLED';
export type PipelineState = 'IDLE' | ActivePipelineState | SuspendedState | HaltedState | TerminalState;
export type TransitionReason =
  | 'start' | 'ready' | 'built' | 'tests-pass' | 'tests-fail' | 'review-approved' | 'review-findings' | 'review-delivered' | 'fixed' | 'shipped'
  | 'needs-human' | 'approval-resolved' | 'pause-command' | 'resume-command' | 'cancel-command' | 'retry-command' | 'skip-command'
  | 'auth-required' | 'auth-restored' | 'quota-exceeded' | 'quota-reset' | 'stop-rule' | 'security-violation' | 'unexpected-error';
export type StopReason =
  // the ten of spec 11.2, in spec order:
  | 'review-clean' | 'iteration-limit' | 'budget-exhausted' | 'timeout' | 'identical-failure' | 'no-progress'
  | 'policy-violation' | 'approval-required' | 'unexpected-repo-change' | 'runtime-incompatible'
  // required by spec 10.1, 17.2, 24:
  | 'auth-required' | 'quota-exceeded' | 'paused' | 'cancelled' | 'agent-dead' | 'unreviewed' | 'internal-error'
  // required by table totality (2.5.1 T16): a check that ERRORED (spawn failure, timeout, sandbox denial) is neither "tests pass" nor "tests fail":
  | 'check-environment';
export type AgentState = 'declared' | 'planned' | 'spawning' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'retrying' | 'escalated' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'waiting-approval' | 'cancelled' | 'skipped' | 'blocked';   // R2
export const COHORTE_ROLES = ['discoverer','brainstormer','architect','spec-author','implementer','tester','reviewer','security-reviewer','fixer','release-manager','reconciler','verifier'] as const;   // OpenEnum on the wire
export type CohorteRole = (typeof COHORTE_ROLES)[number];
export type Severity = 'critical' | 'major' | 'minor' | 'info';                                   // spec 22 speaks of 'major'
export interface Actor { kind: 'human' | 'client' | 'system'; id: string; transport: OpenEnumOf<'cli'>; }   // V3.0 implements ONE transport; 'stdin'/'socket' are future open-enum values, not promises. Identity rules: 2.6.7
export interface GuardOutcome { id: string; ok: boolean; detail?: string; }
export interface StopRecord { reason: StopReason; detail: string; resumable: boolean; resumeRequires?: OpenEnumOf<'approval'|'auth-login'|'quota-reset'|'budget-raise'|'human-ack'|'repo-repair'|'reinstall-pinned-version'|'environment-repair'>; }
export type { BudgetCounters } from '@cohorte/base';   // declared in base/usage.ts (2.1); re-exported here so protocol consumers keep one import
export type EscalationStep = { kind: 'model-tier'; role: CohorteRole; from: ModelCapability; to: ModelCapability } | { kind: 'role'; from: CohorteRole; to: CohorteRole } | { kind: 'human' };
export interface EscalationPolicy { sameFailureCount: number /* 2 */; ladder: EscalationStep[]; maxPerRun: number /* 2 */; }   // data: used by config AND by escalation.applied
export interface CheckResult { name: string; status: 'passed' | 'failed' | 'errored' | 'skipped'; argv: string[]; exitCode?: number; durationMs: number; treeDigest: string; output?: ArtifactRef; }
```

#### 2.3.2 Envelope, durability and the authoring pattern

```ts
export const PROTOCOL_VERSION = '1.0';
/** OPEN enums (values may be added in a minor): strict compile -> enum [...known]; published schema -> { type:'string', 'x-cohorte-known': [...] }. */
export function OpenEnum<const V extends readonly string[]>(known: V, opts?: { description?: string }): TSchema;

export const EnvelopeBase = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  eventId:    Type.String({ pattern: '^evt_[0-9a-f]{32}$' }),
  sequence:   Type.Integer({ minimum: 0 }),     // durable: own gapless per-run sequence (1..n). ephemeral: sequence of the last COMMITTED durable event when it is STAMPED (ordering rule below)
  sub:        Type.Integer({ minimum: 0 }),     // durable: 0. ephemeral: 1.. after that durable sequence. Total order = (sequence, sub)
  durability: Type.Union([Type.Literal('durable'), Type.Literal('ephemeral')]),
  timestamp:  Type.String({ format: 'date-time' }),
  runId:      Type.String({ pattern: ID_PATTERN }),
  type:       Type.String(),                    // narrowed per event
  source:     Type.Union([Type.Literal('cohorte'), Type.Literal('runtime'), Type.Literal('client'), Type.Literal('human')]),
  phase:      Type.Optional(PhaseRef),          // { phaseRunId, state, iteration }
  agent:      Type.Optional(AgentRef),          // { agentId, role, surface?, incarnation, attempt }
  causationId:Type.Optional(Type.String()),     // eventId or commandId that caused this event
  summary:    Type.String({ maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]*$' }),  // one line, sealed, NO C0/C1 control character at all (no tab, no newline, no ESC): EventWriter replaces them by U+FFFD before validation (shared presentation contract of every client; 2.3.6)
  severity:   Type.Union(['info','success','warning','error','progress'].map(s => Type.Literal(s))),
  payload:    Type.Unknown(),                   // narrowed per event
  redactions: Type.Array(Redaction),
});

export const EVENTS = { /* one declaration per event type = payload schema + durability: this table IS the catalogue (2.3.3) */ } as const;
export type EventType = keyof typeof EVENTS;
export type Payload<T extends EventType> = Static<(typeof EVENTS)[T]['payload']>;
export type Envelope<T extends EventType = EventType> = { [K in T]: Omit<Static<typeof EnvelopeBase>, 'type' | 'payload' | 'durability'> & { type: K; durability: (typeof EVENTS)[K]['durability']; payload: Payload<K> } }[T];

export function compileStrict<T extends EventType>(type: T): (payload: unknown) => Result<Payload<T>, SchemaIssue[]>;   // writer side: unknown keys rejected
export function toOpenJsonSchema(): JsonValue;   // generator side: removes additionalProperties:false below the envelope, rewrites OpenEnum,
                                                 // $id https://cohorte.dev/schemas/3/events.schema.json, oneOf over `type` WITH a catch-all branch for future types
```

| | durable | ephemeral |
|---|---|---|
| Stored in | `events` table, inside a fenced store transaction, hash-chained, **sealed** | per-run spool `runs/<runId>/stream/<n>.ndjson` (2 segments × 4 MiB, no fsync) + live subscribers |
| `sequence` | own, gapless, strictly monotonic per run | cursor = last durable sequence; ordered by `sub` |
| Replay (`--since-seq N`, exclusive) | always | never (a late client gets a `snapshot` envelope first, then durable events > N, then live ephemerals) |
| Can influence run state | yes — `evolve(state, event)` consumes only durable events | never (type-level: `evolve` takes `Envelope<DurableEventType>`) |
| Loss on crash | impossible after commit (`synchronous=FULL`) | acceptable by definition; text is recoverable from the raw transcript |

**Ordering rule under batching.** Durable events of an agent are appended in batches of at most 50 ms (4.2 E7). An ephemeral event is therefore
**stamped at emission from the writer's queue, not at production**: `EventWriter.ephemeral()` enqueues it behind every pending durable draft of
the same agent (run-level ephemerals: of the run) and assigns `(sequence, sub)` only after that batch has committed — a producer that cannot
wait flushes the batch first. Consequence, tested in `tests/integration/protocol` on a batched run: for every agent, in `(sequence, sub)` order,
no `agent.message.delta` of message *n+1* precedes `agent.message.completed` of message *n*, and no `tool.progress` precedes its `tool.started` (R1).

Compatibility rules (normative, `docs/v3/protocol/compat.md`, enforced by `schema-compat`): MINOR may add event types, optional payload fields,
`OpenEnum` values, commands, optional command fields. MAJOR is required to remove/rename anything, add a required field, change a type, close an
open enum, or change the durability of a type. Readers MUST ignore unknown `type`s, unknown fields and unknown open-enum values.
`.cohorte/manifest.yaml` records `protocol: { min: "1.0", max: "1.0" }` (R4). No Pi type, name or id format appears anywhere; `runtimeRef` (R8)
is optional and opaque. **Effect-journal rows are not events**: the public catalogue contains no `effect.*` type.

#### 2.3.3 Event catalogue (complete for V3.0). `D` durable, `E` ephemeral; spec-17.1 minimum list in bold.

```ts
export interface PhaseRef { phaseRunId: PhaseRunId; state: ActivePipelineState; iteration: number; }
export interface AgentRef { agentId: AgentId; role: string; surface?: SurfaceId; incarnation: number; attempt: number; }
export interface ArtifactRef { artifactId: ArtifactId; kind: OpenEnumOf<'diff'|'file'|'log'|'report'|'agent-output'|'transcript'|'context'|'prompt'|'patch'>; path: string; sha256: Sha256; bytes: number; }
export interface RuntimeRef { runtime: string; version: string; sessionId: string; transcriptRef: string; }     // R8
export interface FileTouch { path: string /* worktree-relative, POSIX */; op: 'read'|'create'|'modify'|'delete'; beforeSha256?: Sha256; afterSha256?: Sha256; bytes?: number; }
export interface SandboxReport { level: OpenEnumOf<'L0-process' | 'L1-os'>; backend: OpenEnumOf<'none' | 'seatbelt' | 'bubblewrap'>; filesystem: OpenEnumOf<'enforced' | 'partial' | 'advisory'>; network: OpenEnumOf<'enforced-off' | 'partial' | 'unenforced'>; }   // 'partial' = backend active but its escape test (S-28 / S-29) has not passed on this platform
export interface RunPlan {
  profile: PipelineProfile; runtime: { id: string; version: string };
  trust: { policySha256: Sha256; loosenedKeys: string[]; grantedBy: OpenEnumOf<'none-needed' | 'user-config' | 'cli-flag' | 'trust-record'> };   // 2.10.1: WHO consented to every security-loosening key of the project file
  models: { role: string; requested: ModelRef; thinking: ThinkingLevel; authMode: AuthMode; billing: 'plan-limits' | 'metered'; reason: string }[];
  apiBillingEnabled: boolean; meteredProviders: string[];                  // non-empty ⇒ the plan printed to the human names per-token billing
  sandbox: SandboxReport; sandboxRequire: 'native' | 'best-effort'; brainIsolation: 'os' | 'process';
  budgets: { run: BudgetCounters; perPhase: BudgetCounters; perAgent: BudgetCounters; perProvider: Record<string, BudgetCounters>; perTool: Record<string, BudgetCounters> };
  network: { provisioning: boolean }; promptOverrides: string[]; unattended: boolean;
}
export interface ApprovalRequest {                                         // R6 — everything a human needs without reading a transcript
  approvalId: ApprovalId;
  kind: OpenEnumOf<'tool'|'shared-path'|'ship'|'budget'|'loop-stalled'|'contract-change'|'spec-not-ready'|'review-leftovers'|'unowned-path'|'api-billing'|'blocked-ack'|'provision-network'>;
  agent?: AgentRef; phase?: PhaseRef; tool?: string; args?: JsonValue /* sealed */; affectedPaths: string[];
  preview: { kind: 'diff' | 'command' | 'text'; text: string };            // sealed; agent-controlled text: clients MUST render it through the sanitiser of 2.3.6
  options?: string[];                                                      // only for the `approval_request` tool: the answers the agent offered; `approve.answer` must be one of them
  ruleId: string; reason: string; asks: { stage: string; ruleId: string; reason: string }[];
  allowedDecisions: ('allow-once' | 'allow-for-run' | 'deny')[];
  preStateSha256?: Sha256;                                                 // what the decision is bound to (4.5): target beforeSha256 (write/patch) or the slot's content-addressed treeDigest (command)
  expiresAt?: IsoInstant; unattended: 'deny' | 'wait'; cli: string /* literal "cohorte approve <id>" */;
}
export interface ResumeReport {
  takeover: boolean; hostId: string; fencingToken: number;
  locks: { rebuilt: string[]; conflicts: string[] };
  orphans: { agentId?: AgentId; incarnation?: number; pid: number; kind: 'brain' | 'command'; killed: boolean }[];
  worktrees: { slot: string; path: string; verdict: OpenEnumOf<'ok' | 're-added' | 'ledger-explained' | 'quarantined-reset' | 'unexplained-change' | 'missing-branch'> }[];
  effects: { effectId: EffectId; kind: string; replayClass: 'idempotent' | 'verifiable' | 'at-most-once'; verdict: OpenEnumOf<'done' | 'failed' | 're-executed' | 'in-doubt' | 'compensated'> }[];
  approvalsCarried: ApprovalId[]; commandsApplied: CommandId[]; inDoubt: EffectId[];
  approvedReplays: { approvalId: ApprovalId; toolCallId: ToolCallId; outcome: OpenEnumOf<'executed' | 'binding-changed' | 'denied-by-gate'> }[];   // 4.5 parked path
}
```

| Type | Dur. | Payload |
|---|---|---|
| **`pipeline.started`** | D | `{ profile; tableVersion: number; spec: { id; sha256; kind: 'feature'\|'patch'\|'review' }; snapshotDigest: Sha256; runtime: { id; version; pinDigest }; plan: RunPlan; base: { branch; sha }; integrationBranch: string; cohorteVersion: string; hostId: string }` |
| **`pipeline.completed`** | D | `{ stop: StopRecord; integration: { branch; headSha; treeDigest }; totals: { usage: BudgetCounters; tokens: TokenUsage; monetaryCost: MonetaryCost; fixRounds: number; durationMs: number } }` |
| **`pipeline.failed`** | D | `{ state: 'FAILED'\|'BLOCKED'; error: ErrorInfo; stop: StopRecord; checkpointSequence: number }` |
| `run.state.changed` | D | `{ transitionId: string; defId: string; tableVersion: number; from: PipelineState; to: PipelineState; reason: TransitionReason; actor: Actor; guards: GuardOutcome[]; idempotencyKey: string; resumeTo?: ActivePipelineState; stop?: StopRecord }` |
| **`run.paused`** | D | `{ commandId?; parkedAgents: AgentId[]; inFlightEffects: EffectId[] }` |
| **`run.resumed`** | D | `{ commandId?; mode: 'unpause'\|'recovery'\|'retry'; report: ResumeReport }` |
| **`run.cancelled`** | D | `{ commandId?; reason: string; cancelledAgents: AgentId[]; worktreesKept: boolean }` |
| `run.host.attached` / `run.host.detached` | D | `{ hostId; pid; cohorteVersion; fencingToken; takeover: boolean }` / `{ hostId; cause: 'exit'\|'signal'\|'lease-lost'\|'shutdown-command'\|'fatal' }` |
| **`phase.started`** | D | `{ phase: PhaseRef; contractId; contractVersion; planned: { agentId; role; surface? }[]; budget: BudgetCounters }` |
| **`phase.completed`** | D | `{ phase: PhaseRef; outcome: 'passed'\|'failed'\|'needs-human'\|'skipped'; outputs: ArtifactRef[]; checks: CheckResult[]; durationMs }` |
| **`agent.declared`** | D | `{ agent: AgentRef; parentAgentId?; owner: string; ownedPaths: string[]; grantsDigest: Sha256; requestedModel: ModelRef; thinking; routingReason: string; budget: BudgetCounters }` |
| **`agent.spawned`** | D | `{ agent: AgentRef; worktree?: { slot; path; branch; baseSha }; tools: string[]; systemPromptSha256; effectiveSystemPromptSha256; authMode: AuthMode; isolation: { level; backend; filesystem; network }; runtimeRef?: RuntimeRef }` |
| **`agent.started`** | D | `{ agent: AgentRef; taskSha256 }` |
| `agent.state.changed` | D | `{ agent: AgentRef; from: AgentState; to: AgentState; reason: OpenEnum<'planned'\|'spawned'\|'tool-wait'\|'approval-wait'\|'quota-wait'\|'peer-wait'\|'paused'\|'resumed'\|'completed'\|'failed'\|'cancelled'\|'retry'\|'escalation'\|'recovery'\|'park'\|'pause-expiry'>; pausedAt?: 'tool-boundary'\|'model-boundary'; attemptConsumed: boolean }` — `attemptConsumed` is true **only** for `reason: 'retry'` and `'escalation'` (2.5.4) |
| **`agent.completed`** | D | `{ agent: AgentRef; status: AgentOutput['status']; summary; confidence; output: ArtifactRef; artifacts: ArtifactRef[]; findings: number; questions: string[]; usage: BudgetCounters }` |
| **`agent.failed`** | D | `{ agent: AgentRef; error: ErrorInfo; willRetry: boolean; nextIncarnation?: number }` |
| `agent.turn.started` / `agent.turn.completed` | E / D | `{ turn }` / `{ turn; toolCalls }` |
| `agent.message.started` / `.delta` | E | `{ messageId; role }` / `{ messageId; channel: 'text'\|'thinking'\|'tool-input'; contentIndex; delta /* <=8192 */ }` (R1) |
| `agent.message.completed` | D | `{ messageId; role; preview /* <=512 */; textSha256; bytes; stop? }` |
| `agent.message.accepted` | D | `{ agent: AgentRef; messageId; delivery: 'steer'\|'follow-up' }` — the runtime took a `send` (host note, nudge, or `agent.send`) into its queue |
| `runtime.warning` | D | `{ agent?: AgentRef; code: string; message /* sealed */ }` — non-fatal runtime diagnostics (unmapped engine stop reason, stale auth snapshot, degraded capability) |
| **`model.requested`** | D | `{ requestId; model: ModelRef; expectedAuthMode: AuthMode; contextSha256?; attempt }` |
| **`model.responded`** | D | `{ requestId; requestedModel; effectiveModel: { provider; model; api?; baseUrl? }; authMode; authSource: 'oauth'\|'api-key'\|'none'; status: 'ok'\|'error'; httpStatus?; durationMs; tokens: TokenUsage; monetaryCost: MonetaryCost; quota: QuotaInfo; attempt; error? }` |
| **`context.built`** | D | `{ agent: AgentRef; manifestSha256; tokenEstimate; tokenLimit; entries: { id; tier; trust; source; sha256; bytes; tokenEstimate }[]; reductions; exclusions; manifest: ArtifactRef }` (R9) |
| **`tool.requested`** | D | `{ toolCallId; tool; args: JsonValue /* sealed */; argsSha256 }` |
| **`tool.denied`** | D | `{ toolCallId; tool; stage: OpenEnum<'liveness'\|'schema'\|'capability'\|'path'\|'command'\|'network'\|'budget'\|'approval'>; ruleId; reason; overridable: boolean; evaluatedRules: string[]; approvalId? }` |
| `tool.rejected` | D | `{ engineToolCallId?; tool; cause: OpenEnum<'unknown-tool'\|'invalid-input'\|'output-truncated'>; message /* sealed */ }` — the ENGINE refused the call before the host saw it: no `toolCallId`, no gate, no rule ids (that is why it is not a `tool.denied`) |
| **`tool.started`** | D | `{ toolCallId; tool; effectId; decision: 'allow'\|'allow-once'\|'allow-for-run'; ruleId; grantId?; normalizedArgs: JsonValue; replayClass; sandbox: SandboxReport; replayOfApproval?: ApprovalId }` — `replayOfApproval` marks a host-side replay of an approved call (4.5) |
| `tool.progress` | E | `{ toolCallId; text?; bytes? }` |
| **`tool.completed`** | D | `{ toolCallId; tool; effectId; isError; exitCode?; signal?; timedOut; durationMs; waitedMs /* time the runtime waited for the host, from tool.call.delivered */; output: { sha256; bytes; truncated; preview; artifact? }; filesTouched: FileTouch[]; filteredPaths?: number /* hits dropped by output filtering, 2.7 */; replayed: boolean }` |
| **`file.read`** / **`file.written`** | D | `{ toolCallId; file: FileTouch; diffStat?: { added; removed } }` |
| **`file.changed`** | D | `{ slot; files: FileTouch[]; detectedBy: 'post-command-scan'\|'ledger-audit'; attributedTo?: ToolCallId }` |
| `check.started` / `check.completed` | D | `{ name; argv; slot }` / `CheckResult` |
| **`review.started`** | D | `{ phase; reviewRef: { ref; sha; treeDigest }; surfaces: SurfaceId[]; reviewers: AgentId[] }` |
| **`review.finding`** | D | `{ finding: Finding; reviewer: AgentRef; disposition: 'kept'\|'refuted'\|'deferred'\|'needs-investigation'\|'duplicate' }` |
| `review.completed` | D | `{ verdict: 'approved'\|'findings'\|'needs-human'; blocking: number; blockingItems: string[]; fingerprint: string; unreviewed: SurfaceId[]; counts: Record<Severity, number>; clean: boolean }` |
| **`review.approved`** | D | `{ reviewRef: { ref; sha; treeDigest }; waivers: { findingId; approvalId }[] }` |
| **`approval.requested`** | D | `ApprovalRequest` (R6) |
| **`approval.resolved`** | D | `{ approvalId; decision: 'allow-once'\|'allow-for-run'\|'deny'\|'expired'\|'superseded'; actor: Actor; commandId?; commandAuth?: { scheme: OpenEnum<'hmac-sha256'>; value: string }; grantId?; answer?: string; note? }` |
| **`budget.updated`** | D | `{ scope: { level: 'run'\|'phase'\|'agent'\|'provider'\|'tool'; id }; consumed: BudgetCounters; limit: BudgetCounters; threshold?: 50\|80\|100 }` (coalesced: thresholds + ≤ 1 per 5 s per scope) |
| `budget.exceeded` | D | `{ scope; counter: keyof BudgetCounters; limit; consumed }` |
| `quota.updated` | D | `{ provider; authMode; quota: QuotaInfo }` (on change only) |
| `auth.required` | D | `{ provider; cause: 'absent'\|'expired'\|'refresh-failed'\|'revoked'\|'entitlement'\|'mode-mismatch'\|'ambient-source'; cli: string }` |
| `retry.scheduled` | D | `{ target: { kind: 'agent'\|'model-request'\|'tool'\|'phase'; id }; attempt; maxAttempts; delayMs; cause: ErrorInfo }` |
| `escalation.applied` | D | `{ agent: AgentRef; step: EscalationStep; because: string }` |
| `git.worktree.created` / `.provisioned` / `.quarantined` / `.removed` | D | `{ slot; path; branch; baseSha; effectId }` / `{ slot; lockfileSha256; network: boolean; effectId }` / `{ slot; resetTo; patch: ArtifactRef; compensated: EffectId[] }` / `{ slot; path }` |
| `git.commit.created` | D | `{ slot; branch; sha; kind: 'result'\|'checkpoint'; treeDigest; paths: string[]; effectId }` |
| `git.merge.completed` / `.conflicted` | D | `{ from; into; mergeSha; treeDigest; effectId }` / `{ from; into; files: string[] }` |
| `repo.change.detected` | D | `{ slot; expected: string; actual: string; files: FileTouch[] }` |
| `lock.acquired` / `lock.released` / `lock.stolen` | D | `{ scope: 'project'\|'zone'\|'run'\|'integration'\|'slot'; key; mode: 'shared'\|'exclusive'; owner; fencingToken? }` |
| `command.accepted` / `.completed` / `.rejected` | D | `{ commandId; type: CommandType; actor /* as normalised by the host, 2.6.7 */; authVerified: true; scheme: OpenEnum<'hmac-sha256'> }` / `{ commandId; type; result: JsonValue }` / `{ commandId; type; error: ErrorInfo }` |
| **`error`** | D | `{ error: ErrorInfo; fatal: boolean }` |
| **`checkpoint.created`** | D | `{ atSequence; snapshotSha256; chainHash: string; chainMac: string; cause: 'phase-boundary'\|'interval'\|'pause'\|'shutdown'\|'pre-effect'\|'fatal' }` |
| `snapshot` | E | `{ document: RunSnapshotDocument; lastSequence }` — synthetic first line of every stream |
| `heartbeat` | E | `{ hostAlive: boolean; lastSequence }` — every 15 s on `--follow` |

**The one mapper, as a table** (`core/src/agents/supervisor/map.ts`, `satisfies`-total over both unions; both unions are frozen at G0, so the
table is frozen with them — the mapper written in Wave 3 discovers nothing):

| `RuntimeEvent` (2.2.5) | Protocol target | Notes |
|---|---|---|
| `agent.spawned`, `agent.started` | **`agent.spawned`**, **`agent.started`** | the host adds `AgentRef`, worktree, `authMode`, `runtimeRef` |
| `agent.turn.started` / `.completed` | same names (E / D) | — |
| `agent.message.started` / `.delta` / `.completed` | same names | text sealed; `stop` copied |
| `agent.message.accepted` | `agent.message.accepted` | — |
| `model.requested` / `model.responded` | **`model.requested`** / **`model.responded`** | the host stamps `expectedAuthMode`, `monetaryCost`, `billing` (3.7 layer 6); the engine's cost is never forwarded |
| `tool.call.requested` | **`tool.requested`** | emitted by `CohorteToolHost` stage 0, not by the mapper (the mapper asserts it exists) |
| `tool.call.rejected` | `tool.rejected` | never `tool.denied`: no gate ran |
| `tool.call.progress` | `tool.progress` (E) | — |
| `tool.call.delivered` | **not forwarded** | folded into `tool.completed.waitedMs` and the runtime snapshot |
| `agent.paused` / `agent.resumed` | `agent.state.changed{to:'paused', reason:'paused', pausedAt}` / `{to:'running', reason:'resumed'}` | — |
| `agent.exited` | **`agent.completed`** or **`agent.failed`** (+ `agent.state.changed`) | decided by the supervisor from `AgentExit` + the accepted result (2.5.4) |
| `runtime.warning` | `runtime.warning` | message sealed |

#### 2.3.4 Commands (spec 17.2)

```ts
export interface CommandEnvelope<T extends CommandType = CommandType> {     // [S]
  protocolVersion: '1.0';
  commandId: CommandId;                 // client-generated; THE idempotency key. Same id + same body = same outcome; same id + other body = conflict/command-id-reuse
  type: T; runId?: RunId; issuedAt: IsoInstant; actor: Actor;
  expectedSequence?: number;            // optimistic guard: reject if the run moved past this sequence
  payload: CommandPayloads[T];
  auth?: { scheme: OpenEnumOf<'hmac-sha256'>; value: string };   // REQUIRED on every mutating command. V3.0: value = hex HMAC-SHA256(projectKey, canonicalCommandBody(envelope)) where the
}                                       // canonical body is the envelope MINUS `auth` (§2.6.7). The field is scheme-neutral so asymmetric signatures (ADR-0022 "Revisit") are a MINOR.
export interface CommandPayloads {
  start:    { profile: PipelineProfile; spec?: { id: SpecId } | { path: string }; reviewTarget?: { ref: string } | { base: string; head: string } | { runId: RunId };
              withFix?: boolean; phases?: ActivePipelineState[]; modelOverrides?: Record<string /*role*/, ModelRef>; runtime?: string; fakeScript?: string;
              unattended: boolean; budgets?: Partial<BudgetCounters>; sandboxRequire?: 'native' | 'best-effort';
              consent?: { policySha256: Sha256; via: 'cli-flag' } };   // 2.10.1: `--trust-project-config` travels in the SIGNED start command, so the host's T04 re-check sees the same consent the CLI saw
  status:   { runId?: RunId };                                         // no runId => ProjectStatusDocument (R4 "current pipeline")
  inspect:  { target: { kind: 'agent'; agentId } | { kind: 'context'; agentId; incarnation: number } | { kind: 'approval'; approvalId } | { kind: 'effect'; effectId } | { kind: 'snapshot' } | { kind: 'locks' }
                    | { kind: 'diff'; surface?: SurfaceId } | { kind: 'artifact'; artifactId: ArtifactId; maxBytes?: number /* default 1 MiB, cap 3 MiB: stays under a 4 MiB one-shot client */; offset?: number } };
  tail:     { sinceSequence?: number; replay?: number; follow: boolean; ephemeral: boolean };
  pause:    { reason?: string };
  resume:   { acknowledge?: 'blocked-inspected'; raiseBudgets?: Partial<BudgetCounters>; takeover?: boolean };
  cancel:   { reason?: string; keepWorktrees: boolean };
  approve:  { approvalId: ApprovalId; scope: 'once' | 'run'; answer?: string /* required when the request carries `options`; must be one of them; echoed in the tool result */; note?: string };
  deny:     { approvalId: ApprovalId; note?: string };
  retry:    { target: { kind: 'phase'; state?: ActivePipelineState } | { kind: 'agent'; agentId: AgentId } };
  skip:     { phase: ActivePipelineState; justification: string };     // only if policy.skip lists that phase
  'run-tool': { agentId?: AgentId; tool: string; input: JsonValue; justification: string };   // admin; rejected unless policy.admin.runTool; still goes through the full gate chain
  reconcile:{ mode: 'plan' | 'apply' };                                // V3.0: apply is conflict-free and journaled
  shutdown: { graceMs: number };
  'agent.send': { agentId: AgentId; text: string; delivery: 'steer' | 'follow-up' };   // R11: optional, policy.steer.enabled, default false
}
export type CommandType = keyof CommandPayloads;
```

| Command | Route | Result |
|---|---|---|
| `status`, `inspect`, `tail` | **direct read** of the store by the CLI process; no inbox, no authenticator, works with no host alive, holds no lock (SIGKILL-safe). **They emit no result event** (D-23): a pure reader writes nothing; their result is the document / stream itself | `RunSnapshotDocument` \| `ProjectStatusDocument` / `InspectDocument` / NDJSON stream |
| `start` | CLI validates, then **one `transact('project', null, …)`**: `putRun(row IDLE)` + `tx.enqueueCommand(signed start)` (2.4), spawns the detached host (4.7), returns `{ runId }` | `command.completed{result:{runId}}` once `pipeline.started` is committed |
| `pause`, `resume`, `cancel`, `approve`, `deny`, `retry`, `skip`, `shutdown`, `agent.send`, `run-tool` | **inbox**: signed, `INSERT … ON CONFLICT(command_id) DO NOTHING`; poke file; CLI waits ≤ `--wait` (default 8 s, under François' 10 s kill). Any of these spawns a detached host when none is alive and the command needs one | `command.accepted` then `command.completed` or `command.rejected`; the CLI prints a `CommandResultDocument`. A bad or missing authenticator is `command.rejected{security/command-auth-invalid}` and is never applied |
| `reconcile` | CLI-local (no run); emits no event (D-23) | `ReconcilePlan` document (`@cohorte/project-model/contract`) |

Every command type has a CLI verb, because one-shot CLI spawns are the only V3.0 transport (D5): `cohorte inspect <run> --agent|--context|
--approval|--effect|--snapshot|--locks|--diff|--artifact <id>`, `cohorte shutdown <run> [--grace-ms N]`, `cohorte run-tool <run> --tool … --input
… --justification …` and `cohorte send <run> <agent> <text> [--steer|--follow-up]` (= `agent.send`). The last two answer
`configuration/phase-not-available` unless `policy.admin.runTool` / `policy.steer.enabled` is on (both are loosening keys, 2.10.1).

Controller exit codes: 0 completed · 3 rejected · 4 accepted-but-pending at `--wait` expiry (not an error: the inbox is durable) · 2 usage.
`pause` on an already suspended run and `resume` on an already active run complete with `{ noop: true }`. Observer exit codes: 4.7.

#### 2.3.5 Snapshot tree document (`cohorte status <run> --json`, `inspect`, first stream line) — R2

```ts
export interface RunSnapshotDocument {                   // [S] schemas/run-state.schema.json ; computable from the store alone
  documentVersion: 1; protocolVersion: '1.0'; cohorteVersion: string; generatedAt: IsoInstant; lastSequence: number;
  run: {
    runId: RunId; profile: PipelineProfile; title: string; spec: { id: SpecId; kind: string; sha256: Sha256 };
    state: PipelineState; status: NodeStatus; since: IsoInstant; resumeTo?: ActivePipelineState; stop?: StopRecord; lastError?: ErrorInfo;
    iteration: { fixRounds: number; maxFixRounds: number; reviewRounds: number };
    host: { hostId?: string; alive: boolean; heartbeatAt?: IsoInstant; pid?: number };
    git: { base: { branch: string; sha: string }; integrationBranch: string; integrationHead?: string; approvedTreeDigest?: string };
    plan: RunPlan; snapshotDigest: Sha256; startedAt: IsoInstant; endedAt?: IsoInstant;
  };
  phases: PhaseNode[];                                    // table order for the profile, not-yet-run phases as 'pending'
  approvals: { pending: ApprovalView[]; resolved: number };
  budgets: { scope: { level: string; id: string }; consumed: BudgetCounters; limit: BudgetCounters }[];
  usage: { tokens: TokenUsage; monetaryCost: MonetaryCost; byProvider: { provider: string; authMode: AuthMode; billing: 'plan-limits' | 'metered'; tokens: TokenUsage; quota: QuotaInfo; accountLabel?: string }[] };
  locks: { scope: string; key: string; mode: string }[]; inDoubtEffects: EffectId[];
}
export interface PhaseNode { state: ActivePipelineState; label: string; status: NodeStatus;
  runs: { phaseRunId: PhaseRunId; iteration: number; status: NodeStatus; startedAt?: IsoInstant; endedAt?: IsoInstant; outcome?: string; agents: AgentNode[]; checks: CheckResult[] }[]; }
export interface AgentNode { agentId: AgentId; role: string; surface?: SurfaceId; label: string; status: NodeStatus; lifecycle: AgentState; attempt: number; incarnation: number;
  model: { requested: ModelRef; effective?: { provider: string; model: string } }; authMode?: AuthMode; worktree?: string; usage: BudgetCounters;
  summary?: string; lastError?: ErrorInfo; pendingApproval?: ApprovalId; runtimeRef?: RuntimeRef; }
export interface ApprovalView { approvalId: ApprovalId; kind: string; agentId?: AgentId; what: string /* <=512, sealed */; since: IsoInstant; expiresAt?: IsoInstant; cli: string; }
export interface ProjectStatusDocument { documentVersion: 1; protocolVersion: '1.0'; project: { id: string; root: string };
  runs: Pick<RunSnapshotDocument['run'], 'runId'|'profile'|'title'|'state'|'status'|'since'|'startedAt'|'endedAt'|'stop'>[]; pendingApprovals: ApprovalView[]; }

// ── one [S] document per `--json` output (spec 21 "chaque commande propose … --json stable"); all in protocol/src/documents.ts, all generated into schemas/ ──
export type InspectDocument = { documentVersion: 1; protocolVersion: '1.0'; runId: RunId; lastSequence: number } & (
  | { kind: 'agent'; agent: AgentNode; grantsDigest: Sha256; tools: string[]; incarnations: { n: number; state: string; startedAt?: IsoInstant; endedAt?: IsoInstant; stop?: string; reason?: string }[] }
  | { kind: 'context'; agentId: AgentId; incarnation: number; context: Payload<'context.built'> }                     // R9
  | { kind: 'approval'; request: ApprovalRequest; status: string; decision?: Payload<'approval.resolved'> }           // R6
  | { kind: 'effect'; effect: { effectId: EffectId; kind: string; replayClass: string; state: string; toolCallId?: ToolCallId; slot?: string; request: JsonValue; result?: JsonValue; error?: ErrorInfo } }
  | { kind: 'snapshot'; document: RunSnapshotDocument }
  | { kind: 'locks'; locks: { scope: string; key: string; mode: string; owner: string; leaseExpiresAt: IsoInstant }[] }
  | { kind: 'diff'; diff: RunDiffDocument }
  | { kind: 'artifact'; artifact: ArtifactRef; offset: number; bytes: number; truncated: boolean; encoding: 'utf8' | 'base64'; content: string /* sealed at write time; capped by maxBytes */ });
export interface RunDiffDocument { documentVersion: 1; runId: RunId; base: { branch: string; sha: string }; head: { branch: string; sha: string; treeDigest: string };
  surfaces: { surface: SurfaceId | 'shared'; files: FileTouch[]; stat: { added: number; removed: number }; patch: ArtifactRef /* fetch with inspect{kind:'artifact'} */ }[]; }   // spec 17.1 "diffs"; `cohorte diff --json`
export interface CommandResultDocument { documentVersion: 1; commandId: CommandId; type: CommandType; status: 'completed' | 'rejected' | 'pending'; result?: JsonValue; error?: ErrorInfo; lastSequence?: number; }
export interface DoctorReport { documentVersion: 1; cohorteVersion: string; generatedAt: IsoInstant; ok: boolean;
  checks: { id: string; status: OpenEnumOf<'ok' | 'warning' | 'error' | 'skipped'>; summary: string; detail?: string; remediation?: string }[];
  sandbox: JsonValue; runtimeCapabilities: JsonValue; }   // the two blocks are SandboxCapabilities / RuntimeCapabilities VERBATIM, carried opaque: protocol imports neither (C4). Their own schemas are published beside this one
export interface AuthStatusDocument { documentVersion: 1; generatedAt: IsoInstant; runtime: { id: string; version: string };
  providers: { provider: string; state: string; subscription: boolean; billing: 'plan-limits' | 'metered' | 'unknown'; source?: string; accountLabel?: string; accountLabelNote?: string; caveat?: string; checkedAt: IsoInstant }[]; }   // declared here a second time (not imported from runtime-contract: C4)
```

`--panel=<runs|approvals|agents|usage>` and `--format=line` are presentation adapters in `apps/cli` over these documents and over
`Envelope.summary` — not protocol (keeps today's François panels alive, D5). Panel modes always exit 0. `reconcile --plan --json` prints the
`ReconcilePlan` of `@cohorte/project-model/contract`; `config validate --json`, `spec validate --json`, `migrate --check --json` and `policy
explain --json` print a `CommandResultDocument` whose `result` is respectively the issue list, the issue list, the `MigrationReport` and a
`PolicyVerdict` (`policy-verdict.schema.json`).

#### 2.3.6 Human-facing text is sanitised once, in one place

Agent-controlled text reaches a human terminal: `write_file` content in a diff preview, `approval_request` questions, summaries, finding
texts, command output tails. A string carrying `ESC [ 2 K` or a C1 CSI could rewrite what the human reads at the moment of approving. Rule:
(1) `EventWriter` refuses C0/C1 in `summary` (replaced by U+FFFD before validation); (2) **every** human-facing string passes through
`render/sanitize.ts` in `apps/cli`, which renders C0 and C1 characters other than `\n` and `\t` as visible escapes (`\x1b` → `␛`, others →
`\xNN`) — in the tree view, `--format=line`, the panels and approval previews; (3) `--json` output is never altered (JSON string escaping
already neutralises control characters for a parser). Test S-54.

### 2.4 `@cohorte/persistence` — `StateStore`

What makes the abstraction real (spec 20 "permettre un store fichier/remote ultérieur"): **asynchronous boundary, synchronous transaction body.**
`transact()` returns a promise, `body` is a plain synchronous function over a `StoreTx`. With `node:sqlite` this is `BEGIN IMMEDIATE; assert
fencing; body(tx); COMMIT` — no `await` can interleave inside a state-machine step. A file or remote store implements the same contract
optimistically (load aggregate → run `body` in memory → compare-and-swap on `runs.version`). `MemoryStateStore` is the second implementation that
keeps the contract honest, and both pass the same conformance suite (delivered complete in Wave 0, parameterised by `() => StateStore`).
**Stores are dumb**: `core` writes projections explicitly in the same transaction as the events that justify them; no store contains a reducer.

```ts
import type { Envelope, EventType, CommandEnvelope, PipelineState, TransitionReason, Actor, GuardOutcome } from '@cohorte/protocol';
import type { Sealed, SealedJson } from '@cohorte/base';

export type DurableEventType = { [K in EventType]: Envelope<K>['durability'] extends 'durable' ? K : never }[EventType];
export type DurableEnvelope = Envelope<DurableEventType>;
/** What core hands to the store: everything except what the store assigns — and ONLY after Redactor sealed it (I7). */
export type EventDraft = Omit<DurableEnvelope, 'sequence' | 'sub' | 'durability'>;
export type SealedEventDraft = Sealed<EventDraft>;

export interface LeaseToken { readonly lockId: string; readonly runId: RunId; readonly hostId: string; readonly fencingToken: number; }
export type ReplayClass = 'idempotent' | 'verifiable' | 'at-most-once';
export type EffectState = 'intent' | 'done' | 'failed' | 'in-doubt' | 'compensated';
export type EffectKind =
  | 'fs.snapshot.materialize' | 'git.branch.create' | 'git.ref.create' | 'git.worktree.add' | 'git.worktree.remove' | 'git.worktree.reset'
  | 'git.commit' | 'git.merge' | 'provision.command' | 'check.command' | 'agent.spawn'
  | 'tool.read' | 'tool.write_file' | 'tool.patch_file' | 'tool.run_command' | 'tool.network_request' | 'tool.git_commit';

export interface StateStore {
  readonly kind: string;                                                   // 'sqlite' | 'memory'
  open(): Promise<StoreInfo>;                                              // refuses (corruption/incompatible-schema) rather than guessing; never auto-migrates
  close(): Promise<void>;
  migrate(mode: 'check' | 'apply'): Promise<MigrationReport>;              // numbered, monotonic, sha256-pinned; 'apply' takes the exclusive project lock + backup()
  backup(toPath: string): Promise<void>;

  // ── the single write path ─────────────────────────────────────────────
  /** lease != null: the FIRST statement asserts locks.fencing_token = lease.fencingToken, else throws conflict/lease-lost (I6). body MUST be synchronous
   *  (a returned thenable is rejected). lease == null is legal only for scope 'project' (init, migrate, lock acquisition, and RUN CREATION: inside
   *  `transact('project', null, …)` the body may call `putRun` for a runId that does not exist yet and `enqueueCommand` — and nothing else run-scoped)
   *  and for the stand-alone `enqueueCommand` below. */
  transact<T>(scope: { runId: RunId } | 'project', lease: LeaseToken | null, body: (tx: StoreTx) => T, opts?: { expectedSequence?: number }): Promise<T>;

  // ── reads: lock-free, safe to SIGKILL the reader at any instant ───────
  getRun(runId: RunId): Promise<RunRecord | undefined>;
  listRuns(q: { states?: PipelineState[]; limit: number; offset: number }): Promise<RunRecord[]>;
  readEvents(runId: RunId, q: { afterSequence: number; limit: number; types?: DurableEventType[] }): Promise<DurableEnvelope[]>;   // always paginated by sequence
  loadSnapshot(runId: RunId): Promise<StoredSnapshot | undefined>;
  readRunTree(runId: RunId): Promise<RunTreeRows>;                         // runs + phases + agents + incarnations + worktrees + approvals + budgets + locks
  listPendingApprovals(runId?: RunId): Promise<ApprovalRecord[]>;
  listEffects(runId: RunId, q: { states: EffectState[] }): Promise<EffectRecord[]>;
  readLedger(runId: RunId, slot: string): Promise<LedgerEntry[]>;
  getArtifact(runId: RunId, id: ArtifactId): Promise<ArtifactRecord | undefined>;
  verifyChain(runId: RunId, key?: Uint8Array): Promise<{ ok: true; events: number; anchors: number } | { ok: false; firstBadSequence: number; reason: 'hash-mismatch' | 'gap' | 'duplicate' | 'anchor-mac' }>;

  // ── command inbox (D5): the only write a non-owner process performs ───
  enqueueCommand(cmd: CommandEnvelope): Promise<{ status: 'enqueued' | 'duplicate' | 'id-reuse-conflict'; record: CommandRecord }>;
  pendingCommands(runId: RunId): Promise<CommandRecord[]>;                 // status 'pending', ordered by created_at, command_id
  getCommand(id: CommandId): Promise<CommandRecord | undefined>;

  // ── locks / leases (spec 15, 11.3) ────────────────────────────────────
  acquireLock(req: LockRequest): Promise<{ ok: true; lease: LeaseToken } | { ok: false; heldBy: LockRecord[] }>;
  stealLock(req: LockRequest, expected: LockRecord): Promise<LeaseToken>;  // fencingToken = old + 1; emits lock.stolen through the caller
  renewLock(lockId: string, ttlMs: number): Promise<boolean>;              // false = lease lost: the host MUST stop producing effects
  releaseLock(lockId: string): Promise<void>;
  listLocks(q?: { scope?: LockScope }): Promise<LockRecord[]>;
}

/** Synchronous. Every method fully applies inside the enclosing transaction or throws (rollback). */
export interface StoreTx {
  appendEvents(drafts: readonly SealedEventDraft[]): DurableEnvelope[];    // assigns sequence = last+1…, prev_hash/hash; bumps runs.last_sequence, runs.version
  recordTransition(t: TransitionRecord): 'recorded' | 'duplicate';         // UNIQUE(run_id, idempotency_key)
  putRun(r: RunRecord): void;            patchRun(runId: RunId, p: Partial<RunRecord>): void;
  putPhase(p: PhaseRecord): void;        putAgent(a: AgentRecord): void;   putIncarnation(i: IncarnationRecord): void;
  putWorktree(w: WorktreeRecord): void;  putLedger(e: LedgerEntry): void;  clearLedger(runId: RunId, slot: string, upToEffectSeq: number): void;
  putApproval(a: ApprovalRecord): 'created' | 'exists';                    // UNIQUE(run_id, idempotency_key)
  resolveApproval(id: ApprovalId, d: ApprovalDecisionRecord): 'resolved' | 'already-resolved';
  findGrant(runId: RunId, grantKey: string): ApprovalRecord | undefined;   // live allow-for-run, or unconsumed allow-once
  setBudget(b: BudgetRecord): void;      putArtifact(a: ArtifactRecord): void;   putFinding(f: FindingRecord): void;
  // effect journal (4.1)
  beginEffect(e: EffectIntent): { status: 'started'; effectId: EffectId } | { status: 'already-done'; record: EffectRecord } | { status: 'open'; record: EffectRecord /* intent | in-doubt */ };
  completeEffect(id: EffectId, result: SealedJson, post?: { treeDigest?: string; head?: string }): void;
  failEffect(id: EffectId, error: ErrorInfo): void;
  markEffectInDoubt(id: EffectId, note: string): void;
  compensateEffects(ids: EffectId[], byEffect: EffectId): void;
  // inbox
  enqueueCommand(cmd: CommandEnvelope): 'enqueued' | 'duplicate' | 'id-reuse-conflict';   // same row and same rules as StateStore.enqueueCommand, but INSIDE a transaction:
                                                                           // this is what makes `start` = { run row IDLE + signed start command } ONE atomic write (4.3 #1)
  claimCommand(id: CommandId, hostId: string): boolean;
  finishCommand(id: CommandId, outcome: 'completed' | 'rejected', resultEventId: EventId): void;
  writeSnapshot(s: StoredSnapshot): void;                                  // AFTER the events it covers (spec 11.3); keep last 3
  // synchronous read-modify-write helpers
  run(): RunRecord;  agent(id: AgentId): AgentRecord | undefined;  incarnation(id: AgentId, n: number): IncarnationRecord | undefined;
  worktree(slot: string): WorktreeRecord | undefined;  approval(id: ApprovalId): ApprovalRecord | undefined;
  effectByKey(key: string): EffectRecord | undefined;  budget(level: string, scopeId: string): BudgetRecord | undefined;
}

export interface EffectIntent {
  runId: RunId; idempotencyKey: string; kind: EffectKind; replayClass: ReplayClass;
  agentId?: AgentId; toolCallId?: ToolCallId; slot?: string;
  request: SealedJson; verify: SealedJson;                                 // data the kind-specific verifier needs after a crash
  preState?: { checkpointSha?: string; ledgerSha256?: Sha256; beforeSha256?: Sha256; treeDigest?: string /* the grant binding of an asked COMMAND, 4.5 */ };
  consumesGrant?: ApprovalId;                                              // allow-once is consumed in THIS transaction: exactly once across a crash
}
export interface TransitionRecord { transitionId: string; runId: RunId; defId: string; tableVersion: number; from: PipelineState; to: PipelineState;
  reason: TransitionReason; actor: Actor; guards: GuardOutcome[]; effects: string[]; idempotencyKey: string; eventId: EventId; }   // spec 11.1: all eight fields
export interface LedgerEntry { runId: RunId; slot: string; path: string; sha256: Sha256 | null /* null = deleted */; effectId: EffectId; effectSeq: number; }
export interface StoredSnapshot { runId: RunId; atSequence: number; schemaVersion: number; cohorteVersion: string; stateSha256: Sha256; state: SealedJson; }
export type LockScope = 'project' | 'zone' | 'run' | 'integration' | 'slot' | 'migration';
export interface LockOwner { runId?: RunId; hostId: string; pid: number; startToken: string; }
export interface LockRequest { scope: LockScope; key: string; mode: 'shared' | 'exclusive'; owner: LockOwner; ttlMs: number; zones?: string[]; }
export interface SqlDriver { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): { changes: number | bigint }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }; close(): void; }

export interface BlobStore { put(bytes: Uint8Array): Promise<{ sha256: Sha256; bytes: number }>; read(sha256: Sha256): Promise<Uint8Array>; /* re-verifies the hash on EVERY read: security/pin-tampered */ has(sha256: Sha256): Promise<boolean>; }
export interface RunFiles { dir(runId: RunId, ...sub: string[]): string; agentDir(runId: RunId, agentId: AgentId, incarnation: number): string; writeArtifact(runId: RunId, rel: string, bytes: Uint8Array): Promise<ArtifactRecord>; }
export interface EphemeralSpool { append(runId: RunId, line: string): void; tail(runId: RunId, after: { sequence: number; sub: number }, signal: AbortSignal): AsyncIterable<string>; }
```

**Every port of this package has an in-memory implementation in Wave 0**, not only the store: `createMemoryBlobStore`, `createMemoryRunFiles`
and `createMemorySpool` live beside `MemoryStateStore` under `packages/persistence/src/memory/**` and are handed out by testkit's
`store-factory`. The file-backed ones arrive in Wave 3, but their first consumers (`EventWriter`'s spool port, tool-host stage-8 artifacts, the
two walking skeletons) are in Waves 1-2: without shared fakes each unit would write a private one and they would diverge. Three small
conformance suites (`blobStoreConformance`, `runFilesConformance`, `spoolConformance`, same subpath as the store suite) are written in Wave 0,
pass on the memory implementations, and are re-run unchanged on the file-backed ones.

**Location.** One SQLite file per project: `<main checkout>/.cohorte/state/cohorte.db`, resolved through `git rev-parse --git-common-dir` so every
worktree addresses the same store (spec 14's `state/{events,snapshots,locks}` are tables; `state/runs/<runId>/` holds files; `state/cas/` is the
blob store). Pragmas: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `trusted_schema=OFF`, `busy_timeout=5000`,
`enableDefensive(true)`; writers always `BEGIN IMMEDIATE`. `doctor` checks the directory is on a local filesystem. The state directory is in the
`denyRead` set of every executor profile and inside no write root (worktrees are outside the repository by default, §5.1).

**DDL** (`migrations/state/0001_init.sql`, frozen in Wave 0). Tables: `migrations`, `meta`, `runs`, `events`, `transitions`, `phases`, `agents`,
`agent_incarnations`, `worktrees`, `worktree_ledger`, `effects`, `approvals`, `budgets`, `artifacts`, `findings`, `commands`, `locks`,
`snapshots` — spec 20's nine minimum concepts are all present. Load-bearing columns (full column lists are the record types above; every table is
`STRICT`, JSON columns carry `CHECK (json_valid(…))`):

```sql
-- profile: NO SQL CHECK. ADR-0018 is provisional: the known profiles are validated in TypeScript (table registry), so a fourth profile is not a state migration.
-- The six columns marked (*) are NULL while the run is IDLE: only the HOST can compute them, behind the T04 guards snapshot.captured, runtime.pin-valid and
-- repo.base-resolved, and it fills them in the T04 transaction together with pipeline.started. The CLI writes what it knows when it creates the row:
-- profile, table_version, spec, title, base_branch (the requested one) and pinned_install_dir (NOT NULL: a run belongs to its install from its first byte, 6.3).
CREATE TABLE runs ( run_id TEXT PRIMARY KEY, profile TEXT NOT NULL, table_version INTEGER NOT NULL,
  spec_id TEXT NOT NULL, spec_sha256 TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, resume_to TEXT, stop_json TEXT, last_error_json TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0, last_hash TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
  snapshot_digest TEXT /* (*) */, runtime_pin_json TEXT /* (*) */, plan_json TEXT /* (*) */, pinned_install_dir TEXT NOT NULL,
  base_branch TEXT NOT NULL, base_sha TEXT /* (*) */, integration_branch TEXT /* (*) */, integration_head TEXT, approved_tree_digest TEXT, skip_waivers_json TEXT, zones_json TEXT /* (*) */,
  CHECK (state IN ('IDLE','CANCELLED','FAILED') OR (snapshot_digest IS NOT NULL AND runtime_pin_json IS NOT NULL AND plan_json IS NOT NULL AND base_sha IS NOT NULL AND integration_branch IS NOT NULL AND zones_json IS NOT NULL)),
  host_id TEXT, host_pid INTEGER, host_start_token TEXT, host_heartbeat_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, pause_requested INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL, cohorte_version TEXT NOT NULL, purgeable INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT ) STRICT;

CREATE TABLE events ( run_id TEXT NOT NULL REFERENCES runs(run_id), sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, timestamp TEXT NOT NULL, source TEXT NOT NULL,
  phase_run_id TEXT, agent_id TEXT, causation_id TEXT, severity TEXT NOT NULL, summary TEXT NOT NULL,
  envelope TEXT NOT NULL CHECK (json_valid(envelope)),          -- the full SEALED envelope, canonical JSON: the hashed unit
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL,                   -- hash = sha256(prev_hash || '\n' || envelope): local append-only journal (spec 23)
  PRIMARY KEY (run_id, sequence) ) STRICT, WITHOUT ROWID;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events WHEN (SELECT purgeable FROM runs WHERE run_id = OLD.run_id) = 0
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE effects ( effect_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL, replay_class TEXT NOT NULL CHECK (replay_class IN ('idempotent','verifiable','at-most-once')),
  state TEXT NOT NULL CHECK (state IN ('intent','done','failed','in-doubt','compensated')),
  agent_id TEXT, tool_call_id TEXT, slot TEXT, request_json TEXT NOT NULL, verify_json TEXT NOT NULL, pre_state_json TEXT,
  result_json TEXT, error_json TEXT, consumes_grant TEXT, compensated_by TEXT, fencing_token INTEGER NOT NULL,
  intent_seq INTEGER NOT NULL, done_seq INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (run_id, idempotency_key) ) STRICT;
CREATE INDEX effects_open ON effects(run_id, state) WHERE state IN ('intent','in-doubt');

CREATE TABLE approvals ( approval_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL, agent_id TEXT, incarnation INTEGER, tool_call_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','allow-once','allow-for-run','deny','expired','superseded')),
  request_json TEXT NOT NULL,                                    -- ApprovalRequest incl. the NORMALISED pending call
  grant_key TEXT NOT NULL,                                       -- sha256(tool | normalised call | pre-state binding): what a decision is valid for (4.5).
                                                                 --   binding = target beforeSha256 (write/patch) | the slot's content-addressed treeDigest (command): NEVER a commit sha
  decision_json TEXT, command_auth_json TEXT,                    -- actor, commandId, answer, note, decidedAt + {scheme,value} of the resolving command (spec 23 "signées/loggées")
  consumed_by_effect TEXT,                                       -- allow-once: set in the intent transaction of the consuming effect (live call OR host-side replay, 4.5)
  requested_seq INTEGER NOT NULL, resolved_seq INTEGER, expires_at TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
  UNIQUE (run_id, idempotency_key) ) STRICT;

CREATE TABLE commands ( command_id TEXT PRIMARY KEY, run_id TEXT, type TEXT NOT NULL, body_sha256 TEXT NOT NULL, envelope_json TEXT NOT NULL, auth_scheme TEXT, auth_value TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','completed','rejected')), claimed_by TEXT, result_event_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL ) STRICT;

CREATE TABLE locks ( lock_id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('shared','exclusive')),
  owner_run_id TEXT, owner_host_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_start_token TEXT NOT NULL,
  fencing_token INTEGER NOT NULL, zones_json TEXT, lease_expires_at TEXT NOT NULL, acquired_at TEXT NOT NULL ) STRICT;   -- overlap decided inside BEGIN IMMEDIATE

CREATE TABLE worktrees ( run_id TEXT NOT NULL REFERENCES runs(run_id), slot TEXT NOT NULL, path TEXT NOT NULL, branch TEXT, base_sha TEXT NOT NULL,
  checkpoint_sha TEXT NOT NULL, last_tree_digest TEXT, lockfile_sha256 TEXT, provision_key TEXT, deps_manifest_sha256 TEXT /* 5.7: digest of the provisioned dependency tree */, holder_agent_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('intent','ready','held','in-doubt','quarantined','removed')), PRIMARY KEY (run_id, slot) ) STRICT;
CREATE TABLE worktree_ledger ( run_id TEXT NOT NULL, slot TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT, effect_id TEXT NOT NULL, effect_seq INTEGER NOT NULL,
  PRIMARY KEY (run_id, slot, path) ) STRICT;                     -- dirty paths since the last Cohorte commit, each with the content hash Cohorte expects (4.4)
```

`cohorte doctor --verify-state` rebuilds the projections from the log through `core`'s `evolve` into a `MemoryStateStore`, diffs them against the
SQLite projections (`corruption/projection-mismatch`), verifies the hash chain and the MAC anchors (`checkpoint.created.chainMac`) and the
authenticator (`command_auth_json`) of every resolved approval.

### 2.5 `@cohorte/core`

Shape: **functional core, imperative shell.** Pure: `evolve(state, durableEvent) -> RunState`, `nextStep(state, table) -> Step`, guards,
`decideAfterReview`, `decideAfterTest`, `checkGlobalStops`, `nextEscalation`, review math, grant computation, snapshot-document projection.
Shell: `RunEngine`, `GenericPhaseExecutor`, `CheckPhaseExecutor`, `AgentSupervisor`, `CohorteToolHost`, `EventWriter`, `EffectJournal`,
`ApprovalService`, `WorktreeService`, `Provisioner`, `RunSnapshotter`/`PinReader`, `Resumer`. The shell talks only to the ports of 1.2.
**These internal ports are frozen in Wave 0** (`core/src/contract/internal.ts`), which is what lets five core units run in parallel.

```ts
export interface EventWriter { append(tx: StoreTx, drafts: EventDraftInput[]): DurableEnvelope[]; ephemeral(runId: RunId, e: EphemeralInput): void; }
                              // strict-validate -> summary/severity (C0/C1 stripped, 2.3.6) -> Redactor.seal -> tx.appendEvents. A redactor exception replaces the event by error{security/redaction-failed}.
                              // ephemeral(): queued behind the pending durable drafts of the same agent and stamped (sequence, sub) only after that batch commits (2.3.2 ordering rule).
export interface EffectJournal { run<R extends JsonValue>(lease: LeaseToken, spec: EffectSpec<R>, signal: AbortSignal): Promise<{ status: 'done' | 'replayed'; result: R }>; }
export interface EffectSpec<R> { intent: Omit<EffectIntent, 'request' | 'verify'> & { request: JsonValue; verify: JsonValue };
  before: EventDraftInput[]; perform(signal: AbortSignal): Promise<{ result: R; after: EventDraftInput[]; post?: { treeDigest?: string; head?: string }; ledger?: LedgerEntry[] }>; }
export interface ApprovalService { request(tx: StoreTx, draft: ApprovalDraft): ApprovalId; await(id: ApprovalId, signal: AbortSignal): Promise<ApprovalDecisionRecord>; grantFor(tx: StoreTx, grantKey: string): ApprovalRecord | undefined;
  /** 4.5 parked path: resolved-allow approvals of this agent whose stored call was never executed (requester gone). Read-only; the replay itself is ToolHostReplay's. */
  approvedUnconsumed(runId: RunId, agentId: AgentId): Promise<ApprovedCall[]>; }
export interface ApprovedCall { approvalId: ApprovalId; call: RuntimeToolCall /* the ORIGINAL call: same toolCallId, same ordinal */; grantKey: string; answer?: string; }
/** Implemented by CohorteToolHost next to handleToolCall. Re-runs stages 1-5 on the stored call, recomputes the pre-state binding, and ONLY if the grant key still matches
 *  executes it through the journal under the ORIGINAL idempotency key (`tool:<runId>:<agentId>:<inc>:<ordinal>`), consuming the grant in the intent tx. Never opens an ask. */
export interface ToolHostReplay { replayApproved(lease: LeaseToken, approved: ApprovedCall, signal: AbortSignal): Promise<{ outcome: 'executed' | 'binding-changed' | 'denied-by-gate'; result?: RuntimeToolResult }>; }
export interface AgentSupervisor { runAgents(plans: AgentPlan[], ctx: PhaseRunContext): Promise<AgentResult[]>; }     // spawn by key, roll-call, retry/escalation, nudges, the ONE RuntimeEvent -> Envelope mapper (`satisfies`-total)
export interface ContextBuilder { build(plan: AgentPlan, pin: PinReader, workspace: WorkspaceReader): Promise<{ manifest: ContextManifest; systemPrompt: PromptRef; task: TaskInput }>; }
export interface RunSnapshotter { capture(input: SnapshotInput): Promise<RunSnapshotManifest>; verify(manifest: RunSnapshotManifest): Promise<Result<true, ErrorInfo>>; }
export interface PinReader { read(logicalPath: string): Promise<Uint8Array>; ref(logicalPath: string): { sha256: Sha256; bytes: number; path: string }; }   // serves from the CAS, re-hashes on every read
export interface WorktreeService { acquire(slot: string, forAgent: AgentId): Promise<WorktreeRecord>; checkpoint(slot: string, cause: CheckpointCause): Promise<string>; release(slot: string): Promise<void>; audit(slot: string): Promise<LedgerAudit>; quarantineAndReset(slot: string, because: EffectId): Promise<ArtifactRef>;
  resetClean(slot: string, to: string): Promise<void>; }                                                               // journaled git.worktree.reset + clean; used on `_integration` after every check sequence (2.5.2)
export interface Provisioner { ensure(slot: string): Promise<'fresh' | 'reused'>; verifyDependencies(slot: string): Promise<Result<true, ErrorInfo>>; }   // §5.7; verify = the dependency manifest digest, before each TEST
export interface PhaseExecutor { execute(ctx: PhaseRunContext): Promise<PhaseOutcome>; }
export interface Resumer { recover(runId: RunId, host: HostContext): Promise<ResumeReport>; }                          // §4.4
export interface RunEngine { run(runId: RunId, host: HostContext): Promise<StopRecord>; }
```

#### 2.5.1 The versioned transition table (spec 11.1)

```ts
export interface TransitionDef {                          // a row of the code table: from, to, reason, actor, preconditions, effects
  readonly id: string;                                    // stable: "T12"
  readonly from: PipelineState | '*active' | '*suspended';
  readonly to: PipelineState | '*resumeTo';
  readonly reason: TransitionReason; readonly actor: 'system' | 'human' | 'either';
  readonly preconditions: readonly GuardId[];             // ALL must hold; evaluated in order; first failure is reported
  readonly effects: readonly TransitionEffectId[];        // declarative; each is executed through the effect journal
}
export interface TransitionTable { readonly profile: PipelineProfile; readonly version: number; readonly initial: 'IDLE'; readonly phases: readonly ActivePipelineState[]; readonly rows: readonly TransitionDef[]; }
// persisted instance = persistence.TransitionRecord: adds idempotencyKey = `${runId}:${profile}@${tableVersion}:${defId}:${fromPhaseRunId ?? '-'}:${discriminator}` and eventId
export type Guard = (ctx: GuardContext) => GuardOutcome;  // PURE and synchronous; facts are gathered BEFORE by collectFacts(ids) and recorded in the transition record
```

`feature@1` (`packages/core/src/pipeline/tables/feature.v1.ts`, `as const satisfies TransitionTable`):

| id | from → to | reason | actor | preconditions (guards) | effects |
|---|---|---|---|---|---|
| T01 | IDLE → BRAINSTORM | start | human | `input.is-idea`, `phase.available(BRAINSTORM)` *(false in V3.0)* | — |
| T02 | BRAINSTORM → SPEC | ready | human | `brainstorm.output-valid` | — |
| T03 | SPEC → PREFLIGHT | ready | human | `spec.schema-valid`, `spec.frozen` | `record-spec-hash` |
| T04 | IDLE → PREFLIGHT | start | either | `spec.schema-valid`, `spec.frozen`, `host.not-root`, `host.outside-target`, `config.trust-satisfied` *(2.10.1)*, `snapshot.captured`, `runtime.pin-valid`, `runtime.platform-supported`, `auth.plan-satisfied`, `billing.consented`, `sandbox.meets-policy`, `repo.base-resolved`, `locks.project+zones-held` | `create-integration-branch` |
| T05 | PREFLIGHT → BUILD | ready | system | `readiness.in(READY,RESERVATIONS)`, `contract.present-or-exempt`, `surfaces.all-owned`, `budget.available` | — |
| T06 | PREFLIGHT → WAITING_APPROVAL | needs-human | system | `readiness.not-ready` or `surfaces.unowned` | `open-approval(spec-not-ready\|unowned-path)` |
| T07 | BUILD → TEST | built | system | `agents.all-completed`, `outputs.schema-valid`, `diff.within-ownership`, `integration.merged`, `tree.digest-recorded` | — |
| T08 | TEST → REVIEW | tests-pass | system | `checks.all-passed`, `checks.digest-equals-integration` | `mint-review-ref` |
| T09 | TEST → FIX | tests-fail | system | `checks.failed-non-environmental`, `loop.may-continue` | `synthesize-check-findings` |
| T10 | REVIEW → SHIP | review-approved | system | `review.nothing-to-fix`, `review.no-unreviewed`, `review.leftovers-parked-or-waived`, `reviewref.digest-equals-integration` | `record-approved-digest` |
| T11 | REVIEW → FIX | review-findings | system | `review.has-fix-items`, `loop.may-continue`, `review.no-contract-change` | — |
| T12 | REVIEW → WAITING_APPROVAL | needs-human | system | one of `review.contract-change`, `review.leftovers-routed-ask`, `review.security-needs-investigation` | `open-approval(…)` |
| T13 | FIX → TEST | fixed | system | `agents.all-completed`, `diff.within-ownership`, `integration.merged` | — |
| T14 | SHIP → COMPLETED | shipped | system | `approval.ship-allowed`, `tree.digest-equals-approved`, `acceptance.no-open-human-items` | `release-locks`, `write-ship-report` |
| T15 | SHIP → TEST | stop-rule | system | `tree.digest-differs-from-approved` (stale verdict: re-validate, never skip) | — |
| T16 | TEST → FAILED | stop-rule (`check-environment`) | system | `checks.errored-environmental`: a check ended `errored` (spawn failure, timeout, sandbox denial, provisioning digest mismatch) after the bounded `tool-transient` retries of the TEST contract. Mutually exclusive with T08 and T09 by construction: `errored` is tested first | `checkpoint-worktrees`, `checkpoint` |
| T20 | *active → PAUSED | pause-command | human | — | `park-agents`, `checkpoint-worktrees` |
| T21 | *active → WAITING_APPROVAL | needs-human | system | `approval.pending-blocking` | — |
| T22 | *active → AUTH_REQUIRED | auth-required | system | — | `park-agents`, `checkpoint-worktrees` |
| T23 | *active → QUOTA_EXCEEDED | quota-exceeded | system | — | `park-agents`, `checkpoint-worktrees`, `schedule-wakeup(resetsAt)` |
| T24 | *active → WAITING_APPROVAL | stop-rule | system | stop ∈ (`iteration-limit`,`budget-exhausted`,`timeout`,`identical-failure`,`no-progress`) | `open-approval(budget\|loop-stalled)` |
| T25 | *active → BLOCKED | security-violation / stop-rule | system | error.class = `security`, or stop ∈ (`policy-violation`,`unexpected-repo-change`,`runtime-incompatible`) | `cancel-agents`, `freeze-worktrees` |
| T26 | *active → FAILED | unexpected-error | system | — | `cancel-agents`, `checkpoint-worktrees`, `checkpoint` |
| T27 | **IDLE**, *active, *suspended, FAILED, BLOCKED → CANCELLED | cancel-command | human | — | `cancel-agents`, `release-locks` |
| T30 | *suspended → *resumeTo | resume-command / approval-resolved / auth-restored / quota-reset | either | `resume.locks-rebuilt`, `resume.git-verified`, `runtime.pin-valid`, plus `approval.none-pending-blocking` / `auth.plan-satisfied` | — |
| T31 | FAILED → *resumeTo (or the legal `retry.target`) | retry-command | human | T30 guards + `retry.target-legal` | — |
| T32 | BLOCKED → *resumeTo (or TEST when the tree changed) | resume-command | human | `resume.acknowledged(blocked-inspected)` + T30 guards | `record-human-ack` |
| T33 | X → next(X) | skip-command | human | `policy.skip-allows(X)`, `skip.justified` | `record-skip{phase, integrationTreeDigest, justification, actor}` **plus the entry effects of the success-path row it replaces** (derived from the table, never hand-listed): skipping TEST runs T08's `mint-review-ref`; skipping REVIEW runs T10's `record-approved-digest{waivedBy: 'skip'}`; skipping SHIP runs T14's `release-locks`, `write-ship-report`; PREFLIGHT, BUILD and FIX have none |

**A skip is a waiver bound to a digest, not a hole in the guards.** `record-skip` stores the waiver in `runs.skip_waivers_json` keyed by
`(phase, integration treeDigest)`. Every guard that asks "was X validated for this digest?" accepts either the real evidence or a waiver for
the **same** digest: `checks.all-passed` / `checks.digest-equals-integration` (also inside `retry.target-legal`), `reviewref.digest-equals-integration`
(T10) and `tree.digest-equals-approved` (T14). So a run whose REVIEW was skipped reaches COMPLETED through T14 instead of bouncing SHIP → TEST
for ever, and any later change of the tree still invalidates the waiver and goes back through T15. Both paths are rows of the command-matrix tests.

`bugfix@1` = `feature@1` minus T01-T03, with `spec.kind = 'patch'` selecting the patch variants of the PREFLIGHT contract (repro + regression test
replace contract completeness). `review@1`: `IDLE → REVIEW` (guards `reviewtarget.resolved-to-sha`, `snapshot.captured`, `auth.plan-satisfied`;
effect `mint-review-ref`), `REVIEW → COMPLETED` on any verdict (reason `review-delivered`: the verdict is the product), optional
`REVIEW → FIX → TEST → REVIEW` only when started with `withFix`; T20-T33 identical. `retry.target-legal`: target ∈ { `resumeTo` } ∪ { `FIX` if
open fix items exist } ∪ { `TEST` } ∪ { `REVIEW` if the integration digest has passing checks }.

**Totality tests** (unit, per table): every active state has an exit for every `PhaseOutcome` kind — **for TEST that means three exits, keyed
by the worst `CheckResult.status`: all `passed` → T08, any `failed` and none `errored` → T09 (or the T24 stop), any `errored` → T16**; every
`StopReason` resolves to exactly one row; no row targets a state outside the profile's `phases`; every `skip` of every skippable phase leaves
the run able to reach COMPLETED; and the **command × state matrix** below is total — a spec-17.2 command is never
"IMPOSSIBLE", it has a row or a defined rejection:

| Command | IDLE | *active | *suspended | FAILED | BLOCKED | COMPLETED / CANCELLED |
|---|---|---|---|---|---|---|
| `pause` | reject `conflict/not-running` | T20 | `{noop}` | reject | reject | reject `conflict/run-terminal` |
| `resume` | spawns host (start pending) | `{noop}` | T30 | reject → "use `retry`" | T32 (needs `acknowledge`) | reject |
| `retry` | reject | reject `conflict/run-active` (agent-level retry only) | reject → "use `resume`" | **T31** | reject → "use `resume --ack`" | reject |
| `skip` | reject | T33 if policy | T33 if policy (on `resumeTo`) | T33 if policy (on `resumeTo`) | reject | reject |
| `cancel` | **T27** | T27 | T27 | **T27** | **T27** | `{noop}` |
| `approve` / `deny` | n/a | applies; may trigger T30 | applies; T30 when last blocking approval | applies (no transition) | applies (`blocked-ack` only) | reject |

**Versioning.** A run stores `(profile, tableVersion)`. Tables are append-only files (`feature.v1.ts`, later `feature.v2.ts`); the engine keeps
every version it can still execute. Resuming a run whose table version is not shipped → stop `runtime-incompatible` (never re-interpreted).

#### 2.5.2 Phase contract and executor (spec 11.2)

```ts
export interface PhaseContract<I = unknown, O = unknown> {
  readonly id: string; readonly version: number; readonly state: ActivePipelineState;
  readonly objectives: readonly string[];                                    // human text; never parsed
  resolveInputs(ctx: PhaseInputContext): Result<I, ErrorInfo>;               // deterministic: run state + artifacts + snapshot only
  planAgents(input: I, ctx: PhaseInputContext): AgentPlan[];                 // "agents attendus"
  readonly outputSchema: TSchema;                                            // the phase is not complete until this validates
  readonly checks: readonly PhaseCheck<I, O>[];                              // deterministic validations
  budget(run: RunState): BudgetCounters;
  readonly stop: readonly StopRule[]; readonly retry: RetryPolicy; readonly approvals: readonly ApprovalRule[];
  assemble(input: I, results: AgentResult[], ctx: PhaseInputContext): Result<O, ErrorInfo>;   // e.g. review math
}
export interface AgentPlan {
  agentId: AgentId; role: CohorteRole; surface?: SurfaceId; owner: string; parentAgentId?: AgentId;
  promptId: string;                                                          // 'agents/implementer' -> PromptRef via PinReader
  task: TaskSpec;                                                            // structured; rendered by ContextBuilder: stable prefix, variable suffix
  context: ContextRequest; tools: string[]; grant: AgentGrantRequest;
  modelTier: ModelCapability; budget: Budget;
  workspace: { kind: 'slot'; slot: string } | { kind: 'readonly-ref'; ref: string } | { kind: 'none' };
  serializeWith?: AgentId[];
}
export interface RetryPolicy { maxAttempts: number; retryOn: ErrorClass[] /* only timeout, provider-transient, tool-transient, or error.retryable */; backoff: { baseMs: number; factor: number; maxMs: number; jitter: 'none' | 'full' }; }
export type PhaseOutcome =
  | { kind: 'passed'; output: JsonValue; artifacts: ArtifactRef[] }
  | { kind: 'failed'; failure: { code: 'checks-red' | 'agent-dead' | 'outputs-invalid' | 'merge-conflict'; error: ErrorInfo; findings: Finding[] } }
  | { kind: 'needs-human'; approval: ApprovalDraft }
  | { kind: 'suspended'; stop: StopRecord };                                 // state fully persisted; re-entry continues at phases.step
```

`GenericPhaseExecutor` is a persisted step machine (`phases.step`): `plan → provision → context → spawn → await → collect → verify → commit →
integrate → done`. Every step is idempotent and begins by reading what the previous crash left. `TEST` uses `CheckPhaseExecutor` (no LLM: runs
`config.checks` through the same gate + `Executor`, `agentId = agt_system_checks`, in the `_integration` slot). Its sequence is fixed:

1. verify the slot's provisioned dependency manifest (5.7); a mismatch is an `errored` result (`security/deps-tampered`), never a test run;
2. compute `treeDigest(_integration)` **once**, before the first check; every `CheckResult` of the sequence and every `check.command` key is
   bound to that digest — a check that leaves artefacts cannot move the digest it is judged against;
3. run typecheck → lint → test, stop at the first non-`passed`. `agt_system_checks` holds a **defined** grant: tools `run_command` only,
   `commands` = the `project-checks` exact rules, `read: **`, `write: **` **inside `_integration` only** (checks legitimately write
   `coverage/`, snapshots, reports), default deny sets, dependency directories read-only (5.7). Its post-command scan therefore *attributes*
   writes; it cannot raise `security/write-outside-ownership` on a benign test run;
4. after the sequence, whatever its outcome: emit the artefact list as `file.changed{detectedBy:'post-command-scan'}` with severity `info`,
   then a journaled `git.worktree.reset` (reset + clean) of `_integration` back to the integration head, and assert the digest equals the one
   of step 2. `_integration` is never a source of commits, so nothing is lost, and the next TEST starts from a tree that
   `checks.digest-equals-integration` can match.

| Phase (V3.0) | Agents | Output schema | Deterministic checks |
|---|---|---|---|
| PREFLIGHT | none (contract authoring by `architect` = seam, off in V3.0) | `Readiness { verdict: READY\|RESERVATIONS\|NOT-READY; gaps[]; contractSha256? }` | spec completeness checks in TS; every spec path resolves to exactly one surface (longest **segment** prefix) |
| BUILD | one `implementer` per surface with tasks, parallel up to `budgets.concurrency` (default **3**), one slot each | `AgentOutput` per agent | output schema; `assumptions[]` echo routed gaps; diff within ownership; commit + merge succeeded |
| TEST | — | `CheckResult[]` | typecheck → lint → test in order, stop at first red; bound to `treeDigest` |
| REVIEW | one `reviewer` per touched surface (+ `security-reviewer` when `ownership.yaml` lists it for the surface) on the immutable review ref | `ReviewResult` (2.9) | coverage guard (`unreviewed`); verdict computed in TS, never read from the model |
| FIX | one `fixer` per surface owning ≥ 1 open fix item (`surfaceFor` = longest segment prefix; unowned → owner of `shared` or approval) | `AgentOutput` with `remediationAddressed[]` | claims never close a finding |
| SHIP (minimal) | none | `ShipReport` | approved digest == current digest; human approval by default (D9) |

#### 2.5.3 Loop controller — every stop reason of spec 11.2

```ts
export interface RoundRecord { round: number; blocking: number; fingerprint: string; checkFingerprint?: string; tokens: number; escalation?: EscalationStep; }
export interface LoopState { fixRounds: number; reviewRounds: number; history: RoundRecord[]; seenFingerprints: string[]; escalations: EscalationStep[]; deniedCalls: Record<AgentId, number>; startedAtMs: number; }
export interface LoopPolicy { maxFixRounds: number /* default 5, clamp 1..10 */; noProgressWindow: number /* 3 */; maxDeniedCallsPerAgent: number /* 5 */; runWallClockMs: number; escalation: EscalationPolicy; }
export type LoopDecision = { kind: 'ship' } | { kind: 'continue'; fingerprint: string } | { kind: 'escalate'; step: EscalationStep; then: 'continue' } | { kind: 'stop'; stop: StopRecord };

/** Port of V2 decide() (loop.js:81-91); ORDER IS LOAD-BEARING and pinned by a table test ported from V2. */
export function decideAfterReview(r: ReviewResult | null, loop: LoopState, p: LoopPolicy): LoopDecision;
//  1. r == null                              -> stop agent-dead
//  2. r.unreviewed.length > 0                -> stop unreviewed        (BEFORE blocking: "blocking==0 about code nobody read")
//  3. r.clean                                -> ship                   (-> review-clean)
//  4. a leftover is routed 'ask'             -> stop approval-required (review-leftovers)
//  5. a fixable finding's file === the contract file (EXACT match)     -> stop approval-required (contract-change)
//  6. r.fingerprint === last.fingerprint     -> escalate once per fingerprint if a step exists, else stop identical-failure
//  7. r.fingerprint ∈ loop.seenFingerprints (A->B->A) || fixItems not strictly lower than the max of the last p.noProgressWindow rounds -> escalate once, else stop no-progress
//  8. loop.fixRounds >= p.maxFixRounds       -> stop iteration-limit   (last net, never the first)
//  9. else                                   -> continue
export function decideAfterTest(checks: CheckResult[], loop: LoopState, p: LoopPolicy): LoopDecision;   // step 0: any `errored` check -> stop check-environment (T16): an environmental failure NEVER goes to FIX
                                                                                                        // (a fixer cannot repair a missing toolchain and would burn rounds). Then the same ladder on checkFingerprint.
/** Evaluated before every engine step and on every budget/approval/lock/git fact change. First hit wins. */
export function checkGlobalStops(run: RunState, facts: GlobalFacts, p: LoopPolicy): StopRecord | null;
//  cancel requested -> cancelled | pause requested -> paused | lease lost or pin mismatch or table version unknown -> runtime-incompatible
//  | security error or deniedCalls[a] >= max -> policy-violation | unexplained worktree change -> unexpected-repo-change
//  | blocking approval pending -> approval-required | auth probe != expected -> auth-required | quota window exhausted or estimatedQuotaPercent >= limit -> quota-exceeded
//  | any budget counter >= limit (run/phase/agent/provider/tool) -> budget-exhausted | now - startedAt >= runWallClockMs -> timeout
```

| StopReason | State after | Resumed by |
|---|---|---|
| review-clean | SHIP → COMPLETED | — |
| iteration-limit, identical-failure, no-progress, budget-exhausted, timeout (run level) | WAITING_APPROVAL (`kind: budget` or `loop-stalled`) | `approve` (grants N more rounds / raises the counter) or `cancel` |
| approval-required | WAITING_APPROVAL | `approve` / `deny` |
| policy-violation, unexpected-repo-change, runtime-incompatible | BLOCKED | `resume --ack blocked-inspected` (re-enters at TEST if the tree changed); a pin mismatch additionally needs the pinned install back (§6.3) |
| auth-required / quota-exceeded | AUTH_REQUIRED / QUOTA_EXCEEDED | `auth login` then `resume`; quota: auto-wakeup at `resetsAt` when known and `policy.quota.autoResume`, else `resume`. **While a wake-up is armed the host does not idle-exit** (`host.idleExitMinutes` is suspended; plan windows reset after hours — the executed quota text said "Try again in ~500 min" — and a host that exited after 30 min would lose its single timer). Bound: a `resetsAt` more than 24 h ahead is treated as unknown (manual `resume`); if the host dies anyway the run simply stays QUOTA_EXCEEDED. `doctor` and `status` show the armed wake-up |
| agent-dead, unreviewed, internal-error, timeout (agent level, retries exhausted) | FAILED (with checkpoint: spec 24) | `retry` (T31) |
| check-environment | FAILED (T16, with checkpoint), `resumeRequires: environment-repair` | repair the environment (`doctor` names the failing check and its sandbox/provisioning cause), then `retry` (T31) — the legal target is TEST |
| paused / cancelled | PAUSED / CANCELLED | `resume` / — |

Escalation (spec 10, 11.2 "jamais selon une improvisation du LLM"): `EscalationStep` and `EscalationPolicy` are **data types of the protocol
vocabulary** (2.3.1) because the config schema and the `escalation.applied` payload both need them (`BudgetCounters`, which `security` needs
too, is one level lower, in `base`); `nextEscalation(loop, failing, policy)` in
`core` is pure and emits `escalation.applied`.

#### 2.5.4 Agent lifecycle (spec 6)

```ts
export const AGENT_TRANSITIONS = {
  declared:  ['planned', 'cancelled'],            // planned = context manifest built + grants computed + slot acquired
  planned:   ['spawning', 'cancelled'],
  spawning:  ['running', 'failed', 'cancelled', 'spawning'],  // effect agent.spawn, key = `${runId}:${agentId}:${incarnation}`; -> spawning = the host died mid-spawn (crash point #9): reincarnation
  running:   ['waiting', 'paused', 'completed', 'failed', 'cancelled', 'spawning'],   // -> spawning = REINCARNATION (below)
  waiting:   ['running', 'paused', 'failed', 'cancelled', 'spawning'],     // blocked on approval / quota / a serialized peer
  paused:    ['running', 'cancelled', 'spawning'],
  failed:    ['retrying', 'escalated', 'cancelled'],           // only if error.retryable && attempt < maxAttempts
  retrying:  ['spawning', 'cancelled'],           // attempt+1, incarnation+1, SAME context hash: the SpawnRequest minus {incarnation} is byte-identical (FakeLedger assertion)
  escalated: ['spawning', 'cancelled'],
  completed: [], cancelled: [],
} as const satisfies Record<AgentState, readonly AgentState[]>;

/** The four edges `spawning|running|waiting|paused -> spawning` are REINCARNATIONS: the runtime session is gone but the WORK did not fail. They carry a cause and
 *  are the ONLY way to reach `spawning` without going through `failed -> retrying|escalated`. incarnation+1, attempt UNCHANGED, a Continuation note is mandatory. */
export type ReincarnateCause = 'recovery' /* host died or was restarted: 4.4 step 10 */ | 'park' /* approval wait exceeded parkAfterMinutes, or quota/auth suspension: 4.5 */ | 'pause-expiry' /* paused longer than host.pauseKeepAliveMinutes: 4.6 */;
export function reincarnate(agent: AgentRecord, cause: ReincarnateCause): AgentRecord;   // throws on a terminal state or when incarnation would exceed maxIncarnations (-> failed{budget/incarnations})
```

`attempt` counts retries of the work; `incarnation` counts runtime sessions. The rule, stated once: **`attempt` is incremented by exactly two
edges — `failed → retrying` and `failed → escalated` — and by nothing else.** A recovery after a host death, a parked approval and an expired
pause are reincarnations of the same attempt: they do not consume `maxAttempts`, they count against `maxIncarnations` (default 5), and they
are visible as `agent.state.changed{to:'spawning', reason:'recovery'|'park'|'pause-expiry', attemptConsumed:false}`. Totality test: from every
non-terminal state, "the child is gone" has a legal path to `spawning` that does not increment `attempt` (for `failed`, `retrying` and
`escalated` the increment already happened, once, when the failure was recorded: a host crash there does not add a second one). A
`completed` agent is never re-spawned by `resume`.
`completed` requires `exit.outcome === 'completed'` **and** an accepted, schema-valid `AgentOutput` **and** the phase's per-agent checks.
`model-stop` without an accepted result → up to 2 `host-note` nudges ("call submit_result"), then `validation/agent-no-result` (escalation candidate).

### 2.6 `@cohorte/security`

#### 2.6.1 Decisions and verdicts

```ts
export type PolicyDecision = 'allow' | 'deny' | 'ask' | 'allow-once' | 'allow-for-run';      // spec 9, exactly
//  The pure engine returns allow | deny | ask. allow-once / allow-for-run are APPROVAL RESOLUTIONS: rows in `approvals`, found by grantKey at stage 6,
//  reported in the verdict with the approvalId so the audit trail says WHY. An `ask` nobody can answer (unattended + policy 'deny') becomes `deny`
//  with reason "nobody to confirm": an unanswerable ask never silently runs.
export type GateStageName = 'liveness' | 'schema' | 'capability' | 'path' | 'command' | 'network' | 'budget' | 'approval';
export interface GateCall { runId: RunId; agentId: AgentId; incarnation: number; toolCallId: ToolCallId; tool: string; input: JsonValue; phase: string; role: string; }
export interface GlobSet { include: string[]; exclude: string[]; }
/** THE glob semantics of 2.6.3 step 7, implemented once (decide/paths) and exported as a contract so `tools` (list_files, search, git_diff output filtering,
 *  WorkspaceReader) and `core` (grants, zones) never configure picomatch themselves. `toExcludeArgs` renders a deny set for an external enumerator. */
export interface GlobMatcher { matches(relativePosixPath: string, set: GlobSet): boolean; isDenied(relativePosixPath: string, grant: AgentGrant, intent: 'read' | 'write'): boolean;
  toExcludeArgs(set: GlobSet, dialect: 'rg-glob' | 'git-pathspec'): string[]; }
// BudgetCounters (used by BudgetReader below) is imported from @cohorte/base: this package never imports @cohorte/protocol.
export interface NormalizedCall { tool: string; paths: { arg: string; resolved: ResolvedPath; intent: 'read' | 'write' | 'create' | 'list' | 'exec-cwd' }[];
  command?: { file: CanonicalPath; args: string[]; cwd: CanonicalPath; ruleId: string; replay: 'idempotent' | 'at-most-once'; network: boolean; timeoutMs: number };
  input: JsonValue /* strictly validated, size-capped */; grantKeyMaterial: JsonValue /* canonical subject used for grant_key (4.5) */; }
export interface BranchResolver { branchOf(cwd: CanonicalPath): { kind: 'branch'; name: string; protected: boolean } | { kind: 'detached-or-unknown'; protected: true }; }   // facts pre-fetched; sync
export interface BudgetReader { remaining(level: 'run' | 'phase' | 'agent' | 'provider' | 'tool', id: string): BudgetCounters; callsInLastMinute(agentId: AgentId, tool: string): number; }
export interface PolicyVerdict {                        // [S] every verdict is schema-valid
  decision: PolicyDecision; stage: GateStageName; ruleId: string;
  reason: string;                                       // humans / events
  modelFacingReason: string;                            // no secrets, no absolute host paths, no policy internals; ends with "Do not retry." for deny
  overridable: boolean;                                 // false = built-in rule that no project config and no approval can lift
  securityViolation: boolean;                           // true => run goes BLOCKED (spec 24): symlink escape, protected path write, runtime path, MAC failure…
  asks: { stage: GateStageName; ruleId: string; reason: string }[];
  evaluatedRules: string[];                             // every rule id evaluated, for `cohorte policy explain` and the audit event
  normalized: NormalizedCall | null;                    // what will actually execute: canonical paths, resolved program realpath, clamped timeout, replay class
  approvalId?: ApprovalId; grantId?: string;
}
export interface AgentGrant {                           // [S] computed by core from ownership.yaml + role defaults + phase contract; persisted in agents.grants_json
  agentId: AgentId; role: string; digest: Sha256; tools: string[];
  roots: { workspace: CanonicalPath | null; readOnly: CanonicalPath[] };
  read: GlobSet; write: GlobSet;                        // write ⊆ owned paths of the surface; worktree-relative POSIX, dot:true, slash-less pattern means **/<p>
  denyRead: GlobSet; denyWrite: GlobSet;                // always win. Defaults: **/.env*, **/*.pem, **/*.key, **/id_rsa*, **/id_ed25519*, **/.git, **/.git/**, **/.cohorte/**, **/.pi/**, **/.npmrc, **/.netrc
  commands: CommandPolicy;
  secrets: { id: string; exposeAs: 'env'; name: string }[];       // ids only; values resolved inside the Executor and registered with the Redactor first
  temporary: { grantId: string; approvalId: ApprovalId; grantKey: string; expires: 'call' | 'run' }[];   // spec 8 "grant temporaire audité"
  limits: { maxToolCalls: number; maxCallsPerMinute: number; perTool: Record<string, { maxCalls?: number; timeoutMs: number; maxOutputBytes: number }> };
}
export interface PolicyPorts { paths: PathResolver; branches: BranchResolver; budgets: BudgetReader; programs: ProgramResolver; clock: Clock; }   // all SYNCHRONOUS
export interface PolicyEngine { evaluate(call: GateCall, grant: AgentGrant, policy: PolicySnapshot, ports: PolicyPorts): PolicyVerdict; }          // deterministic => table-testable
```

`PolicySnapshot` is immutable, hashed, loaded from the run snapshot at run start and held in host memory (I4); the project file is never re-read.

#### 2.6.2 The ordered gate chain (spec 9)

| # | Stage (spec 9 wording) | Owner | What it does | Fails as |
|---|---|---|---|---|
| 0 | Pi tool call / liveness | core `CohorteToolHost` | `if (signal.aborted) → error` first statement; **pause latch** (hold here until resumed or parked); `tool.requested` committed with sealed args | `tool-transient/cancelled` |
| 1 | schema validation | security | **strict** re-validation with Cohorte's compiled schema (`additionalProperties:false`, no coercion — Pi coerces); size caps; NUL/control-char rejection | `validation/tool-input` |
| 2 | agent capability check | security | `grant.tools.includes(tool)`; terminal tool allowed once | `permission/tool-not-granted` |
| 3 | ownership/path check | security | every path argument → `PathResolver` → containment in `roots` → deny sets → `read`/`write` globs → built-in protected roots | `permission/path-outside-grant`, `security/symlink-escape`, `security/protected-path` |
| 4 | command/network policy | security | `run_command`: `CommandPolicy` (2.6.4); `network_request`: always deny in V3.0 | `permission/command-not-allowed`, `security/command-trampoline`, `security/command-global-option`, `permission/network-denied` |
| 5 | budget + rate limit | security (reads core budgets via `BudgetReader`) | run/phase/agent/provider/tool counters, calls/minute, remaining wall clock → clamp `timeoutMs`; soft limit (80 %) appends a wrap-up notice | `budget/*` (deny with `terminate:true` **and** host abort) |
| 6 | approval gate si nécessaire | core `ApprovalService` | if `asks` non-empty: `findGrant(grantKey)` covering **all** asks → `allow-once`/`allow-for-run`; else open a durable approval (key `apr:${toolCallId}`), agent → `waiting` | `permission/denied-by-human`, `human-required/approval-timeout` |
| 7 | isolated executor | tools + security `Executor`, only through `EffectJournal.run()` | `intent` (consumes an allow-once grant in the same tx) → execute the normalised call → `done`; use-time path re-verification | `tool-transient/*`, `tool-terminal/*`, `timeout/tool` |
| 8 | result + audit event | core | output capped, hashed, **sealed**, stored as artifact; `tool.completed` + `file.*` + ledger rows; post-command scan attributes writes (`file.changed`) and **fails the call** if any touched path is outside `write` | `security/write-outside-ownership` → BLOCKED |

Precedence: stages 1-5 are pure and **all run**; the first `deny` wins over any number of `ask`s regardless of order; `ask`s accumulate into one
approval. Any exception in any stage = `deny` with `security/gate-internal-error` (fail closed). Missing or unparseable policy =
`configuration/policy-invalid` at run start: no tool ever executes. `cohorte policy explain -- <argv…>` runs stages 1-5 offline and prints the verdict.

#### 2.6.3 Canonical paths and symlink policy (spec 23)

```ts
export type CanonicalPath = Brand<string, 'CanonicalPath'>;      // absolute, realpath'd, NFC, no trailing slash, on-disk case
export interface PathResolver { resolve(input: string, base: CanonicalPath, intent: 'read' | 'write' | 'create' | 'list' | 'exec-cwd'): Result<ResolvedPath, PathViolation>; }   // never throws; never follows a link it has not vetted
export interface ResolvedPath { canonical: CanonicalPath; relative: string /* POSIX, to the matched root */; root: CanonicalPath; exists: boolean; identity?: { dev: number; ino: number; nlink: number }; viaSymlink: boolean; }
export type PathViolation = { code: 'nul-byte' | 'outside-roots' | 'symlink-escape' | 'symlink-denied' | 'symlink-final-write' | 'hardlink-multiply-linked' | 'protected-root' | 'special-file' | 'too-long' | 'case-collision'; security: boolean; detail: string };
export interface SymlinkPolicy { mode: 'deny-outgoing' | 'deny-all' | 'allow'; hardlinksOnWrite: 'deny' | 'allow'; }     // [S] policy DATA: declared in @cohorte/config (like CommandRule), evaluated here; default deny-outgoing + deny
```

Algorithm (one implementation, used by the gate, `WorkspaceReader`, `WorktreeService` and `tools`):

1. Reject NUL/control chars, length > 4096, `~`, env syntax, Windows drive/UNC forms. Normalize to NFC. Nothing is expanded.
2. `abs = path.resolve(base, input)`; `path.posix.normalize` on the relative form.
3. Walk from the root to the leaf; `lstat` each existing component. Symlink component: `deny-all` → violation; `deny-outgoing` → `realpath` the
   target and require containment in an allowed root. In `write`/`create` mode a symlink as the **final** component → `symlink-final-write`.
4. `realpath` the deepest existing ancestor (returns on-disk case: defeats `.ENV` vs `**/.env*` on APFS), re-append the non-existing tail, **then**
   test containment by path *segments* (never `startsWith`: `apps/api` vs `apps/api-gateway`).
5. Built-in protected roots, **not overridable** by config or approval: Cohorte's install dir and every pinned runtime artifact, the node binary
   dir, `<project>/.cohorte/**`, any `.git` (file or directory, any depth), `.pi/**`, the Pi agent dir and `auth.json`,
   `~/.cohorte/{keys,versions,pi-agent,brains,trust}` and `~/.cohorte/config.yaml`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/{gh,gcloud}`.
   (The worktree root `~/.cohorte/worktrees` is **not** in this set: §5.1.) Because the set has no exception, **a `git.worktreeRoot` that
   canonicalises inside any protected root — `.cohorte/worktrees` included — is refused when the config is resolved**
   (`configuration/worktree-root-protected`): every agent path under it would otherwise be denied as `protected-root`, i.e. the option would
   be legal and unusable. A path-table case pins it (S-01..S-13 group).
6. `write` on an existing regular file with `nlink > 1` → `hardlink-multiply-linked`. FIFO / device / socket → `special-file`.
7. Glob match on `relative` with picomatch `{ dot: true, nocase: false }`, deny sets first. `dir/**` matches `dir` (locked by a table test).
8. **Use time**, inside the per-slot effect mutex: open with `O_NOFOLLOW` on the final component, `fstat`, compare `(dev, ino)` with step 3;
   writes go to a temp file in the same canonical directory (`O_CREAT|O_EXCL|O_NOFOLLOW`), `fsync`, re-`realpath` the directory, `rename`.
   Under L1 the OS sandbox is the backstop for the residual race.

#### 2.6.4 Command policy — a parsed-argv allowlist, not a matcher (ADR-0024)

```ts
export interface CommandRequest { argv: readonly string[]; cwd: string /* worktree-relative, validated by stage 3 */; timeoutMs?: number; }   // NO string form exists (I3)
export interface ProgramProfile {
  program: string;                      // canonical name: 'git' | 'pnpm' | 'npm' | 'yarn' | 'node' | 'docker'
  aliases: readonly string[];           // 'docker-compose' => docker + ['compose']
  /** Parses argv[1..] into { globals, subcommand[], flags, positionals }. Returns a denial for any global option that re-targets the command:
   *  git -C/-c/--git-dir/--work-tree/--exec-path/--namespace · pnpm -C/--dir/--prefix · npm --prefix · node -e/-p/-r/--require/--import/--loader/--eval. */
  parse(args: readonly string[]): ParsedCommand | CommandDenial;
}
export interface CommandRule {                          // [S] lives in @cohorte/config (policy DATA); evaluated here
  id: string; program: string;
  subcommand?: readonly string[];                       // exact tokens, e.g. ['run','test']
  flags?: { allow: readonly string[]; deny?: readonly string[] };          // anything not allowed is denied
  positionals?: { kind: 'none' } | { kind: 'paths-in-worktree'; max: number } | { kind: 'enum'; values: readonly string[]; max: number } | { kind: 'exact'; values: readonly string[] };
  decision: 'allow' | 'ask' | 'deny';
  when?: { branch?: 'any' | 'unprotected-only'; roles?: readonly string[]; phases?: readonly string[] };
  replay: 'idempotent' | 'at-most-once';                // drives recovery (4.1); default 'at-most-once'
  network: boolean;                                     // true => denied under L0 (nothing enforces "réseau désactivé"); under L1 it fails closed in the sandbox
  origin: 'builtin' | 'project-config' | 'project-checks';
}
export interface CommandPolicy { default: 'deny'; rules: CommandRule[]; }
export interface ProgramResolver { resolve(bareName: string): CanonicalPath | undefined; }   // through the PATH pinned at run start (recorded in the snapshot), then realpath
```

Evaluation: (1) `argv[0]` must be a bare name (no `/`), is alias-normalised and resolved to an absolute **realpath** through the *pinned PATH*
(so `Node`, `./node`, a repo-local shim or a PATH-planted binary cannot stand in for the real program; the pinned PATH never contains Pi's or
Cohorte's bin directory); (2) **trampolines are denied, `overridable: false`**: `sh bash zsh dash fish ksh csh env xargs sudo su doas eval exec
nohup time watch npx pnpx bunx corepack ssh scp curl wget nc python* perl ruby osascript`, plus **`pi` and `cohorte`** (`pi auth
print-bearer-token` prints the OAuth token **[85]**); a project that truly needs one declares an exact-argv rule under
`policy.dangerousCommands` and every use is `ask`; (3) agents have a built-in, non-overridable deny on `git commit|push|merge|rebase|reset|
checkout|switch|worktree|config|update-ref|filter-branch|gc` (D9); (4) a program **with** a profile is parsed structurally and matched by
`(program, subcommand, flags, positionals)`; a program **without** a profile can only be allowed by an `exact` argv rule; (5) no rule ⇒ **deny**;
deny over ask over allow; (6) `cwd` must canonicalise inside the agent's own worktree; branch-conditional rules treat *detached / unknown / git
cannot answer* as **protected**. Project check commands come from `.cohorte/config.yaml` `checks:` (human-owned) as `exact` rules with `replay:
idempotent`. `package.json` scripts are reachable only as `pnpm run <name>` with `<name>` in an `enum`: what the script does is contained by the
sandbox, not by the matcher — which is the honest division of labour and the reason L1 is in V3.0.

#### 2.6.5 Redaction

The `Redactor` interface is in `base` (2.1); the implementation here is the only minter of `Sealed<T>`. Detectors: registered values (+ encoded
forms); `KEY=value` lines when the key matches `/(SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE)/i` and values learned from any `**/.env*` the run could
see; PEM blocks; provider key shapes (`sk-…`, `sk-ant-…`, `ghp_/gho_/ghs_/github_pat_`, `xox[abp]-`, `AKIA…`, `AIza…`); JWT triples;
`Authorization:`/`Bearer` headers; OAuth JSON fields (`access_token`, `refresh_token`). Choke points are *types*, not conventions: `appendEvents`,
the logger, `RuntimeToolResult.content`, approval previews, artifact writes flagged sensitive. Every error text coming from a runtime child
(`ErrorInfo.message`, Pi's `errorMessage`, which can embed a provider body on refresh failure **[X]**) is sealed by the parent before it becomes an
event. A redactor exception = the event is replaced by `error{security/redaction-failed}` and the raw payload is dropped (fail closed).

#### 2.6.6 Executor and sandbox levels (ADR-0003)

```ts
export interface ExecRequest {
  file: CanonicalPath; args: readonly string[];         // resolved program; NEVER a shell line
  cwd: CanonicalPath; env: Readonly<Record<string, string>>;   // complete; the executor never reads process.env
  fs: { readWrite: CanonicalPath[]; readOnly: CanonicalPath[]; denyRead: CanonicalPath[] };
  network: 'none' | 'unrestricted';                     // 'unrestricted' is legal ONLY for Cohorte-run provisioning effects (5.7), never for an agent call
  timeoutMs: number; maxOutputBytes: number; stdin: 'ignore';
  limits: { cpuSeconds?: number; fileSizeBytes?: number; openFiles?: number; processes?: number; memoryBytes?: number };
  require: 'native' | 'best-effort';
  onChunk?: (c: { stream: 'stdout' | 'stderr'; bytes: number; text: SealedText }) => void;
}
export interface ExecResult { exitCode: number | null; signal?: string; outcome: 'ok' | 'error' | 'timed-out' | 'killed' | 'output-capped' | 'sandbox-denied';
  tail: SealedText; outputSha256: Sha256; outputBytes: number; truncated: boolean; fullOutputPath?: string; durationMs: number;
  pgid: number; startToken: string; escapees: number /* processes that left the group, found by the post-run sweep */; guarantees: SandboxCapabilities; }
export interface Executor { capabilities(): SandboxCapabilities; run(req: ExecRequest, signal: AbortSignal): Promise<ExecResult>; }
export interface SandboxBackend { readonly id: 'seatbelt' | 'bubblewrap' | 'none'; probe(): Promise<SandboxCapabilities>; wrap(file: CanonicalPath, args: readonly string[], req: ExecRequest): { file: CanonicalPath; args: string[] }; /* pure */ }
export interface SandboxCapabilities {                  // [S] exactly what `cohorte doctor --json` prints under "sandbox" (spec 9 "garanties réellement actives")
  level: 'L0-process' | 'L1-os'; backend: 'none' | 'seatbelt' | 'bubblewrap';
  filesystem: 'enforced' | 'partial' | 'advisory'; network: 'enforced-off' | 'partial' | 'unenforced';   // 'partial': the backend is active but its escape self-test
                                                        // (S-28 on macOS, S-29 on Linux, run by probe() and cached per Cohorte version + OS build) has not passed here
  processEscape: 'denied' | 'partial' | 'possible';     // LaunchServices / AppleEvents / job creation / signalling other processes / host Unix sockets
  envFiltering: 'enforced'; timeout: 'enforced'; outputCap: 'enforced';
  cpuTime: 'enforced' | 'unavailable'; memory: 'enforced' | 'node-only' | 'unavailable'; processes: 'enforced' | 'unavailable';
  killTree: 'pid-namespace' | 'process-group-with-sweep';
  missing: string[]; notes: string[];                   // e.g. ["bwrap"], ["kernel.apparmor_restrict_unprivileged_userns=1"]
}
```

| Level | Guarantees | Where |
|---|---|---|
| **L0** process hygiene (always on, pure Node) | verified cwd; env built from an allowlist (`PATH`=pinned, `HOME`=per-agent scratch, `LANG`, `LC_ALL`, `TERM=dumb`, `CI=1`, `TMPDIR`=per-agent, `NO_COLOR`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`; **provisioning effects additionally get the allowlisted package-manager variables of `provision.env`, 5.7 — the scratch `HOME` would otherwise hide the package store**) and never inherited. *What "only the allowlist" means is defined once*: the visible names must lie in `allow ∪ OS_INJECTED_ENV[platform]`, a frozen constant of `@cohorte/security/contract/builtin.ts` (`{ darwin: ['__CF_USER_TEXT_ENCODING'] }` — CoreFoundation injects it into every process; verified on macOS arm64 / Node 24.21: a child spawned with `env: { PATH }` and an `'ipc'` channel reports exactly `["PATH","__CF_USER_TEXT_ENCODING"]`, and Node removes `NODE_CHANNEL_FD` itself before user code runs); `detached:true` + process-group `TERM → grace → KILL`; pgid + start token recorded, **sweep at tool end and at resume** for processes that left the group; wall-clock timeout; stream-drain timeout; output cap that **kills** on overflow; `ulimit -t/-f/-n/-u` through the constant wrapper `/bin/sh -c 'ulimit …; exec "$0" "$@"'` (I3). Filesystem and network isolation are **advisory**. | every OS |
| **L1** OS sandbox | L0 + writes only under `fs.readWrite`; `fs.readOnly` roots (the slot's dependency directories, 5.7) are not writable even inside a write root; reads denied for `denyRead` (Pi agent dir, `~/.cohorte/{keys,versions,pi-agent,brains,trust}`, the state dir, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/{gh,gcloud}`); **network off**; **no escape through another process and no signal to a process outside the sandbox**; Linux also pid namespace (kill-tree) and cgroup v2 limits through `systemd-run --user --scope` when present (invoked by Cohorte *around* `bwrap`, never reachable from inside) | see the two profiles below |

**The executor's L1 profile is deny-by-default on both platforms.** The profile the toolchain research verified was `(allow default)(deny
network*)(deny file-write* …)`: enough to show that Seatbelt still enforces, not enough for an executor that runs agent-written tests.
Under an allow-default profile, agent code can call `/usr/bin/open` or `osascript`: LaunchServices and AppleEvents then start a process
**outside** the sandbox, which reads `~/.pi/agent/auth.json` with the network available; the same code can `SIGKILL` the run host. On Linux,
`--unshare-net` does not isolate *path-based* Unix sockets, and `--ro-bind / /` leaves `/var/run/docker.sock`, the user D-Bus at
`$XDG_RUNTIME_DIR/bus` (which reaches `systemd-run`, i.e. an escape) and the ssh-agent / gpg-agent sockets connectable.

| Backend | Generated profile (golden-tested) |
|---|---|
| **Seatbelt** (executor) | `(version 1)(deny default)`; explicit allows: `process-exec` + `process-fork` (test runners fork), `file-read*` on `/` **minus** the `denyRead` set, `file-write*` on the listed `fs.readWrite` roots **minus** `fs.readOnly`, `file-read-metadata`, `sysctl-read`, a **minimal `mach-lookup` list** (the services a Node/toolchain process needs to start: notification center, `com.apple.system.opendirectoryd.libinfo`, logd/diagnosticd, trustd, FSEvents, as pinned by the golden file), `signal (target self)` and `(target children)`. **Never allowed** (implicit in `deny default`, asserted by the golden test so that a future allow cannot slip in): `network*`, `lsopen`, `appleevent-send`, `job-creation`, `mach-register`, `signal (target others)`, `system-socket`, `iokit-open` |
| **bubblewrap** (executor) | an **explicit root set**, never `--ro-bind / /`: `--ro-bind /usr /usr`, `/bin`, `/sbin`, `/lib*`, `/etc` (read-only), the pinned node dir, the pinned PATH dirs, `--ro-bind` of each `fs.readOnly` root, `--bind` of each `fs.readWrite` root; `--proc /proc --dev /dev --tmpfs /run --tmpfs /tmp --tmpfs $HOME` (the scratch home); `--unshare-net --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try --new-session --die-with-parent --cap-drop ALL`; env `XDG_RUNTIME_DIR` = a private directory under the scratch tmp. `/run`, `/var/run` and the user's runtime dir therefore do not exist inside: no docker, D-Bus, systemd, ssh-agent or gpg-agent socket is reachable |

Escape tests that gate the word "enforced": **S-28** (macOS) — from an allowed command, `open -a …`, `open <file>` and `osascript -e …` cannot
create a canary outside the worktree, and `kill -9 <run host pid>` fails; **S-29** (Linux) — `connect()` to a Unix socket created outside the
worktree (and to `/var/run/docker.sock` and `$XDG_RUNTIME_DIR/bus` when they exist on the host) fails. `probe()` runs the platform's escape
self-test once per Cohorte version and OS build; until it passes, `SandboxCapabilities.filesystem` and `.network` say `partial` and
`processEscape` says `partial`, and `doctor` prints why. `sandbox.require: native` is satisfied only by `enforced`: with a `partial` backend
the run refuses to start (`security/sandbox-unavailable`, naming the failing self-test); the local user may opt into `best-effort`, which
still wraps commands in the partial L1 backend — strictly better than L0 — and says `partial` in `RunPlan.sandbox` and every `tool.started`.

V3.0 ships in-house `SeatbeltBackend` and `BubblewrapBackend` (pure profile/argv generators, golden-file tested, ~250 lines each) rather than
`@anthropic-ai/sandbox-runtime` (0.0.x, process-global singleton, SOCKS proxy; V3.0 needs no in-sandbox network allowlisting). Policy:
`sandbox.require: native | best-effort`. **Default = `native` when `runtime.id !== 'fake'` and any role holds `run_command`**, else
`best-effort`. `native` + unavailable backend ⇒ the run refuses to start (`security/sandbox-unavailable`, with the exact `doctor` remediation).
Under `best-effort` at L0: rules flagged `network` are **denied** (not asked), the level is written in `RunPlan.sandbox`, `pipeline.started` and
every `tool.started`, and `doctor` prints: *"L0: an allowed command is arbitrary code running as you; it can read your credentials and Cohorte's
state."* The Linux path is probed in Wave 0 (§10.3 U0.P: bwrap under Ubuntu 24.04 AppArmor userns restrictions).

#### 2.6.7 Control-plane authentication (spec 17.2 "authentifiées par transport local", spec 23 "approvals signées") — ADR-0022

```ts
export interface KeyStore { projectKey(projectKeyId: string, opts: { create: boolean }): Promise<Uint8Array>; }   // ~/.cohorte/keys/<projectId>-<sha256(realpath(git common dir))[0:12]>.key
/** Signs BYTES, not envelopes: `canonicalBody` is `protocol.canonicalCommandBody(envelope)` (the envelope minus `auth`, canonical JSON), computed by the caller
 *  (`apps/cli` controllers, `core` inbox drain). `security` therefore names no `protocol` type (1.2). */
export interface CommandAuthenticator { readonly scheme: 'hmac-sha256'; sign(canonicalBody: string, key: Uint8Array): string; verify(canonicalBody: string, value: string, key: Uint8Array): boolean /* timing-safe */;
  anchor(runId: RunId, atSequence: number, chainHash: string, key: Uint8Array): string; }
```

"Authenticated by local transport" is defined concretely as **file modes + MAC**: the key is 32 random bytes, file `0600`, directory `0700`,
created by `cohorte init` (or lazily by the first mutating command), outside the repository, outside every executor read root, in the brain's
`denyRead`. Every mutating command carries `auth = { scheme: 'hmac-sha256', value: HMAC-SHA256(key, canonicalCommandBody(envelope)) }`; the host
verifies on claim **and** again in recovery before applying; an unknown scheme, a missing or a wrong value is
`command.rejected{security/command-auth-invalid}` + an `error` event and is never applied (a forged `approve` does not resolve the approval).
`approval.resolved` records the resolving command's authenticator. Each `checkpoint.created` carries a MAC anchor over `(runId, atSequence,
chainHash)`, so an attacker without the key cannot rewrite history by recomputing the unkeyed chain.
`run`, `resume` and `__host` refuse to start as uid 0 (`security/root-refused`, spec 23 "absence de privilèges root"); `doctor` reports it.

**Separation of identities (spec 23).** Three kinds of principal exist, and they are separated by what they *hold*, not by what they claim:

| Principal | Holds | Can produce |
|---|---|---|
| **key holders** — a human at a terminal, or a client program (François, CI), all running as the OS user | the project key | commands. `actor.kind` is a *claim among key holders*: the CLI stamps `human` only when stdin and stdout are TTYs and the verb was not given `--yes`; everything else is `client`. The host never upgrades a claim, and rewrites `human` to `client` when `actor.transport` is not `'cli'`. The authenticator proves "a key holder", never which one: per-actor identity needs asymmetric keys (ADR-0022 "Revisit") |
| **system** — the run host | the run lease (fencing token) | events with `source: 'cohorte'`, transitions with actor `system`. It cannot produce a command, and a `TransitionDef.actor: 'human'` row (T27, T31, T32, T33) can only be triggered by an accepted command, never by the engine on its own initiative |
| **agents** | nothing: an `agentId`, no key, no lease; under L1 the inbox, the key directory and the state DB are unreadable and unwritable | tool calls, and through them events with `source: 'runtime'` attributed to their `AgentRef`. Commits carry the `Cohorte-Agent` trailer. An agent can never produce a command or an event with `source: 'human' \| 'client'` |

Test **S-36**: no sequence of agent tool calls (writes aimed at `inbox.poke`, the DB, the key directory, `run_command ['cohorte','approve',…]`,
an `approval_request` whose text imitates an approval) yields an accepted command, a resolved approval, or an event whose `source` is `human`
or `client`. Under L0 the same honest limit as above applies and is printed by `doctor`.

### 2.7 `@cohorte/tools` — the catalogue (frozen in Wave 0; both the prompts and the fake scripts meet on these shapes)

Every input schema is one flat top-level object, `additionalProperties: false`, no `$ref/$defs/oneOf` (asserted by `toToolGrant()`).

| Tool | Input | Effect kind · replay class | Notes |
|---|---|---|---|
| `read_file` | `{ path: string; offset?: integer; limit?: integer }` | `tool.read` · idempotent | returns sealed text with line numbers; binary → error; 256 KiB cap per call |
| `list_files` | `{ path?: string; glob?: string; maxEntries?: integer }` | `tool.read` · idempotent | deny sets filtered out; never follows outgoing symlinks |
| `search` | `{ pattern: string; path?: string; glob?: string; caseInsensitive?: boolean; maxMatches?: integer }` | `tool.read` · idempotent | spawns `rg` through the `Executor` (never an in-process scan on the host's event loop) with one `--glob '!<pattern>'` per `denyRead` entry (`:(exclude,glob)` pathspecs for the `git grep` fallback), **then filters every hit path** through `PathResolver` + the grant before returning it; dropped hits are counted (`filteredPaths`) |
| `write_file` | `{ path: string; content: string }` | `tool.write_file` · verifiable | `verify = { beforeSha256 \| null, afterSha256 }`; ledger row |
| `patch_file` | `{ path: string; edits: { oldText: string; newText: string }[] }` | `tool.patch_file` · verifiable | exact-match, each `oldText` must occur exactly once; pre-image mismatch → `tool-terminal/patch-preimage-mismatch` |
| `run_command` | `{ argv: string[]; cwd?: string; timeoutMs?: integer }` | `tool.run_command` · from the matched rule | post-command changed-path scan → ledger rows + ownership check |
| `git_diff` | `{ base?: 'run-base' \| 'integration' \| 'checkpoint'; paths?: string[]; stat?: boolean }` | `tool.read` · idempotent | Cohorte-run hardened git with `--no-ext-diff --no-textconv`. `run-base` = the run's pinned `base.sha`: **the default for `readonly-ref` workspaces** (a reviewer on the detached review ref would get an empty diff against `integration`); `integration` is the default for slots. **Always** adds exclude pathspecs for `denyRead` and for everything outside `read` — also when `paths` is absent — and filters the resulting file list the same way; `.cohorte/**` is never printed |
| `approval_request` | `{ question: string; options?: string[] }` | — (pure state) | opens a `kind: tool` approval the agent waits on; `options` are shown to the human (`ApprovalRequest.options`), the chosen one comes back in `approve.answer`, is validated against the list and is echoed in the tool result (`{ decision, answer }`) |
| `submit_result` | `AgentOutput` (2.9) | — (pure state) | `terminal: true`; strict per-role validation; accepted once |
| `git_commit`, `network_request`, `secret_read` | registered shapes | — | **granted to nobody in V3.0**; default policy denies; seams |

**Every tool that enumerates content filters on output.** Gate stage 3 validates path *arguments*; `list_files`, `search` and `git_diff` also
*produce* paths and content that were never an argument. `search` with pattern `.` would otherwise return lines of `certs/server.key` or
`.npmrc`, and `git_diff` without `paths` would print a tracked `.env.example` and the contents of `.cohorte/**`; the `Redactor` only knows
shapes, and a body line of a PEM block is not one. So each of these tools (a) hands the deny sets to the enumerator (`GlobMatcher.toExcludeArgs`)
and (b) re-checks every returned path with `PathResolver` + `GlobMatcher.isDenied` before a byte of it reaches the model. Tests **S-14** (a
planted `certs/server.key` and `id_rsa` are never returned by `search`) and **S-15** (a tracked `.env.example` and `.cohorte/config.yaml` are
never returned by `git_diff`, with and without `paths`).

```ts
import type { EffectKind, ReplayClass, EffectIntent, EffectRecord } from '@cohorte/persistence/contract';   // TYPE-ONLY edge tools -> persistence (1.1, 1.2)
export interface ToolImplementation<I = JsonValue, O = JsonValue> {
  readonly name: string; readonly inputSchema: TSchema; readonly description: string; readonly effect: ToolGrant['effect'];
  plan(input: I, n: NormalizedCall, ctx: ToolExecContext): { kind: EffectKind; replayClass: ReplayClass; verify: JsonValue; preState?: EffectIntent['preState'] } | null;   // null = no journal (pure state)
  execute(input: I, n: NormalizedCall, ctx: ToolExecContext, signal: AbortSignal): Promise<{ output: O; modelText: string; filesTouched: FileTouch[] }>;   // NEVER synchronous heavy work: hashing streams, scans are spawned
  verifyAfterCrash(record: EffectRecord, ctx: ToolExecContext): Promise<'done' | 'not-done' | 'in-doubt'>;
  describeForNote(record: EffectRecord): string;        // one line for the reconciliation note (4.4)
}
export const TOOL_CATALOGUE: Readonly<Record<string, ToolImplementation>>;
export function toToolGrant(name: string): ToolGrant;   // asserts the flat-schema rule
export interface WorkspaceReader { read(root: CanonicalPath, rel: string, grant: AgentGrant): Promise<Result<{ bytes: Uint8Array; sha256: Sha256 }, ErrorInfo>>; list(root: CanonicalPath, globs: GlobSet, grant: AgentGrant): Promise<string[]>; }
```

### 2.8 Error taxonomy (spec 24)

```ts
export class CohorteError extends Error { readonly info: ErrorInfo; constructor(info: ErrorInfo, options?: { cause?: unknown }); }
export function toErrorInfo(e: unknown, fallback: { code: string; class: ErrorClass }): ErrorInfo;   // total; unknown throwables become <class>/unexpected
export const ERROR_CATALOGUE: Readonly<Record<string, { class: ErrorClass; retryable: boolean; impact: string; remediation: string; exit: number }>>;   // append-only, unit-tested unique; frozen in Wave 0
```

| Class | Retry | Run effect (default) | CLI exit | Example codes |
|---|---|---|---|---|
| configuration | no | refuse to start / FAILED | 10 | `configuration/policy-invalid`, `/phase-not-available`, `/incompatible-state-schema`, `/platform-unsupported`, `/telemetry-remote-unavailable`, `/worktree-root-protected`, `/provision-store-unavailable` |
| validation | no (escalation candidate) | agent failed → retry policy → FAILED | 11 | `validation/tool-input`, `/agent-output`, `/agent-no-result`, `/spec` |
| permission | no | `tool.denied`; repeated → `policy-violation` | 12 | `permission/tool-not-granted`, `/path-outside-grant`, `/command-not-allowed`, `/network-denied`, `/denied-by-human` |
| security | no | **BLOCKED**, agents cancelled, worktrees frozen | 13 | `security/symlink-escape`, `/protected-path`, `/write-outside-ownership`, `/runtime-pin-mismatch`, `/asset-hash-mismatch`, `/pin-tampered`, `/runtime-inside-target`, `/auth-mode-violation`, `/auth-endpoint-mismatch`, `/command-auth-invalid`, `/event-chain-broken`, `/root-refused`, `/sandbox-unavailable`, `/secret-staged`, `/command-trampoline`, `/project-policy-untrusted` *(before a run exists: refuse to start)*, `/deps-tampered`, `/review-ref-mutated` |
| provider-transient | yes, bounded backoff, visible | retry → FAILED | 14 | `provider-transient/rate-limited`, `/overloaded`, `/network`, `/credential-store-locked` |
| provider-terminal | no | FAILED, or AUTH_REQUIRED / QUOTA_EXCEEDED | 14 | `provider-terminal/auth-required`, `/quota-exceeded`, `/entitlement`, `/model-not-found`, `/policy-refused` |
| tool-transient | yes | retry once, then report to the agent | 15 | `tool-transient/spawn-failed`, `/interrupted`, `/agent-process-exit`, `/cancelled` |
| tool-terminal | no | error result to the agent | 15 | `tool-terminal/nonzero-exit`, `/output-cap`, `/patch-preimage-mismatch` |
| conflict | no | WAITING_APPROVAL or FIX | 16 | `conflict/merge`, `/zone-reserved`, `/incarnation-exists`, `/command-id-reuse`, `/run-host-alive`, `/lease-lost`, `/reconcile-human-edit` |
| budget | no | WAITING_APPROVAL(budget) | 17 | `budget/tokens`, `/tool-calls-exhausted`, `/context-window`, `/fix-rounds`, `/provider`, `/estimated-quota` |
| timeout | yes (agent/tool), no (run) | retry / WAITING_APPROVAL | 18 | `timeout/tool`, `/model-request`, `/agent`, `/run` |
| corruption | no | refuse to open; never delete a run | 19 | `corruption/event-gap`, `/projection-mismatch`, `/snapshot-hash` |
| human-required | n/a | WAITING_APPROVAL / AUTH_REQUIRED | 20 | `human-required/approval`, `/approval-timeout`, `/blocked-ack`, `/in-doubt-effect` |

**Exit codes of a process that waits for a run** (spec 21 "code de sortie"; part of the W0 exit-code table in `apps/cli/src/contract`): an
observer started by `cohorte run`, or any observer/controller given `--wait`, exits **0** on COMPLETED, **the class code of `run.lastError`**
(column above) on FAILED or BLOCKED, **4** on a suspended state (PAUSED, WAITING_APPROVAL, AUTH_REQUIRED, QUOTA_EXCEEDED: "accepted, pending
a human", the same meaning as the controller's 4) and **16** on CANCELLED. Plain `status`, `logs`, `tail` and every `--panel` mode stay at 0
whatever the run's state: they report, they do not wait. So a CI job running `cohorte run spec --yes` fails when the run fails.

Every error has code, message (cause), impact, chained cause, retryability, phase/agent (envelope), remediation and an `error` event. Human output
(spec 21): `cause / impact / run / next action / exit code`. Unknown throwables → `<nearest class>/unexpected` → FAILED + `checkpoint.created`.
The run host installs `unhandledRejection` and `uncaughtException` handlers that commit `FAILED` + checkpoint (`cause: 'fatal'`) and exit 1
instead of dying silently — it is the single writer *and* executes tool code for N agents **[X: one unhandled rejection kills a Node host]**.

### 2.9 Agent output envelope and review findings (spec 22) — home: `packages/protocol/src/agent-output.ts`

```ts
export interface Finding {                                               // [S]
  id?: FindingId;                                                        // assigned by Cohorte
  severity: Severity; kind: 'spec-violation' | 'security' | 'quality' | 'complexity' | 'check-failure';
  rule: string; location?: { file: string; line?: number; endLine?: number; symbol?: string };
  reproduction?: string; expected: string; actual: string; confidence: number; suggestedFix?: string;
  scope: 'in-scope' | 'deferred'; outOfScopeReason?: string;
}
export interface AgentOutput {                                           // [S] schemas/agent-output.schema.json === submit_result.inputSchema (flat, everything inlined)
  status: 'completed' | 'failed' | 'blocked' | 'needs-input'; summary: string /* <= 2000 */;
  artifacts: { path: string; kind: 'diff' | 'file' | 'test' | 'report' | 'contract'; sha256?: string /* ignored; Cohorte recomputes */ }[];
  findings: Finding[] /* maxItems 30 */; checks: { name: string; status: 'passed' | 'failed' | 'skipped' | 'not-run'; command?: string }[] /* claims; TEST is the truth */;
  questions: string[]; confidence: number;
  assumptions?: { gap: string; decision: string }[]; remediationAddressed?: { findingId: string; how: string }[];
}
export interface ReviewResult { verdict: 'approved' | 'findings' | 'needs-human'; kept: Finding[]; refuted: Finding[]; deferred: Finding[]; needsInvestigation: Finding[];
  blocking: number; blockingItems: string[]; fingerprint: string; unreviewed: SurfaceId[]; clean: boolean; counts: Record<Severity, number>; }
```

Normalisation is TypeScript, never prompt text (`core/src/review/normalize.ts`, table-tested against V2's cases): (1) a finding without
`location` **or** without `reproduction` → `needsInvestigation` (spec 22): never blocking, never counted `major`; `kind: 'security'` raises
`needs-human` instead of being dropped; (2) `kind: 'complexity'` is clamped to `≤ minor`; caps 20 in-scope / 10 deferred, overflow keeps critical,
security, major first; (3) a `deferred` finding whose file is in the diff's changed set is promoted; (4) identity = `<file without :line>|<first
8 words of actual, lower-cased, /[^\p{L}\p{N}]+/gu → ' '>` (Unicode-aware, **without** the surface); `blockingItems` = identities of kept
findings with `severity === 'critical' || kind === 'security'`, de-duplicated, **byte-sorted**; `fingerprint = sha256(items.map(i => i +
'\n').join(''))[0:16]`, `''` when empty; (5) the verdict is computed, never read from the model; leftovers are routed by `loop.leftovers`
(default `{ major: 'fix', minor: 'park', info: 'park' }`); `fixItems` = `blockingItems` ∪ leftovers routed `fix`, and the round fingerprint is
computed over `fixItems`; `clean = fixItems.length === 0 && no leftover routed 'ask'`. The adversarial `verifier` cross-check is a seam (role id
reserved, off in V3.0).

### 2.10 Configuration and the V3.0 subset of `.cohorte/` (spec 13, 14)

| Path | V3.0 | Notes |
|---|---|---|
| `manifest.yaml` | **in** | `{ schemaVersion: 1, cohorteVersion, createdWith, protocol: { min, max }, stateSchemaVersion, generated: { path, templateId, templateSha256, renderedSha256 }[] }` — François' detection marker (R4) and the **previous-hash guard** of spec 14: a generated file is replaced only if its current hash equals `renderedSha256` |
| `config.yaml` | **in** | human choices; comment-preserving writes through the `yaml` Document API |
| `ownership.yaml` | **in** | `surfaces: { <id>: { paths[], owners[], reviewers[], approval?: 'human' } }`; every surface path disjoint or explicitly `shared` |
| `project.yaml` | **in, minimal** | deterministic scan only (D10); **every field carries a class `human \| generated \| derived \| observed \| mixed`** (spec 13) + provenance |
| `conventions.md` | **in** (optional) | inlined in the doctrine tier with trust `human` |
| `specs/<id>.yaml` | **in** | `id, kind: feature\|patch, status: draft\|frozen, title, acceptance[], surfaces{ <id>: { tasks[] } }, contract?, openQuestions[], patch?: { repro, regressionTest, causeConfirmed }`; immutable once frozen |
| `prompts/`, `skills/` | **in** | overrides by same relative path as the shipped asset, hashed into the run snapshot, reported in `RunPlan.promptOverrides`; skills `skills/<id>/{SKILL.md,skill.yaml}` selected deterministically and inlined — never through Pi's skill mechanism. `skill.yaml` validates against **`SkillManifest`** (below; `schemas/skill.schema.json`) |
| `generated/` | **seam** | `.gitignore` + `README.md` with provenance header |
| `state/` | **in** | `cohorte.db`, `cas/`, `runs/<runId>/{snapshot/,agents/<agentId>/<n>/,artifacts/,stream/,host.log,pids/}`; gitignored by the `.cohorte/.gitignore` that `init` writes |
| `worktrees/` | **not used in V3.0** | the root is **outside the repository** (§5.1). `git.worktreeRoot` may point at any directory outside the built-in protected roots; `.cohorte/worktrees` is inside one (`<project>/.cohorte/**`, 2.6.3 step 5) and is refused with `configuration/worktree-root-protected` (D-10). `init` still writes the `worktrees/` line of `.cohorte/.gitignore` so a later version can allow it without touching projects |

```ts
export interface CohorteConfig {                                         // [S] schemas/config.schema.json — NO open question is frozen as a literal type (spec 32)
  schemaVersion: 1;
  project: { id: string; defaultBranch: string; protectedBranches: string[] };
  runtime: { id: string /* 'pi' | 'fake' */; pi?: { loadFrom: 'package' | 'bundle' } };
  authentication: { mode: AuthMode; allowApiKeys: boolean;               // defaults: subscription / false
    anthropicSubscriptionViaPi?: { enabled: boolean; acknowledgePerTokenBilling: boolean; acknowledgeProviderTermsRisk: boolean } };   // D2: all three true; accounted METERED (3.7)
  routing: { allowedProviders: string[]; defaults: Partial<Record<CohorteRole, ModelCapability>>; tiers: Partial<Record<ModelCapability, { ref: ModelRef; thinking: ThinkingLevel }>>; escalation: EscalationPolicy; fallback: { enabled: boolean } };
  budgets: { run: BudgetCounters; phase: BudgetCounters; agent: BudgetCounters; provider: Record<string, BudgetCounters>; tool: Record<string, BudgetCounters>; concurrency: number /* 3 */; maxIncarnations: number /* 5 */ };
  loop: { maxFixRounds: number; noProgressWindow: number; maxDeniedCallsPerAgent: number; leftovers: Record<'major' | 'minor' | 'info', 'fix' | 'park' | 'ask'> };
  checks: { typecheck?: string[]; lint?: string[]; test?: string[]; timeoutMs: number };            // argv arrays
  provision: { argv?: string[]; network: boolean; cacheDirs: string[]; lockfiles: string[];          // §5.7; Cohorte appends/validates --frozen-lockfile --ignore-scripts (+ pnpm: --config.package-import-method=clone-or-copy)
               env: Partial<Record<'npm_config_store_dir' | 'npm_config_cache' | 'YARN_CACHE_FOLDER' | 'COREPACK_HOME', string>>;   // the ONLY env channel of provisioning; names are a closed allowlist. Default: npm_config_store_dir = cacheDirs[0]
               dependencyDirs: string[] /* default ['**/node_modules'] : read-only for agent commands and checks */; writableCaches: string[] /* default node_modules/{.cache,.vite,.vitest,.vite-temp} : writable, excluded from the manifest, wiped before every check sequence */ };
               // cacheDirs and env are MACHINE-specific: they belong in ~/.cohorte/config.yaml (`doctor` proposes the detected store path), not in the versioned project file
  policy: { commands: { allow: CommandRule[]; ask: CommandRule[]; deny: CommandRule[] }; dangerousCommands: CommandRule[]; symlinks: SymlinkPolicy;
            approvals: { unattended: 'deny' | 'wait'; expiryMinutes?: number; parkAfterMinutes: number /* 10 */; ship: 'human' | 'auto'; notify: boolean; autoResume: boolean /* approve may spawn a host */ };
            inDoubt: 'ask' | 'continue' /* default ask: an in-doubt effect needs a human ack before the agent continues (4.4) */;
            skip: ActivePipelineState[]; steer: { enabled: boolean }; admin: { runTool: boolean }; quota: { autoResume: boolean } };
  host: { idleExitMinutes: number /* 30 */; pauseKeepAliveMinutes: number /* 30 */; pollMs: number /* 250 */ };
  network: { proxyEnv: boolean /* forward HTTP(S)_PROXY to the brain; default false */ };
  sandbox: { require?: 'native' | 'best-effort' /* absent = the computed default of 2.6.6 */; brain: 'os-if-available' | 'os' | 'process' };
  git: { worktreeRoot?: string; branchPrefix: string /* 'cohorte/' */; commitIdentity: 'user' | 'cohorte'; keepWorktrees: 'on-failure' | 'always' | 'never' };
  retention: { transcriptsDays: number; eventsDays: number | 'forever'; artifactsDays: number; compressAfterDays: number };
  telemetry: { remote: boolean };                                        // default false; `true` is rejected in 3.0 with configuration/telemetry-remote-unavailable (ADR-0013)
}
```

```ts
export interface SkillManifest {                                         // [S] schemas/skill.schema.json — spec 8, with ONE change: `checks[].command` (a shell string) becomes `argv` (D-25, I3)
  id: string; version: string;
  appliesWhen: { languages?: string[]; frameworks?: string[]; packageManagers?: string[]; roles?: string[] };   // matched against the Project Model, deterministically
  prompt: string;                                                        // relative path of the Markdown, inside the skill directory
  checks?: { name?: string; argv: string[] }[];
  signature?: string; source?: string;                                   // reserved (ADR-0011)
}
```

**Skill checks are declarative in V3.0.** They are rendered into the doctrine tier as text ("this skill expects `pnpm test` to pass"), they
are **never run by Cohorte on the skill's behalf, and they create no `CommandRule`**: the only commands that exist are those of `policy.*` and
`checks.*` in the (trusted) config. A skill is knowledge; it cannot grant a permission (spec 8). Test: adding a skill that declares a check
changes neither the `PolicySnapshot` digest nor any `PolicyVerdict`.

Load order: shipped defaults < `~/.cohorte/config.yaml` (user, optional) < `.cohorte/config.yaml` < CLI flags — **with the trust rule of
2.10.1 applied to the project layer**; the **resolved** config is written into the run snapshot and is the only config a run ever reads (§6).

#### 2.10.1 What the repository may decide, and what only the local user may decide (ADR-0026)

`.cohorte/config.yaml` is versioned: a cloned hostile repository, or a teammate's commit, writes it. Spec 10.1 wants API billing "jamais
activé automatiquement", spec 23 names prompt injection in the repository and the supply chain as threats, Pi has a project-trust gate, and
0.3 promised that `best-effort` is an explicit *human* opt-in. So every config key has a **trust class**, frozen as data next to the schema
(`CONFIG_KEY_TRUST`, `@cohorte/config/schema`):

| Class | Rule | Keys |
|---|---|---|
| `tighten-only` | the project file is honoured only when it is **at least as strict** as the layer below; a looser value is ignored with a warning | `budgets.*`, `loop.*`, `policy.commands.deny`, `policy.commands.ask`, `policy.symlinks` towards `deny-*`, `policy.approvals.{expiryMinutes, parkAfterMinutes}`, `sandbox.require: native`, `sandbox.brain: os`, `retention.*` downwards |
| `loosen` | the project file's value takes effect **only with the local user's consent** | `sandbox.require: best-effort`, `sandbox.brain: process`, `authentication.allowApiKeys`, `authentication.anthropicSubscriptionViaPi.*`, `routing.allowedProviders` (any addition), `routing.fallback.enabled`, `policy.commands.allow`, `policy.dangerousCommands`, `policy.symlinks` towards `allow`, `policy.admin.runTool`, `policy.steer.enabled`, `policy.skip`, `policy.inDoubt: continue`, `policy.approvals.{unattended: wait, ship: auto, autoResume}` and any unattended pre-authorisation, `checks.*` and `provision.{argv, network, env, cacheDirs, writableCaches, dependencyDirs}` (they are commands and paths Cohorte itself runs or opens), `network.proxyEnv`, `runtime.pi.loadFrom`, `git.worktreeRoot` |
| `neutral` | honoured as written | everything else (`project.*`, `routing.defaults/tiers` inside the allowlist, `git.branchPrefix`, `host.*`, …) |

Consent has exactly three forms, recorded as `RunPlan.trust.grantedBy`: (1) **`user-config`** — the same or a looser value is present in
`~/.cohorte/config.yaml`; (2) **`cli-flag`** — the value was given on the command line of this run (`--sandbox best-effort`,
`--trust-project-config` for CI images that own their repository); (3) **`trust-record`** — a trust-on-first-use grant. For (3) the loader
computes `policySha256 = sha256(canonicalJson(the project file's values for every loosen-class key + ownership.yaml))`, and looks it up in
`~/.cohorte/trust/<projectKeyId>.json` (`{ policySha256, loosenedKeys, grantedAt, grantedBy, mac }`, MAC with the project key, directory
`0700`, a protected root). On a miss the CLI **prints the diff of loosening keys against the last trusted value and asks**; `cohorte config
trust --show|--grant|--revoke` does the same outside a run. No TTY, `--json` without the flag, or an unattended run ⇒ **fail closed**:
`security/project-policy-untrusted`, no run row is created. The host re-checks at T04 (`config.trust-satisfied`) because it is the host that
resolves the config into the snapshot. Any later edit of a loosening key changes the hash and asks again; tightening never asks.
Tests **S-37** (a hostile fixture config with `sandbox.require: best-effort` and a `dangerousCommands` rule ends in
`security/project-policy-untrusted`, with zero processes spawned) and **S-38** (the same config, granted, then edited mid-project ⇒ a new ask;
`--trust-project-config` ⇒ `grantedBy: 'cli-flag'` in `pipeline.started`). The E2E, crash and dogfood harnesses pass
`--trust-project-config`: every fixture config sets loosening keys (`checks`, `provision.argv`), like every real project.

---

## 3. PiRuntime, FakeRuntime, fake provider

### 3.1 Decision (open question 1): candidate C, SDK embedded in a Cohorte-owned child

| Candidate | Verdict | Decisive evidence (all on 0.85.1) |
|---|---|---|
| **A** in-process SDK | rejected | A 1.5 s synchronous tool in one session stretched an unrelated session's 60 ms run to ~1.6 s, and one unhandled rejection inside a tool kills the whole host **[X sdk-07]**. Env isolation is impossible in-process: with `GROQ_API_KEY` in env and nothing stored Pi silently sends the env key, and removing a stored credential re-enables the shadowed env key; `ModelRuntime` exposes no `authContext` (model-runtime.js:71), so the only structural defence is a process with an allowlisted env **[X sdk-06]**. The SDK path has **no project-trust gate** (`SettingsManager.create` defaults `projectTrusted: true`) **[X]**. Importing Pi costs ~270 ms and +128 MB RSS, installs listeners on five signals and dlopens a native addon — inside the single-writer run host. Its one advantage is memory (~35-190 kB per session vs ~200 MB per child). |
| **B** `main(['--mode','rpc'])` + forwarding `tool_call` gate, tools in the child | rejected | The `tool_call` hook is block-only and **fail-open by omission** (no handler ⇒ bash ran un-gated) **[X]**; `shellCommandPrefix` runs *after* the gate; `main()` renames `<cwd>/.pi/commands`, creates a lock dir in the worktree and honours an **untrusted** `.pi/settings.json` `sessionDir` even under `--no-approve`; it accepts an unknown model id with a stderr warning; RPC `bash` bypasses `tool_call`; any shell in the child can run `pi auth print-bearer-token` **[X child-05, child-10, delta]**. |
| **C** brain/hands, child = Cohorte entry, forwarding tools only | **chosen** | Executed in a hostile repo: zero ambient effect, `bash`/`write` ⇒ `Tool … not found`, `../` escape and `curl` denied by the PARENT gate **[X child-01]**; approval held 25 s over IPC then executed **[child-02]**; abort acknowledged in < 20 ms, parent SIGKILL ⇒ child dead in ~20 ms, stubborn child + grandchild reaped by the ladder in ~1.5 s **[child-03]**; tool round trip 0.8 ms, cold start ~325 ms (432 ms at 4×), ~197 MB RSS per child (~148 ms / 148 MB when Pi is loaded from its own `dist/bundle`) **[child-08]**; the SDK host completes a run inside a Seatbelt profile with `(deny process-fork)` and the Node IPC channel intact **[child-09]**. |

Within C the child is written against the **SDK** (`createAgentSession`) and a Cohorte-owned `AgentHostProtocol`, not against Pi's RPC wire: one
Pi surface instead of four, typed tool frames, an attestation frame, no RPC `bash`/`switch_session`/persisting setters reachable. The delta
report's executed `createAgentSessionRuntime` + `runRpcMode` + `ctx.ui.input` host stays the **pre-validated fallback**; swapping it in touches
`packages/runtime-pi/src/child/**` only, and the spike showed that both hosts produce the same normalised durable event sequence.
This deliberately departs from upstream's "use `AgentSession` in-process for Node hosts" only in *where* the session lives.

### 3.2 Process model

```text
cohorte (CLI, short-lived) ──spawn detached──▶ cohorte __host --run <id>     one per run; owns lease, gate chain, executor, git, ALL store writes
                                                 └─ PiRuntime (parent side, imports NO Pi)
                                                     └─ per (agentId, incarnation):  <pinned node> <pinned install>/dist/agent-host.mjs
                                                          cwd   = the agent state dir  runs/<runId>/agents/<agentId>/<n>/   (NOT the worktree, NOT under the repo's tracked tree)
                                                          env   = allowlist (3.7 layer 1)          detached: true
                                                          stdio = ['ignore', 'pipe', 'pipe', 'ipc']   serialization: 'json'   (stdout/stderr are PIPES into the parent, never a raw file)
                                                          optional wrapper argv: sandbox-exec -p <profile> … | bwrap …   (3.6)
```

One child per `(agentId, incarnation)`. The child holds **no tool implementation, needs no filesystem write beyond its state dir and Pi's auth
dir, spawns no process**. Transport = the **Node `'ipc'` channel**, the one the spike executed, including under `sandbox-exec`. The same frame
schema is carried as LF-delimited JSON over fd 3/4 when a sandbox backend cannot pass the IPC fd (documented alternate; codec from
`@cohorte/protocol`). Child stdout/stderr are **pipes**: the parent line-buffers them (64 KiB line cap, 1 MiB per incarnation, then a single
"truncated" line) and writes each line through the sealed logger (`Redactor.sealText`) into `host.log` with the agent's ids; they are never
parsed. Pi can print refresh or login error bodies that contain token material (delta hazard H-3, executed in t7), and a raw file would have
bypassed I7. `disconnect` (or fd EOF) on either side means the peer died:
**the child aborts and exits immediately** — no brain survives a SIGKILLed host; the parent marks the incarnation `crashed`. The host also
records `(pid, pgid, startToken)` so recovery can kill an orphan without ever trusting a recycled pid. The child sends a `heartbeat` frame every
5 s with its RSS; three missed heartbeats ⇒ hang ⇒ cancel ladder.

### 3.3 `AgentHostProtocol` v1 (private contract #3; `packages/runtime-pi/src/protocol.ts`, TypeBox, Pi-free, **frozen in Wave 0** so the fake brain and the parent are built in parallel)

```ts
export const HOST_PROTOCOL = 1;
export type ParentFrame =                                                                   // parent -> child
  | { t: 'init'; v: 1; nonce: string; mode: 'agent'; request: SpawnRequestWire; engine: EngineSettings }
  | { t: 'init'; v: 1; nonce: string; mode: 'auth-status'; providers: string[]; engine: Pick<EngineSettings, 'authPath' | 'agentDir'> }
  | { t: 'init'; v: 1; nonce: string; mode: 'auth-login' | 'auth-logout'; provider: string; engine: Pick<EngineSettings, 'authPath' | 'agentDir'> }
  | { t: 'prompt'; id: string; text: string; note?: { text: string } }                      // both read by the PARENT (TaskInput / Continuation.note, hash-verified). The child delivers `text`, then `note.text`,
                                                                                            // before the first model request (2.2.3, conformance rule 12; two-message delivery is tripwire [A-8])
  | { t: 'send'; id: string; messageId: string; text: string; delivery: 'steer' | 'follow-up' }
  | { t: 'tool.result'; toolCallId: string; isError: boolean; content: ToolContent[]; terminate: boolean; resultRef?: string }
  | { t: 'pause' } | { t: 'resume' } | { t: 'stop-after-turn'; reason: string }
  | { t: 'abort'; id: string; reason: string }
  | { t: 'auth.answer'; id: string; value: string }
  | { t: 'inspect'; id: string } | { t: 'shutdown' };
export type ChildFrame =                                                                    // child -> parent
  | { t: 'hello'; v: 1; pid: number; nonce: string }                                        // first thing the entry does
  | { t: 'ready'; attestation: Attestation }
  | { t: 'event'; seq: number; event: HostEvent }                                           // already normalised: NO Pi type crosses the channel
  | { t: 'tool.call'; seq: number; ordinal: number; engineToolCallId: string; tool: string; input: JsonValue }
  | { t: 'tool.call.abandoned'; engineToolCallId: string; reason: 'aborted' | 'shutdown' }
  | { t: 'provider.response'; requestId: string; status: number; headers: Record<string, string> }     // ALLOWLISTED header names only (x-ratelimit-*, retry-after, x-codex-*)
  | { t: 'provider.request'; requestId: string; origin: string; authScheme: 'bearer-jwt' | 'bearer-opaque' | 'api-key-header' | 'none'; refused: boolean }   // from the GUARD FETCH (3.7 layer 5): what actually left the process. Never a header VALUE
  | { t: 'parked'; at: 'model-boundary' }
  | { t: 'heartbeat'; rssMb: number; state: string }
  | { t: 'auth.status'; statuses: ProviderAuthStatus[] } | { t: 'auth.show'; event: JsonValue } | { t: 'auth.ask'; id: string; prompt: JsonValue } | { t: 'auth.done'; status: ProviderAuthStatus }
  | { t: 'settled'; exit: Omit<AgentExit, 'error'>; signal?: ErrorSignal }                   // the PARENT classifies: exit.error = classify(signal) (3.8)
  | { t: 'response'; id: string; ok: boolean; data?: JsonValue; error?: ErrorInfo }
  | { t: 'fatal'; error: ErrorInfo; signal?: ErrorSignal };                                 // `error` for the child's OWN typed fatals (asset hash, endpoint mismatch…); `signal` when an engine error caused it
/** What the child extracts from a thrown value or an error message, so that the classifier is a PURE, Pi-free function in the parent (3.8). Only child code looks at engine classes. */
export interface ErrorSignal { modelsErrorCode?: string /* ModelsError.code */; causeCode?: string /* errno-style code of the innermost cause: ELOCKED, EPERM, EACCES, EBUSY, ECONNRESET, ABORT_ERR… */;
  httpStatus?: number; text: string /* sealed by the parent before it goes anywhere */; origin: 'prompt-preflight' | 'model-response' | 'auth-check' | 'login' | 'engine'; }
export interface EngineSettings { authPath: string; agentDir: string; sessionFile: string; loadFrom: 'package' | 'bundle'; expectedEngineVersion: string; responseHeaderAllowlist: string[]; }
export interface Attestation {                       // what the child PROVES before the first prompt; the parent fails the spawn closed on ANY mismatch
  engine: { name: string; version: string; packageVersions: Record<string, string> /* the three Pi packages MUST be equal */ }; hostProtocol: 1;
  activeTools: string[];                             // MUST equal the grant exactly, and so must the registry (allowlist typos vanish silently in Pi)
  effectiveSystemPromptSha256: Sha256;               // sha256(session.systemPrompt) = Cohorte's prompt + "\nCurrent working directory: <cwd>\n" (the date line is gone since 0.80.7)
  systemPromptPrefixOk: boolean; extensionsLoaded: 0; extensionErrors: 0; modelFallback: false;
  auth: { provider: string; type: 'oauth' | 'api_key'; source: string; subscription: boolean };        // from ModelRuntime, no secret (3.7)
  effective: { provider: string; model: string; api: string; baseUrl: string };                        // MUST equal AuthRequirement.baseUrl / the requested model
  settings: { compaction: false; agentRetry: false; providerMaxRetries: 0; transport: 'sse' };
  hooks: { streamWrapperInstalled: boolean; guardFetchInstalled: boolean; onResponseChained: boolean; shouldStopAfterTurn: boolean };
  sessionFile: string; sessionId: string; envKeys: string[]; platform: string;                         // NAMES of env vars visible to the child; diffAttestation checks them against allow ∪ OS_INJECTED_ENV[platform]
                                                                                                       // (mirrored from @cohorte/security/contract/builtin.ts as a constant of this file: runtime-pi may not import security)
}
```

All child→parent text (`fatal.error.message`, event previews, `provider.response` header values) is treated as untrusted input: validated against
the frame schema, sealed, and tool arguments are re-validated strictly by the gate.

### 3.4 The child (`packages/runtime-pi/src/child/entry.ts`) — the only Pi-importing code, near-final

```ts
import type { ResourceLoader, ToolDefinition, AgentSession } from '@earendil-works/pi-coding-agent';   // exact pin 0.85.1 — TYPES only in this file
import type { TSchema } from 'typebox';
import { loadPi } from './load-pi.ts';   // the ONE file that obtains Pi VALUES (check-layers rule g exemption): literal specifiers for loadFrom 'package';
                                         // for 'bundle', a specifier built only from the pinned install path. Returns { createAgentSession, createExtensionRuntime,
                                         // defineTool, ModelRuntime, SessionManager, SettingsManager, ModelsError, lazyStream } from ONE module graph, so
                                         // `instanceof ModelsError` is meaningful; signalOf() also accepts the structural form (name === 'ModelsError' && typeof code === 'string').

/** `setup` is the ONLY seam the never-bundled test entry uses (faux provider / injected fetch / in-memory credentials). Production passes none. */
export async function boot(init: InitAgentFrame, setup?: ProviderSetup): Promise<void> {
  const { request: req, engine } = init;
  const { createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, SessionManager, SettingsManager, lazyStream } = await loadPi(engine);
  assertPiVersions(engine.expectedEngineVersion);                         // pi-coding-agent, pi-ai, pi-agent-core: all three equal, else fatal
  const prompt = readVerified(req.systemPrompt);                          // sha256 check or fatal security/asset-hash-mismatch
  const modelRuntime = setup?.modelRuntime ?? await ModelRuntime.create({ // [85] model-runtime.d.ts
    authPath: engine.authPath,                                            // the user's real Pi auth.json: shared store, never copied (R7)
    modelsPath: null, allowModelNetwork: false });                        // no models.json (baseUrl reroute), no catalogue fetch. `refreshOnCreate` is LEFT AT ITS DEFAULT: create() then runs
                                                                          // refresh({ allowNetwork: false }) (model-runtime.js:97-103), which is what FILLS the auth snapshot. With `refreshOnCreate:false`
                                                                          // the snapshot stays empty (:51-57) and isUsingSubscription()/getProviderAuthStatus() are false/unconfigured for ever [85].
                                                                          // PI_OFFLINE=1 + allowModelNetwork:false keep that refresh offline. NEVER call refresh() without allowNetwork:false
  if (modelRuntime.getError()) fatal('configuration/engine-init', modelRuntime.getError());
  const model = modelRuntime.getModel(req.model.provider, req.model.model) ?? fatal('provider-terminal/model-not-found');   // never pi-ai/compat getModel, never findInitialModel
  if (model.baseUrl !== req.auth.baseUrl) fatal('security/auth-endpoint-mismatch');
  await assertAuth(modelRuntime, req.auth);                               // 3.7 layer 3 — decides on LIVE secret-free calls (checkAuth, listCredentials, getProvider); snapshot accessors are cross-checks only

  const settingsManager = SettingsManager.inMemory(                       // never SettingsManager.create: the SDK path trusts the project by default [X]
    { transport: 'sse', compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, steeringMode: 'all', enableInstallTelemetry: false },
    { projectTrusted: false });
  const resourceLoader: ResourceLoader = {                                // LITERAL 11-method loader: zero filesystem discovery [X]
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {} };
  // engine.sessionFile was pre-created EMPTY (wx, 0600) by the parent => Pi writes the header and every entry eagerly (no lazy-write gap) [X]
  const sessionManager = SessionManager.open(engine.sessionFile, undefined, req.workingDirectory);      // cwdOverride: ignore any header cwd

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: req.workingDirectory,                                            // a LABEL: it only feeds Pi's "Current working directory" line. process.cwd() is the state dir
    agentDir: engine.agentDir,                                            // Cohorte-owned: no settings.json, no trust.json, no models.json, no extensions
    modelRuntime, model, thinkingLevel: req.thinking,
    settingsManager, resourceLoader, sessionManager,
    tools: req.tools.map(t => t.tool),                                    // ALLOWLIST: read/bash/edit/write are removed from the registry => "Tool bash not found" [X]
    customTools: req.tools.map(forwardingTool) });
  if (modelFallbackMessage) fatal('provider-terminal/model-not-found', modelFallbackMessage);

  // ── EVERYTHING below is assigned BEFORE the first prompt(): createLoopConfig() captures onPayload, onResponse, transport, toolExecution,
  //    beforeToolCall, afterToolCall and shouldStopAfterTurn ONCE PER RUN (pi-agent-core agent.js:287-305), and streamFunction is passed at agent.js:272.
  const agent = session.agent;
  agent.toolExecution = 'sequential';                                     // deterministic ordinals
  agent.transport = 'sse';                                                // the default "auto" tries WebSocket first and that path never calls onResponse [X]
  agent.shouldStopAfterTurn = (ctx) => budget.afterTurn(ctx) || flags.stopAfterTurn;   // a closure over LIVE flags: works although the function is captured per run
  const innerStream = agent.streamFunction;                               // the CLASS FIELD is `streamFunction`. `streamFn` is only the AgentOptions constructor option (agent.d.ts:9 vs :39)
  const guardedFetch = guardFetch(setup?.fetch ?? globalThis.fetch, { origin: new URL(req.auth.baseUrl).origin, mode: req.auth.mode }, send);   // PRODUCTION code, not a test hook (3.7 layer 5)
  // StreamFn CONTRACT (pi-agent-core types.d.ts:3-13): it must NOT throw and must NOT return a rejected promise; failures are encoded IN the returned stream.
  // An `async` wrapper that awaits the latch or throws on a budget breach violates it: the rejection can kill the child, be classified as a retryable
  // process exit and be re-spawned until maxIncarnations. lazyStream (pi-ai api/lazy.d.ts:8) returns the stream synchronously and turns a setup failure into an error event [X t9].
  agent.streamFunction = (model, context, options) => lazyStream(model, async () => {
    await latch.passModelBoundary(options?.signal);                       // an abort while parked rejects HERE -> clean 'error'/'aborted' stream, zero model requests
    budget.beforeRequest();                                               // a breach throws HERE -> same path; the parent already recorded the typed stop cause ('budget')
    requests.begin();
    return innerStream(model, context, { ...options, fetch: guardedFetch }); });
  const innerOnResponse = agent.onResponse;                               // the SDK already installed one (extension forwarding): CHAIN, never replace
  agent.onResponse = async (r, m) => { send({ t: 'provider.response', requestId: requests.current(), status: r.status, headers: pick(r.headers, engine.responseHeaderAllowlist) }); return innerOnResponse?.(r, m); };
  // agent.beforeToolCall / agent.afterToolCall are OWNED by AgentSession (_installAgentToolHooks): NEVER assign them.

  session.subscribe(e => normalise(e).forEach(ev => send({ t: 'event', seq: ++seq, event: ev })));       // never await session.abort() inside this listener
  send({ t: 'ready', attestation: attest(session, modelRuntime, req, { streamWrapperInstalled: agent.streamFunction !== innerStream, guardFetchInstalled: true, … }) });
}

export async function runPrompt(session: AgentSession, text: string): Promise<void> {
  try { await session.prompt(text, { expandPromptTemplates: false }); }   // a task starting with '/' is sent verbatim. prompt() resolves after agent_settled…
  catch (e) {                                                             // …but it REJECTS at preflight ("No API key found for <p>.", credential store read failure) [X]:
    send({ t: 'settled', exit: exitOf('engine-error'), signal: signalOf(e, 'prompt-preflight') });   // an uncaught rejection would kill the child and be misread as a retryable crash.
  }                                                                       // signalOf() is the ONLY place that looks at engine error classes; the PARENT classifies (3.8)
}

function forwardingTool(g: ToolGrant): ToolDefinition {
  return defineTool({
    name: g.tool, label: g.tool, description: g.description,
    parameters: g.inputSchema as unknown as TSchema,                      // plain JSON Schema is accepted at runtime [X]
    executionMode: 'sequential',
    ...(g.terminal ? { constrainedSampling: { type: 'json_schema', strict: 'prefer' } } : {}),          // host validation stays authoritative [A-6]
    async execute(engineToolCallId, params, signal) {
      if (signal?.aborted) throw new Error('CANCELLED');                  // first statement, always
      await latch.passToolBoundary();
      const r = await callParent({ t: 'tool.call', seq: ++seq, ordinal: ++ordinal, engineToolCallId, tool: g.tool, input: params }, signal);   // RACED against signal: Pi cannot pre-empt execute() [X]
      if (r.isError) throw new Error(textOf(r.content));                  // throwing is the only way to set isError in Pi. A thrown error CANNOT carry `terminate`
      if (r.terminate) session.clearQueue();                              //   (agent-loop builds the error result itself): "deny and stop" = the PARENT also sends `abort`.
      return { content: r.content, details: { resultRef: r.resultRef }, terminate: r.terminate };
    } });
}
```

Settle detection uses the `agent_settled` event + `session.waitForIdle()`. Close: `session.clearQueue(); void session.abort(); try {
session.dispose() } catch {}` (dispose can throw `AggregateError`) then `process.exit`. Auth modes (`auth-status`, `auth-login`,
`auth-logout`) run in the same entry with a `ModelRuntime` only: `login(provider, 'oauth', interaction)` is bridged to `auth.show`/`auth.ask`
frames, **its return value (a `Credential`) is dropped unread**, and `PI_OFFLINE` is not set in login mode.

### 3.5 Tool forwarding, budget, pause, cancel, structured result

- **Gate placement.** Entirely in the run host: the parent turns a `tool.call` frame into `ToolHost.handleToolCall`. The child cannot skip the
  gate because it has nothing to execute; Pi's `tool_call`/`beforeToolCall` hooks are not used, so "fail-open by omission" is moot.
- **Identity.** `ToolCallId = tc_<incarnation>_<ordinal>`, assigned by the **parent** from the frame's gapless `ordinal`; Pi's id is kept as
  `engineToolCallId`. Deterministic ids make the effect journal replayable.
- **Budget.** Child: `shouldStopAfterTurn` (turns, cumulative tokens from the assistant `message_end` usage) and the `streamFunction` wrapper
  (`maxModelRequests`, `maxContextTokens` via `session.getContextUsage()`). The wrapper honours the `StreamFn` no-throw contract through
  `lazyStream` (3.4): a breach, or an abort while parked at the model boundary, ends the run with `settled` + the parent's typed cause, zero
  unhandled rejections and zero extra model requests (tripwire `tw-stream-contract.itest.ts`). Parent (belt, always on): sums `model.responded`, wall clock, tool
  calls; on a hard breach it answers the next call `isError + terminate` **and** sends `abort` (a denied tool alone lets the model keep trying).
  The exit cause is the **adapter's typed cause recorded before acting**, never Pi's `stopReason`: an abort between provider calls yields
  `stopReason "error"` + "This operation was aborted", indistinguishable from an HTTP 500 **[X]**. `maxOutputTokens` per request is not
  enforceable on `openai-codex` → capability `no`. Hidden model calls are eliminated (compaction off, agent retry off, provider `maxRetries: 0`).
- **Pause** (spec 5.2, 17.2) is implemented **inside PiRuntime**, not only in core. *Tool boundary* (always available): the parent stops turning
  new `tool.call` frames into `handleToolCall`; an in-flight host operation completes and its result is delivered. *Model boundary*, primary:
  the `pause` frame closes the child latch, the next `streamFunction` call parks and the child emits `parked` — **advertised `yes` only once
  assumption A-1 is proven by test**. *Model boundary*, fallback (executed primitive): `stop-after-turn` makes `shouldStopAfterTurn` return
  true, the loop stops gracefully at the end of the current turn, and `resume` re-prompts with a `[cohorte] continue` host note. Until A-1 is
  green, `capabilities()` reports `pause.modelBoundary: partial ("stop-after-turn + continue note")` and `budgetEnforcement.modelRequests/
  context: partial ("parent-side count + abort")`.
- **Cancel ladder.** `abort` frame → the parent settles every pending `handleToolCall` as aborted **first** (a gate that never releases makes
  `session.abort()` hang) → the child calls `session.abort()` without awaiting → `settled{cancelled}` expected within 5 s → else `SIGTERM` to
  the process group → 2 s → `SIGKILL`. The brain has no subprocesses; hands are killed by the `Executor`'s own kill-tree.
- **Structured result.** `submit_result` is an ordinary `ToolGrant` with `terminal: true` whose schema is `AgentOutput`. Pi rejects
  schema-invalid arguments before `execute` (free self-correction); the host re-validates strictly per role, stores the artifact, answers
  `terminate: true`. A `submit_result` batched with another tool does not terminate the loop **[X]** → the parent treats the first accepted
  result as final and sends `abort`. The "call `submit_result` alone, last" instruction lives in Cohorte's system prompt and in the tool
  description (Pi's `promptSnippet`/`promptGuidelines` are dead under a custom prompt).
- **Transcript.** Pi's JSONL at `runs/<runId>/agents/<agentId>/<n>/session.jsonl` (path chosen by Cohorte, R8: never Pi's global sessions dir)
  plus `frames.ndjson` (the host-protocol wire log = replay fixture for the fake brain). Both are `sensitive` artifacts: gitignored, gzip after
  `compressAfterDays`, deleted after `transcriptsDays` — applied by `cohorte gc` (5.9), never to a non-terminal run. Tool results reach Pi already sealed; assistant text is raw model output, hence
  "sensitive". The prompt, context manifest and task are persisted by Cohorte **before** spawn (spec 3.3). V3.0 never resumes from a transcript.

### 3.6 Sandboxing the brain

`SandboxPolicy` for a Pi child: `readOnly` = Node, the pinned install dir, the run snapshot dir; `readWrite` = its agent state dir, the
Cohorte-owned Pi agent dir, and Pi's `auth.json` **directory** (Pi's file credential store creates a lock directory next to `auth.json` even
for reads: a read-only store fails with `EPERM` **[X child-09]**; OAuth refresh rotates tokens under Pi's own lock); `denyRead` =
`~/.cohorte/{keys,trust}`, the state DB, `~/.ssh`, `~/.aws`, `~/.gnupg`; `network.mode = 'provider-only'`. **macOS: the Seatbelt profile from the spike
is ON by default** (`deny default`, `deny process-fork`, write only the state dirs, outbound to the provider port) — config
`sandbox.brain: 'os-if-available'`. Honest limits, reported verbatim in `capabilities().brainSandbox` and `agent.spawned.isolation`: Seatbelt
filters by port, not by remote hostname (`network: partial`; a hostname allowlist needs a Cohorte egress proxy, V3.2); `sandbox-exec` is
deprecated by Apple but works on Darwin 25, so `doctor` probes it; Linux = `bwrap` read-only bind of the same roots, network namespace kept,
status `partial` until the Wave-0 probe has run.

### 3.7 Auth-mode guarantee (D3) — six layers, each one tested (S-40..S-46)

1. **Allowlisted child env**: `PATH, HOME, LANG, LC_ALL, TZ, TMPDIR, NODE_OPTIONS(fixed: --max-old-space-size=512),
   PI_OFFLINE=1, PI_SKIP_VERSION_CHECK=1, PI_TELEMETRY=0, PI_CODING_AGENT_DIR=<Cohorte-owned>` + proxy variables only if `network.proxyEnv` is
   configured. No `*_API_KEY`, `*_TOKEN`, `AWS_*`, `GOOGLE_*`, `GH_*`, `ANTHROPIC_*`, `OPENAI_*`. The attestation returns the *names* actually
   visible; the parent fails the spawn if any name is outside **`allow ∪ OS_INJECTED_ENV[platform]`** (2.6.6: on darwin CoreFoundation adds
   `__CF_USER_TEXT_ENCODING` to every process — an exact-allowlist check would refuse every spawn on macOS, the fake brain included; and
   `NODE_CHANNEL_FD` is *not* in the visible set: Node deletes it before user code runs). This is the only lever `ModelRuntime` leaves: the "nothing stored
   + env key ⇒ paid API" path is unchanged at 0.85.1 for every api-key provider.
2. **Cohorte-owned agent dir** (`~/.cohorte/pi-agent/`, `0700`, protected root): no `models.json` (`modelsPath: null`), no `settings.json`, no
   `trust.json`, no extensions. Only `authPath` points at Pi's real store, so François and Cohorte share one login (R7) and Cohorte never
   copies or rewrites credentials.
3. **Typed pre-spawn check in the child** `assertAuth`, decided on **live, secret-free calls** — never on the snapshot accessors, which are
   empty until a refresh and stale afterwards (delta hazard H-4; `isUsingSubscription` and `getProviderAuthStatus` read only
   `this.snapshot`, model-runtime.js:330-338 and :411-421 **[85]**):
   (a) `(await checkAuth(p))?.type === 'oauth'`; (b) `(await listCredentials())` contains `{ providerId: p, type: 'oauth' }` (a
   `CredentialInfo` is `{ providerId, type }`: no secret); (c) for `openai-codex`, `getProvider(p).auth.apiKey === undefined`.
   Then, **as cross-checks only**, after an explicit `await refresh({ providers: [p], allowNetwork: false })`: `isUsingSubscription(p)` must be
   true and `getProviderAuthStatus(p).source` must be `'stored'` (never `runtime | environment | fallback | models_json_*`); a cross-check that
   contradicts (a)-(c) fails closed like the primary checks. Anything else → `fatal provider-terminal/auth-required`
   (`auth.required.cause: absent | mode-mismatch | ambient-source`) or `security/auth-mode-violation` when an api-key credential is found while
   the mode is `subscription`. A credential-store lock timeout is `provider-transient/credential-store-locked`, **never** AUTH_REQUIRED (3.8).
   Tripwire `tw-auth-snapshot.itest.ts` pins both behaviours on every Pi bump: with `refreshOnCreate: false` the accessors are false although
   a credential is stored (so nobody re-adds the flag), and after `refresh()` they agree with the live calls.
   **Cohorte code never calls `readStoredCredential` (it returns `Credential`, i.e. the OAuth `access` and `refresh` tokens), never calls
   `modelRuntime.getAuth()` (returns the bearer), never runs `pi auth print-*`** — enforced by `check-layers` rule (e) (spec 10.1 MUST). One
   consequence is accepted and listed as D-24: Pi 0.85.1 exposes the account id only through `readStoredCredential()`, so
   `ProviderAuthStatus.accountLabel` stays absent for Pi.
4. **Explicit model, explicit provider allowlist, pinned endpoint**: no `findInitialModel`; `modelFallbackMessage` ⇒ fatal;
   `model.baseUrl === AuthRequirement.baseUrl` (`https://chatgpt.com/backend-api` for `openai-codex`). V3.0 allowlist = `openai-codex`
   (OAuth-only by declaration at 0.85.1: env, a stored api_key entry and a request `apiKey` override all resolve to undefined **[X]**).
5. **Per-request evidence, asserted in the parent.** Comparing `model.responded.effectiveModel` and `authSource` with the plan is only an
   echo: both values come from the child's own static model data and from its own layer-3 result. The independent evidence is the
   **guard fetch**, production code installed through the executed `options.fetch` seam (pi-ai `SimpleStreamOptions.fetch`, honoured by
   `openai-codex-responses.js:265` **[85]**): before any byte leaves, it (a) requires the request origin to equal the pinned `baseUrl`
   origin, (b) refuses a request carrying `x-api-key` or `api-key`, (c) classifies the `Authorization` scheme **without reading it out**
   (`bearer-jwt` for a three-segment token, `bearer-opaque`, `none`), and (d) reports `{ origin, authScheme, refused }` in a
   `provider.request` frame. A refused request surfaces as an error stream (never a rejection). The parent asserts, per request: origin ==
   plan, `authScheme == 'bearer-jwt'` for `openai-codex` in subscription mode, `refused == false`, and only then the echoed
   `effectiveModel`/`authSource`; a contradiction ⇒ `security/auth-mode-violation` ⇒ BLOCKED. The guard is **not a test hook**: the
   packaging test's forbidden strings stay `faux`, `registerNativeProvider`, `InMemoryCredentialStore`, and it additionally asserts that
   `agent-host.mjs` **contains** `guardFetch`. For an API whose adapter rejects a custom `fetch`, the attestation says
   `guardFetchInstalled: false`, `subscriptionModeAssertion` is reported `partial` for that provider, and V3.0's allowlist contains no such API.
6. **Cohorte stamps accounting itself** from its own `BILLING` table (`providers/src/billing.ts`), never from Pi's `isSubscription` flag and
   never from pi-ai's always-computed catalogue `cost` (dropped at the child boundary):

   | Provider via Pi OAuth | `authMode` recorded | `billing` | `monetaryCost` |
   |---|---|---|---|
   | `openai-codex` | `subscription` | `plan-limits` | `not_applicable` |
   | `anthropic` (D2 opt-in) | **`api`** | **`metered`** | `{ amount, basis: 'estimate', priceCatalogVersion }` — **never** `not_applicable` |
   | any provider under `allowApiKeys` | `api` | `metered` | `{ amount, basis: 'catalogue', … }` |

   Pi's own 0.85.1 documentation states that Anthropic subscription auth used from a third-party harness "draws from extra usage and is billed
   per token, not against Claude plan limits" (`docs/providers.md:35`). The D2 opt-in is therefore kept but **accounted as metered**: it needs
   `anthropicSubscriptionViaPi.{enabled, acknowledgePerTokenBilling, acknowledgeProviderTermsRisk}` all true, appears in `RunPlan.meteredProviders`,
   opens an `api-billing` approval at run start unless the unattended policy pre-authorises it — a pre-authorisation that, like the opt-in block
   itself and `allowApiKeys`, is a **loosening key honoured only with the local user's consent** (2.10.1): a repository cannot switch its
   cloner to per-token billing — and `doctor`/`auth status` print both caveats
   (per-token billing; provider terms reserve subscription OAuth for first-party clients, F4). Cohorte implements no identity spoofing itself.
   `authMode` can never change inside a run.

### 3.8 Error classification (`packages/runtime-pi/src/classify/**`, a PURE function, table-tested)

`classify(signal: ErrorSignal): ErrorInfo` lives in the **Pi-free parent area** (check-layers rule b forbids `@earendil-works/` there), so it
cannot evaluate `e instanceof ModelsError`. The split is therefore: **only child code looks at engine classes** — `signalOf(e, origin)`
extracts the wire shape `{ modelsErrorCode?, causeCode?, httpStatus?, text, origin }` (3.3) — and the parent classifies that shape, which makes
the whole table testable without Pi. Inputs, in priority order: (1) `modelsErrorCode` **together with** `text` and `causeCode` (the code
alone is not a discriminator, see below); (2) `httpStatus` (from the last `provider.response` of the request); (3) a leading `NNN: ` status
prefix in the text (the `openai-completions` shape); (4) known texts; (5) the child's own `fatal`/exit. **Pi's `AssistantMessage.stopReason`
is never a discriminator.**

Why the code alone is not enough **[85]**: in pi-ai 0.85.1 `ModelsError('auth', …)` is thrown for *"Credential store read failed"* /
*"modify failed"* / *"delete failed"* (models.js:219, :336, :348; auth/resolve.js:97, :129) as well as for *"Provider is not configured"*
(models.js:366), and `ModelsError('oauth', …)` wraps **any** refresh failure, a network timeout included (auth/resolve.js:90). Mapping
`{auth, oauth}` straight to AUTH_REQUIRED would send a locked store or a dropped connection to a human login — against layer 3's own rule and
against delta row V.4.1.

| Signal | ErrorInfo |
|---|---|
| `modelsErrorCode: 'auth'` **and** (`text` matches `/^Credential store (read\|modify\|delete) failed/` **or** `causeCode ∈ {ELOCKED, EPERM, EACCES, EBUSY}`) | `provider-transient/credential-store-locked` (bounded retry; never AUTH_REQUIRED) |
| `modelsErrorCode: 'auth'` **and** `text` matches `Provider is not configured` \| `No API key` \| `does not support … login`; attestation/auth probe not oauth; 401/403 without usage-limit text | `provider-terminal/auth-required` → AUTH_REQUIRED |
| `modelsErrorCode: 'oauth'` **and** a network-class cause (`text`/`causeCode`: `fetch failed`, `AbortError`/`ABORT_ERR`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, an embedded 5xx) | `provider-transient/network` (bounded retry, visible as `retry.scheduled`; after the bound: FAILED, not AUTH_REQUIRED) |
| any other `modelsErrorCode: 'oauth'` (refresh rejected, token expires too soon, derivation failed) | `provider-terminal/auth-required` (`auth.required.cause: refresh-failed \| expired \| revoked`) → AUTH_REQUIRED |
| `modelsErrorCode: 'auth'` matching none of the rows above | `provider-terminal/auth-required` with `details.unclassified: true` + a `runtime.warning` (fail towards the human, and leave a trace so the table gets a row) |
| usage-limit text with `Try again in ~N min`, or 429 with reset headers | `provider-terminal/quota-exceeded`, `retryAfterMs` → QUOTA_EXCEEDED |
| 429 without reset information | `provider-transient/rate-limited` |
| usage-limit text with a non-429 status (`usage_not_included`), 400 model/entitlement | `provider-terminal/entitlement` (human-required) |
| 5xx, overloaded, broken stream, non-JSON SSE, HTML body, socket destroyed | `provider-transient/*` |
| context overflow text / `maxContextTokens` | `budget/context-window` → new incarnation with a smaller Cohorte-built context, never Pi's compaction |
| `stop: 'length'` | `agent.exited{stop:'output-truncated'}`; that message's tool calls are rejected unexecuted by Pi → `tool.call.rejected` |
| engine stop reason `pending` or `deferred` (new in pi-ai 0.85.1, types.d.ts:287; never expected: deferred responses are not used) | normalised by the child to `stop: 'error'` + `runtime.warning{engine-stop-reason-unmapped}` |
| child exit without `settled`, `disconnect`, heartbeat lost, OOM | `tool-transient/agent-process-exit` → `outcome: 'crashed'` → new incarnation |
| attestation mismatch, unknown tool name proposed, frame schema violation | `security/*` → BLOCKED |

**Observability limit, stated:** `onResponse` fires for non-2xx responses **only** on `openai-codex-responses` (raw `fetch`,
`openai-codex-responses.js:281`, before `response.ok`). On `openai-completions` and `openai-responses` the OpenAI SDK throws first
(`providerResponsesRelayed: []` for 401/429 in the spike), and on any API the default WebSocket-first transport never calls it — hence
`transport: 'sse'` and hence the fake HTTP provider of 3.10. Every retry is Cohorte's and visible as `retry.scheduled` (Pi's agent retry even
classifies the ChatGPT plan-limit string as transient, another reason it stays off). The table test of the parent has one case per row,
including the three `auth` rows and the two `oauth` rows; a child tripwire (`tw-credential-lock.itest.ts`) pins the premise: a locked temp
`authPath` yields `ModelsError` code `'auth'` with the "Credential store … failed" text.

### 3.9 Runtime pinning (spec 16) and the capabilities PiRuntime reports

`PiRuntimeProvider.pin()` hashes (a) every file under the install's `dist/` (both bundles + chunks, equal to `bundle-manifest.json`);
(b) **the package tree of the three Pi packages the brain loads** — `package.json` + every file under `dist/` of `pi-coding-agent`, `pi-ai`,
`pi-agent-core` as one sorted `{path,size,sha256}` tree digest (not just `package.json` + `dist/index.js`: ~1500 files are actually loaded, and
only `pi-coding-agent` ships an `npm-shrinkwrap.json`); (c) the install's lock evidence (`node_modules/.package-lock.json` or
`.modules.yaml`) for the transitive closure; (d) `process.execPath` + Node version. Every `spawn` re-verifies with a stat cache keyed by
`(dev, ino, size, mtimeNs)` and re-hashes on change; a mismatch is `security/runtime-pin-mismatch`. Pi is resolved with
`import.meta.resolve` from the pinned bundle (`require.resolve` fails on the package **[X]**), never `pi` on PATH. Transitive dependencies are
covered by the lock evidence only ⇒ `runtimePinning: partial`, said so. **A gate or unit build has no lock evidence of its own**
(`<dir>/.publish/node_modules` is a symlink into the workspace, 1.4 step 7): `pin()` follows the link for (b), **skips the `install-lock`
artifact**, and records `diagnostics.installLock: 'absent (linked development build)'`; the packaging test asserts that a real `npm install`
produces the artifact, and `doctor` warns when a run is started from a linked build outside tests. `runtime.pi.loadFrom: 'bundle'` (Pi's own `dist/bundle/index.js`:
~2.2× faster cold start, ~50 MB less RSS, ~50 files to hash) is an opt-in behind a `doctor` check because OAuth refresh/login under that layout
is unproven [A-4].

`capabilities()` for Pi 0.85.1 in this embedding — the values `doctor` prints verbatim:

| Capability | Value |
|---|---|
| `toolExecution` | `host-delegated` |
| `streaming`, `thinkingStream`, `send.followUp`, `send.steer`, `cancelCooperative`, `cancelHard`, `pause.toolBoundary`, `processIsolation`, `envFiltering`, `usageReporting`, `effectiveModelReporting`, `subscriptionModeAssertion`, `budgetEnforcement.{turns,tokens,wallClock}` | `yes` |
| `authStatusWithoutSecret` | `partial` ("state, type, source and billing without a secret; the non-secret account label is not exposed by the engine: Pi 0.85.1 has no metadata-only accessor, D-24") |
| `pause.modelBoundary`, `budgetEnforcement.{modelRequests,context}` | `partial` until test A-1 is green, then `yes` |
| `hiddenModelCalls` | `no` (compaction, agent retry and provider retries are off) |
| `continuationFromTranscript` | `no` ("V3.0 resumes with a fresh incarnation and a reconciliation note") |
| `brainSandbox` | macOS `partial` ("Seatbelt, port-level network filter, deprecated tool"); Linux `partial` ("bwrap read-only bind; probe pending"); else `no` |
| `resourceLimits` | `partial` (`--max-old-space-size` only) |
| `quotaReporting` | `partial` ("HTTP status + allowlisted headers, SSE transport, openai-codex-responses only; header names provider-specific; no remaining-quota API in Pi") |
| `budgetEnforcement.outputTokensPerRequest` | `no` (ignored on openai-codex) |
| `systemPromptExact` | `partial` ("Pi appends one `Current working directory` line, recorded as effectiveSystemPromptSha256; under Anthropic OAuth pi-ai injects an identity block") |
| `runtimePinning` | `partial` ("agent-host bundle + Pi package trees hashed; transitive deps by lock evidence") |
| `platforms` | darwin `yes`, linux `yes`, win32 `no` ("kill-tree, sandbox and worktree path limits unvalidated") |
| `hints` | `{ memoryPerAgentMb: 200, coldStartMs: 330, maxConcurrentAgents: 3 }` |

### 3.10 FakeRuntime and the fake provider

`FakeRuntime` implements the same `AgentRuntime`, in-process, with **no timers and no randomness** unless the script asks: it runs on the
injected `Clock`/`IdSource`, and — because of rule C1 — every scripted tool call goes through the *real* `ToolHost` (real gate, real executor,
real journal). That is what makes "Pi peut être remplacé par un fake runtime" (spec 29) a meaningful test rather than a mock. It keeps a
`FakeLedger` of every `SpawnRequest` so tests assert that a retry's request is byte-identical apart from `incarnation`.

```ts
export interface FakeScript { version: 1; agents: FakeAgentRule[]; defaults?: { usagePerTurn?: TokenUsage; model?: string } }   // [S]; YAML/JSON loadable
export interface FakeAgentRule { match: { role?: string; agentId?: string /* glob */; incarnation?: number | 'any'; attempt?: number }; steps: FakeStep[] }
export type FakeStep =
  | { do: 'say'; text: string; chunks?: number } | { do: 'think'; text: string }
  | { do: 'tool'; tool: string /* ANY string: tests unknown/forbidden tools */; input: JsonValue; expect?: { isError?: boolean; textIncludes?: string }; onDenied?: FakeStep[] }
  | { do: 'submit'; output: JsonValue }
  | { do: 'usage'; tokens: Partial<TokenUsage> }
  | { do: 'await-message'; timeoutMs?: number }
  | { do: 'fail'; error: { class: ErrorClass; code: string; retryable: boolean; retryAfterMs?: number } }   // provider 5xx, rate limit, auth, quota…
  | { do: 'hang'; ms: number | 'forever' }                                // honours cancel
  | { do: 'crash'; at: 'before-next-step' | 'during-tool' }
  | { do: 'stop-without-result' }
  | { do: 'model-request'; status?: number; quota?: QuotaInfo; authSource?: 'oauth' | 'api-key' | 'none'; baseUrl?: string };   // drives auth-mode-violation tests
```

Matching is on `SpawnRequest` fields only (the fake knows no phases, R10). An unmatched spawn fails loudly (`configuration/fake-script-unmatched`).
`incarnation` matching lets one script say "first incarnation crashes after two writes, second finishes". **Host** crashes are the crash
harness's job, not the fake's. `pin()` hashes the script.

**Fake provider, two tiers**, both reachable only through the never-bundled test entry (1.3):
(a) *in-process faux*: `const faux = fauxProvider({ provider: 'cohorte-faux' }); const rt = await ModelRuntime.create({ credentials: new
InMemoryCredentialStore(), modelsPath: null }); rt.registerNativeProvider(faux.provider); await rt.refresh({ allowNetwork: false })` — drives
the *real Pi loop* with zero HTTP; used by the `runtime-pi` conformance run and the Pi-bump tripwires.
(b) *wire level*: the real `openai-codex` provider (api `openai-codex-responses`) with a dummy OAuth credential in an
`InMemoryCredentialStore` and an **injected `fetch`** (through the `streamFunction` wrapper) that replays scripted responses — 200, 401, 429
with and without reset headers, 5xx, slow, hanging, broken chunks — and records every request header. This is the only API on which status and
headers are observable for non-2xx (3.8), so the quota-header and classification tests are not vacuous; it is also the canary test (no canary
string from the parent env ever reaches a request). Assumption [A-3] (a dummy JWT-shaped credential is accepted by the codex provider offline)
is pinned by the Wave-0 Pi probe; the pre-agreed fallback is pure-function tests of `parseQuotaHeaders`/`classify` over fixtures recorded by
the live smoke, with `quotaReporting` staying `partial`.

---

## 4. Durability

### 4.1 Exactly-once *effect*: `intent → effect → done`, a replay class per effect, a verifier per kind

No effect on the outside world happens without a journal row (I5), and every write transaction is fenced (I6):

```text
tx A   assert fencing ; beginEffect(key, kind, replayClass, request, verify, preState [, consumesGrant]) + the "started" events   -> 'intent'
       ── crash window 1 ──
       perform the external effect
       ── crash window 2 ──
tx B   assert fencing ; completeEffect(result) + the "completed" events + projections + ledger rows + budget                      -> 'done'
```

The same key seen again inside one incarnation (IPC hiccup, step retry) → `beginEffect` returns `already-done` with the stored result → the
caller replays it (`tool.completed.replayed = true`); nothing re-executes. After a crash an `intent` row is **never blindly redone**: its
**replay class** says what recovery may do, and a **kind-specific verifier** inspects the world.

| Replay class | Recovery rule for `intent` without `done` |
|---|---|
| `idempotent` | re-execute (or, for an agent's own command, mark `failed(tool-transient/interrupted)`: safe for the next incarnation to re-issue) |
| `verifiable` | **probe the world**: found ⇒ `done` with the reconciled result; not found ⇒ re-execute; undecidable ⇒ `in-doubt` |
| `at-most-once` | **never re-executed.** `in-doubt`; surfaced in `ResumeReport.inDoubt`, in `status`, and in the next incarnation's reconciliation note |

| Effect kind | Class | Idempotency key | `verify` data at intent | Verifier after a crash |
|---|---|---|---|---|
| `fs.snapshot.materialize` | idempotent | `snap:<runId>` | manifest digest | content-addressed: re-put missing blobs, compare digest; mismatch ⇒ refuse (`corruption/snapshot-hash`) |
| `git.branch.create` / `git.ref.create` | verifiable | `ref:<runId>:<name>` | target sha | ref at sha ⇒ done; elsewhere ⇒ conflict ⇒ BLOCKED |
| `git.worktree.add` | verifiable | `wt:<runId>:<slot>` | path, branch, base sha | exact whole-line match in `worktree list --porcelain -z` ⇒ done; dir without registration ⇒ remove dir + `worktree prune`, redo |
| `provision.command` | idempotent | `prov:<runId>:<slot>:<lockfileSha256>` | marker path | marker `<gitdir>/cohorte-provision-<key>` present ⇒ done; else re-run |
| `agent.spawn` | verifiable | `<runId>:<agentId>:<incarnation>` | host nonce | child already dead (IPC disconnect); sweep `(pid, startToken)` and the nonce in its argv; mark `orphaned`; plan `incarnation+1` of the **same attempt** |
| `tool.write_file` / `tool.patch_file` | verifiable | `tool:<runId>:<agentId>:<inc>:<ordinal>` | `beforeSha256`, `afterSha256` | file == after ⇒ done (+ ledger row); == before ⇒ `failed(interrupted)`; else `in-doubt` |
| `tool.run_command` | from the matched `CommandRule.replay` | same | resolved argv, cwd, rule id | `idempotent` ⇒ `failed(interrupted)`; `at-most-once` ⇒ **`in-doubt`, never auto re-executed** |
| `check.command` | idempotent | `check:<runId>:<name>:<treeDigest>` — the digest computed **once, before the sequence** (2.5.2), so artefacts left by an earlier check cannot change a later key | argv | re-run (same digest ⇒ same key ⇒ a single `done`) |
| `git.commit` | verifiable | `commit:<runId>:<slot>:<n>` | branch, expected parent | `findCommitByTrailer(Cohorte-Effect: <key>)` ⇒ done; else redo (add + commit is content-idempotent) |
| `git.merge` | verifiable | `merge:<runId>:<from@sha>:<into@sha>` | expected old head | `update-ref` CAS already applied (head carries the trailer) ⇒ done; head == old ⇒ redo; anything else ⇒ `unexpected-repo-change` |
| `git.worktree.reset` | idempotent | `reset:<runId>:<slot>:<checkpointSha>:<n>` | patch artifact id | HEAD == checkpoint and clean ⇒ done; else redo |
| approval request | — (pure state) | `apr:<toolCallId>` or `apr:<runId>:<kind>:<phaseRunId>` (UNIQUE) | — | row exists ⇒ reuse |

Pure-state changes (approval resolution, command application, budget updates, transitions) are single transactions, idempotent by primary key.
V3.0 has **no** push, PR, publish or agent network effect (scope cut), so the only `at-most-once` effects are agent commands whose rule does not
say `replay: idempotent`.

### 4.2 What is persisted at each step of the engine loop

```text
E0  renew the run lease; every tx asserts fencing (a zombie host fails its next tx with conflict/lease-lost and exits at once)
E1  drain inbox: verify MAC, then per command ONE tx { claimCommand ; command.accepted ; events of the command ; finishCommand ; command.completed|rejected }
    (commands with external effects — cancel, shutdown — use two tx: { accepted + cancel_requested flag } … effect … { completed })
E2  stop = checkGlobalStops()            -> tx { run.state.changed(-> suspended|halted) ; stop ; checkpoint.created(+chainMac) ; writeSnapshot } ; leave the loop
E3  step = nextStep(state, table)         pure; nothing persisted
E4  facts = collectFacts(step.guards)     read-only (git heads, digests, auth probe, locks, pin)
E5  tx { recordTransition(idempotencyKey) ; run.state.changed(guards) ; putPhase(status running, step 'plan') ; phase.started }
E6  transition effects, each through the journal (create-integration-branch, mint-review-ref, record-approved-digest, release-locks…)
E7  GenericPhaseExecutor — each sub-step ends with tx { events ; projections ; putPhase(step = next) }:
      plan       agent.declared xN, agents rows, budgets rows
      provision  slot acquire: git.worktree.add | fast-forward to integration head ; provision.command keyed by lockfile hash (5.7)
      context    context manifest + rendered prompt/task written content-addressed ; context.built
      spawn      incarnation row 'intent' -> child hello(nonce) -> attestation verified -> 'spawned' ; agent.spawned ; agent.started
      await      every durable RuntimeEvent mapped and appended (batches <= 50 ms) ; each tool call = 4.1 ; approvals ; budget.updated
      collect    agent.completed|failed + output artifact ; retry/escalation decisions as events
      verify     ledger audit + diff-within-ownership + per-agent checks ; file.changed for unattributed writes
      commit     secret scan ; git.commit (journal, kind 'result') ; ledger cleared ; worktrees.checkpoint_sha, last_tree_digest
      integrate  git.merge (journal; plumbing + CAS; serialized by lock integration:<runId>) ; git.merge.completed
E8  tx { phase.completed(outcome, outputs validated) ; checkpoint.created ; writeSnapshot(atSequence) }      events first, snapshot after (spec 11.3)
```

### 4.3 Crash points: a named registry, a recorded golden run, a meta-test

Crash points are **named in code** (`crashpoint('…')`, registry `CRASHPOINTS` in `core/src/durability/crashpoints.ts`, frozen as a list in
Wave 0). The harness first records the golden run's sequence of `(point, occurrence)` hits, then kills the host (**real `SIGKILL`**, no
`finally`) at **every recorded pair** and asserts the right-hand column plus the golden final state (§7.3). A declared point never hit fails
the suite; a new transition automatically gets crash cases because it hits existing points.

| # | Crash point | On disk | Resume does |
|---|---|---|---|
| 1 | `start.after-run-row` (after the ONE transaction `{ putRun(IDLE) ; tx.enqueueCommand(start) }`, before the host spawn) | run `IDLE` **and** its signed start command `pending` — both or neither: an orphan IDLE run without a command cannot exist (2.4) | any `resume`/re-`start` with the same `commandId` spawns the host; the second `start` is `duplicate` and creates no second run |
| 2 | `host.after-lease` | lease held by a dead `(pid, startToken)` | lease stolen with `fencingToken + 1` after liveness check |
| 3 | `snapshot.mid-materialize` | partial CAS; run still `IDLE`; `runs.snapshot_digest`, `runtime_pin_json`, `plan_json`, `base_sha`, `integration_branch`, `zones_json` still NULL (they are written by the T04 transaction, 2.4 DDL) | re-materialize (content-addressed), re-evaluate the T04 guards; the T04 transaction writes the six columns and `pipeline.started` together |
| 4 | `transition.before-commit` | nothing new | decision recomputed (pure) — identical by construction |
| 5 | `transition.after-commit` | new state, phase row `step='plan'` | executor re-enters at `plan`; `recordTransition` with the same key is a no-op |
| 6 | `transition-effect.after-intent` / `.after-external` | effect `intent` | 4.1 verifier |
| 7 | `plan.after-commit` | agents `declared` | continue at `provision` |
| 8 | `provision.after-worktree-add` / `.after-install` | effect `intent` | exact porcelain match / provision marker |
| 9 | `spawn.after-intent` / `spawn.after-ready` | incarnation `intent`/`spawned` | child is dead (disconnect); sweep; new incarnation, same attempt |
| 10 | `tool.after-requested` (before the verdict) | `tool.requested` only | nothing ran; note lists it as "not executed" |
| 11 | `approval.after-requested` | approval `pending`, agent `waiting` | approval survives; `approve` works with no host (4.5) |
| 12 | `tool.after-intent` / `tool.after-effect` | effect `intent` | replay class + verifier; `in-doubt` is surfaced, never re-executed |
| 13 | `tool.after-done` (result not yet delivered) | effect `done`, `tool.completed`, ledger row | the note carries the recorded result; the work is kept |
| 14 | `agent.after-exit-before-collect` | accepted `submit_result` maybe `done` | accepted result ⇒ `collect` from the artifact (no re-spawn); else new incarnation |
| 15 | `commit.after-git-commit` | commit exists, effect `intent` | trailer match ⇒ `done` (no second commit) |
| 16 | `merge.after-update-ref` | integration head moved, effect `intent` | head carries the trailer ⇒ `done` |
| 17 | `phase.before-completed-commit` | all steps `done`, phase `running` | re-run `assemble` + checks (pure/deterministic) and commit |
| 18 | `checkpoint.after-events-before-snapshot` | events without the new snapshot | replay from the previous snapshot (snapshots are an optimisation) |
| 19 | `command.external.after-accepted` (cancel/shutdown) | `cancel_requested` flag | finish the cancellation idempotently, then `command.completed` |
| 20 | `ship.after-approval` / `locks.after-release` | approval resolved / locks gone, run not COMPLETED | guards re-evaluated; releasing released locks is a no-op |
| 21 | `reset.after-git-reset` | worktree reset, effects not yet `compensated` | verifier ⇒ done; the compensation tx is re-applied (idempotent) |
| 22 | SQLite mid-transaction | WAL all-or-nothing (`synchronous=FULL`) | `verifyChain` at open: gap/hash/anchor mismatch ⇒ `corruption/*`, refuse, never delete the run |

### 4.4 Resume procedure (`cohorte resume <run>`; also what a fresh host runs when it finds an unfinished run)

1. Open the store; migration **check** only (`configuration/incompatible-state-schema` → "run `cohorte migrate --apply`"; never automatic, never deletes).
2. `verifyChain` (hash chain + MAC anchors); load the last snapshot whose hash verifies; replay later events through `evolve`; compare with the
   `runs` projection. Failure ⇒ `corruption/*`, nothing is modified.
3. **Lease.** Live owner (`pid` + `startToken` alive and fresh heartbeat) ⇒ `conflict/run-host-alive`. Dead owner ⇒ `stealLock` with
   `fencingToken + 1`, `lock.stolen`, `takeover: true`.
4. **Immutability inputs** (§6): the host's own install must be the pinned install (path + `dist/**` hashes), the snapshot digest must verify,
   the `RuntimePin` must verify, the table version must be shipped. Mismatch ⇒ stop `runtime-incompatible` ⇒ BLOCKED with
   `resumeRequires: reinstall-pinned-version`. **There is no adopt/accept flag** (ADR-0023).
5. **Orphan sweep**: agent children by `(pid, startToken)` + nonce in argv; executor process groups from `runs/<id>/pids/*.json`
   (`pgid`, `startToken`, written at spawn, removed at exit) ⇒ TERM/KILL the group, then sweep escapees. Never kills on a bare pid.
6. **Rebuild locks**: project (shared) + the run's declared zones + `integration:<id>` + slot locks. A zone now held by another run ⇒
   WAITING_APPROVAL(`conflict/zone-reserved`).
7. **Reconcile `intent` effects FIRST**, with their replay class and verifier (4.1). This happens *before* any worktree comparison, so an
   interrupted-but-applied write is recognised as `done` instead of being treated as drift.
8. **Git verification** (spec 11.3). Integration branch head == `runs.integration_head`, base sha reachable, else `unexpected-repo-change`.
   Per slot: registered (exact porcelain match)? on the expected branch? `HEAD == worktrees.checkpoint_sha`? Then the **ledger audit**:
   `changedPaths(slot)` (porcelain v2 against HEAD) must equal the set of `worktree_ledger` paths, and each path's current sha256 must equal
   the ledger's. Outcomes:
   - *explained* ⇒ `ledger-explained`: **the work is kept**;
   - *unexplained, and the slot has a command effect that is `in-doubt` or `failed(interrupted)`* ⇒ **quarantine + reset**: save `git diff` +
     untracked files as a `patch` artifact, run the journaled `git.worktree.reset` to `checkpoint_sha` **inside the Cohorte-owned worktree
     only**, and in the same transaction mark every effect of that slot after the checkpoint `compensated` and clear its ledger — so the journal
     never reports as done a write the reset wiped; emit `git.worktree.quarantined`;
   - *unexplained, with no command effect that could explain it* ⇒ `repo.change.detected` ⇒ stop `unexpected-repo-change` ⇒ BLOCKED.
   A missing worktree directory with an intact branch is re-added. The user's checkout is never touched.
9. **Inbox**: pending commands are MAC-verified and applied in order (a `cancel` recorded while the host was dead wins here). **Approvals**:
   expire the due ones.
10. **Reconciliation note.** For every agent that must continue, a new incarnation of the same attempt is planned with a Cohorte-built
    `Continuation.note` (a `TaskInput`), built **after** steps 7-8 so it describes the post-recovery tree: calls not executed; calls completed,
    with their recorded results; effects compensated by a reset ("your uncommitted work since checkpoint C was discarded; patch saved as
    artifact A"); calls in doubt ("command X was started, its outcome is unknown; do not assume it ran, do not assume it did not");
    approvals decided meanwhile — **an approved call is replayed by the host before the note is built (4.5), so the note reports a fact, not an
    instruction**: "your call … was approved and has been executed; result: …", or "was approved but NOT executed because the workspace changed
    since you asked; request it again if you still need it", or "was denied: …". Host restarts do not consume `maxAttempts` but count against
    `maxIncarnations` (they are `reincarnate('recovery')` edges, 2.5.4).
11. Commit `run.resumed{mode:'recovery', report}`; re-enter the loop at `phases.step`. Completed agents and completed phases are never
    re-executed. `PAUSED`, `WAITING_APPROVAL`, `AUTH_REQUIRED`, `QUOTA_EXCEEDED` stay what they are: recovery never silently un-suspends.
    An `in-doubt` effect with `policy.inDoubt: 'ask'` (default) opens a `blocked-ack`-style approval before the agent continues.

**Checkpoint-commit cadence (explicit).** Cohorte commits `cohorte(wip): <agent> checkpoint <n>` on the agent branch, through the journal
(`git.commit`, kind `checkpoint`, ownership audit + secret scan included), at: (a) agent completion (kind `result`); (b) park, pause, quota/auth
suspension, FAILED and graceful shutdown (`checkpoint-worktrees`); (c) **immediately before any `at-most-once` command executes** — so a reset
after an in-doubt command loses nothing but that command's own writes. Idempotent commands need no checkpoint. No squash in V3.0: integration
receives one merge commit per agent branch. A checkpoint commit changes `worktrees.checkpoint_sha` and clears the ledger but **not** the
content-addressed `treeDigest` (5.8 "survives a commit of identical content") — which is exactly why command grants bind to the digest (4.5).

### 4.5 Approvals survive everything — and are bound to what the human saw

An `ask` writes, in one transaction: `approval.requested`, the `approvals` row (the **normalised** pending call, `grant_key`, expiry) and
`agent → waiting`. `grant_key = sha256(tool | canonicalJson(normalised call) | pre-state binding)`, where the binding is the target's
`beforeSha256` for write/patch, and **the slot's content-addressed `treeDigest`** for a command (computed inside the per-slot mutex at ask
time and again at consumption time; asks are rare, so the cost of a digest is acceptable here although it is not per tool call). The binding
is deliberately **not** `(checkpoint_sha, ledger digest)`: parking makes a checkpoint commit, which moves `checkpoint_sha` and clears the
ledger, so for any agent with uncommitted writes that binding could never match again and every human answer slower than
`parkAfterMinutes` would be wasted. Resolution arrives as an **authenticated** `approve|deny` command — minutes or hours later, with or
without a live host (the row stays `pending`; `cohorte approve` spawns a host when none is alive and `policy.approvals.autoResume`).
**Resolving an approval never executes anything by itself** — it is a state change in the inbox transaction. `allow-once` becomes an
unconsumed one-shot grant; `allow-for-run` a live grant until the run ends.

- *Fast path*: the brain is still waiting on IPC ⇒ the held call proceeds; the grant is **consumed inside the intent transaction** of its effect
  (exactly once, even across a crash).
- *Parked path* (host restarted, or the wait exceeded `parkAfterMinutes`: checkpoint commit, brain aborted, agent `waiting`, later
  `reincarnate('park')`). When the agent's next incarnation is about to be spawned, the supervisor asks `ApprovalService.approvedUnconsumed`
  and, for each approved call, **Cohorte replays the stored normalised call itself** through `ToolHostReplay.replayApproved` (2.5): stages
  1-5 run again on the stored call (the policy snapshot is the run's, budgets are current), the pre-state binding is recomputed, and **only
  if the grant key still matches** the call executes as a journaled effect under the **original** `toolCallId` and idempotency key, consuming
  the grant in its intent transaction (`tool.started.replayOfApproval`). The result goes into the Continuation note, exactly like a call
  that completed just before the brain died (crash point #13). If the binding changed, nothing executes: the approval becomes `superseded`,
  the note says so, and a re-issued call opens a **new** ask — the human is never silently held to a preview that no longer exists.
  `approval_request` answers (no effect) simply travel in the note.

Why the host replays instead of asking the model to re-issue: a re-issue matches the grant only if the model re-emits a **byte-identical**
normalised call — for `write_file` that includes the whole content. Approval liveness would then depend on prompt compliance, i.e. control
logic living in a note (spec principle 5). ADR-0025 had rejected "durable continuation" because an approved call could run against a state
the human never saw; the pre-state binding, re-checked at execution time, is precisely what detects that, so the objection does not apply to
a *bound* replay. What stays rejected: executing on resolution (the `approve` command still executes nothing), and replaying without a
matching binding.

`unattended: deny` turns every `ask` into a denial with the reason attached; `unattended: wait` parks the run in `WAITING_APPROVAL` and lets the
host exit after `host.idleExitMinutes` (suspended while a quota wake-up is armed, 2.5.3).

### 4.6 Pause and cancel (spec 17.2)

**Pause** = stop *new* effects, let an atomic operation finish. On `pause`: the engine schedules nothing new; the gate latch (stage 0) closes;
`AgentRuntime.pause` on each running agent (3.5); a host operation already past `beginEffect` runs to `completeEffect` and its result is
delivered; when every agent is parked or exited: `checkpoint-worktrees`, then tx `{ run.paused ; state PAUSED(resumeTo) ; checkpoint }`.
`command.completed` for a pause is emitted when PAUSED is committed, not when the request is received. Parked children are kept for
`host.pauseKeepAliveMinutes` (30), then aborted; the host exits; `resume` continues with fresh incarnations + notes — the legal lifecycle edge
is `paused → spawning` with `reincarnate('pause-expiry')` (2.5.4): no attempt is consumed. Budget wall clocks stop.
**Cancel** = cancel what is cancellable, mark durably first: tx1 `{ command.accepted ; cancel_requested }` → agents through the cancel ladder,
executor groups killed, pending approvals `superseded`, an in-flight atomic git effect is allowed to finish and is verified → tx2
`{ run.cancelled ; state CANCELLED ; locks released ; command.completed }`. Worktrees kept or removed per `git.keepWorktrees`. CANCELLED is terminal.

### 4.7 Detached run host and command inbox (D5)

- `cohorte run <spec>` **always** hands the run to a detached host: the CLI validates (config trust included, 2.10.1), writes `{ run row IDLE, signed
  start command }` in **one** `transact('project', null, …)` using `putRun` + `tx.enqueueCommand` (2.4),
  spawns `<pinned node> <pinned install>/dist/cli.mjs __host --run <runId>` with `detached: true`, stdio to `runs/<id>/host.log`, `unref()`,
  and then becomes an **observer** (the same code as `cohorte logs --follow`; with `--json` it prints envelopes as NDJSON — spec 18's minimal
  integration). Ctrl-C detaches the observer and prints `cohorte status <runId>`; killing the client's process group (François' 10 s one-shot
  kill) cannot stop the run. `--detach` returns `{ "runId": … }` within 2 s. `--foreground` (explicit, for CI and tests only) keeps the host
  in-process; EPIPE on stdout is swallowed.
- Observers (`status`, `logs|tail --follow [--since-seq N] [--replay K] [--format=line|json] [--ephemeral]`) are pure readers: no lock, no
  write, no temp file; durable events by `sequence` (poll 250 ms), ephemerals by tailing the spool; merge order `(sequence, sub)`; first line =
  `snapshot`. **Exit codes reflect the outcome for a process that waits** (2.8): an observer started by `run`, or given `--wait`, exits 0 on
  COMPLETED, the `ErrorClass` code of `run.lastError` on FAILED/BLOCKED, 4 on a suspended state, 16 on CANCELLED; plain `status`, `logs`,
  `tail` and `--panel` exit 0 once the run reaches a terminal or suspended state. No environment variable is required by any
  read-only verb (François scrubs the environment); everything is discoverable from `cwd` (walk up to `.cohorte/`) and `HOME`.
- Controllers sign, insert into `commands` and touch `runs/<id>/inbox.poke`; the host polls every 250 ms and `fs.watch`es the poke file (a hint
  only; a local socket with the same role belongs to the V3.1 daemon).
- Liveness: lease TTL 15 s, renewed every 5 s, mirrored in `runs.host_heartbeat_at`; `status` shows `host.alive`.

---

## 5. Git (spec 15, D9)

```ts
export interface GitPort {                                  // packages/git; execFile `git`, never a shell
  facts(repo: CanonicalPath): Promise<RepoFacts>;           // version (>= 2.38 for merge-tree --write-tree), default branch, HEAD kind, worktrees
  treeDigest(worktree: CanonicalPath, opts: { exclude: string[] }): Promise<string>;
  addWorktree(req: { repo: CanonicalPath; path: CanonicalPath; branch: string | null; commit: string }): Promise<void>;
  switchToNewBranch(req: { worktree: CanonicalPath; branch: string; at: string }): Promise<void>;          // slot reuse: new agent branch at the integration head
  removeWorktree(path: CanonicalPath, opts: { force: false }): Promise<'removed' | 'dirty-kept'>;
  resetHardClean(worktree: CanonicalPath, to: string): Promise<void>;                                       // quarantine path only; refuses any path outside the worktree root
  commitAll(req: { worktree: CanonicalPath; message: string; trailers: Record<string, string>; identity: GitIdentity; paths: string[] }): Promise<{ sha: string; treeDigest: string } | { kind: 'nothing' }>;
  findCommitByTrailer(repo: CanonicalPath, branch: string, key: string, value: string): Promise<string | null>;
  mergeTree(repo: CanonicalPath, ours: string, theirs: string): Promise<{ clean: true; tree: string } | { clean: false; files: string[] }>;   // git merge-tree --write-tree: no working tree involved
  commitTree(repo: CanonicalPath, tree: string, parents: string[], message: string, trailers: Record<string, string>): Promise<string>;
  updateRefCas(repo: CanonicalPath, ref: string, next: string, expectedOld: string | null): Promise<'ok' | 'moved'>;                          // atomic compare-and-swap
  createRef(repo: CanonicalPath, ref: string, sha: string): Promise<void>;                                 // refs/cohorte/<runId>/review/<n> — never updated during the run
  diffBySurface(req: { repo: CanonicalPath; base: string; head: string; surfaces: SurfaceMap }): Promise<{ surface: SurfaceId | 'shared'; files: string[]; patch: ArtifactDraft }[]>;
  changedPaths(worktree: CanonicalPath): Promise<FileTouch[]>;                                              // status --porcelain=v2 -z, exact parsing
}
```

**5.0 Hardened runner — mandatory on EVERY Cohorte-run git invocation.** Hooks and config are repository-controlled code, and Cohorte's own git
runs in the run host, outside the gate and the sandbox. Every call carries `-c core.hooksPath=/dev/null -c core.fsmonitor= -c
core.sshCommand=false -c protocol.allow=never -c commit.gpgsign=false -c core.pager=cat` and the env `GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C`, an explicit identity, `--porcelain=v2 -z` wherever output is
parsed, and `--no-ext-diff --no-textconv` on diffs. Merges use plumbing (`merge-tree --write-tree` + `commit-tree` + `update-ref` CAS): no
hook, no working tree, and the crash window is a compare-and-swap. Test S-70: a husky-style fixture (`core.hooksPath=.husky/_`, a gitignored
hook that writes a canary) goes through commit, merge and `worktree add` — the canary must never appear.

**5.1 Layout.** Base = `origin/<default>` when it verifies, else local `<default>`, pinned as `base.sha` in `pipeline.started`. Branches:
`cohorte/<runId>/integration` (created at T04) and `cohorte/<runId>/<slot>/<n>` per writing agent. **Worktree root default:
`~/.cohorte/worktrees/<projectKeyId>/<runId>/`, outside the repository** — so an agent worktree never resolves `node_modules`, `tsconfig`,
Biome or vitest roots upward into the user's main checkout, and no worktree sits next to `.cohorte/state`. `~/.cohorte/worktrees` is
deliberately **not** in the protected set nor in any `denyRead` list (only `keys`, `versions`, `pi-agent`, `brains`, `trust` are).
`git.worktreeRoot` may name any other directory **outside the built-in protected roots**; `.cohorte/worktrees` is inside one and is refused
at config resolution (`configuration/worktree-root-protected`, 2.6.3 step 5, D-10) — V3.0 does not carve an exception into a
non-overridable rule. Slots: one per surface + `_integration` + `_review-<n>` (detached). Every id passes `ID_PATTERN`
before it reaches a path or ref; every worktree path is canonicalised and must resolve under the root. The user's checkout is never touched; a
dirty main checkout is allowed, with a `warning` event if the base is a local branch with uncommitted changes. Spec, contract, prompts and
config are read from the **run snapshot**, not from the checkout.

**5.2 One slot per surface, one agent at a time (clarification of spec 15, ADR-0021).** A slot is a dedicated worktree that at most one writing
agent holds at any instant (slot lock); each agent gets **its own branch**, created at the current integration head when it acquires the slot
(`switchToNewBranch`), so implementer and later fixer of the same surface reuse the directory — and its provisioned `node_modules`, which
only the Provisioner can write (5.7) — without ever sharing a branch or running concurrently. This keeps spec 15's isolation ("worktree dédié", "sérialisés ou réservation") while bounding
provisioning cost to once per surface per lockfile.

**5.3 Commits are Cohorte's (D9).** Agents have no commit capability (built-in deny, 2.6.4). When an agent completes (or at a checkpoint, 4.4),
Cohorte (a) runs the ledger audit, (b) checks every changed path against the agent's `write` globs — this catches writes done *by commands*,
e.g. a formatter — failing with `security/write-outside-ownership`, (c) runs the secret scan (path classes + `Redactor` detectors over staged
content; a hit is `security/secret-staged` ⇒ BLOCKED), (d) `commitAll` with message `cohorte(<specId>): <surface> <phase>#<iteration>` and
trailers `Cohorte-Run`, `Cohorte-Agent: <id>#<incarnation>`, `Cohorte-Effect: <key>`, `Cohorte-Tree-Digest`. Identity per
`git.commitIdentity` (`user`: the user's identity + `Co-authored-by: Cohorte`).

**5.4 Explicit merge with revalidation (spec 15).** `MergeService.integrate(agentBranch)`, under lock `integration:<runId>`, in deterministic
agent order: (1) `into.head` equals the recorded integration head, else `unexpected-repo-change`; (2) **ownership audit** on
`changedPaths(mergeBase, from)` against the agent's write globs (I11, second enforcement); (3) `mergeTree`; a conflict ⇒
`git.merge.conflicted` + `conflict/merge` ⇒ the owning agent gets one "rebase onto integration" FIX-type task, then WAITING_APPROVAL; never
resolved by Cohorte, never forced; (4) `commitTree` + `updateRefCas(integration, new, old)` through the journal; (5) **revalidate**: the
`_integration` slot is fast-forwarded, the new `treeDigest` recorded, and the TEST phase that follows binds its results to that digest (guard
`checks.digest-equals-integration`); (6) `git.merge.completed`. Nothing ever merges into a protected branch: SHIP in V3.0 ends with the
integration branch + a ship report; fast-forwarding a user branch, push and PR are `release-manager` capability + human approval (V3.1).

**5.5 Immutable reviewer ref.** Effect `mint-review-ref` (T08): `refs/cohorte/<runId>/review/<n>` → integration head; reviewers get a
**detached** worktree at that ref, a grant without any write/execute tool, `denyWrite: **`, and an executor profile with no write root. After
the review `treeDigest(_review-<n>)` must equal the minted digest, else `security/review-ref-mutated`. `review.started` and `review.approved`
both carry `{ ref, sha, treeDigest }`; T10 requires it to equal the integration digest, T14/T15 re-check it at SHIP.

**5.6 Project lock, zones, reservations.** At T04 the run takes `project` (**shared**; `migrate --apply` and `reconcile --apply` take it
**exclusive**) and one `zone` lock whose `zones` = the literal prefixes (text before the first glob metacharacter, by path segment) of every
surface path the spec touches. Two zone sets overlap when one prefix is a segment-ancestor of (or equal to) another; a pattern with no literal
prefix overlaps everything — decided inside one `BEGIN IMMEDIATE`. Overlap ⇒ `conflict/zone-reserved` naming the holder run; `--wait` polls.
Independent runs coexist. Inside a run, agents touching a `shared` path are serialized by `AgentPlan.serializeWith`; a write to a path whose
surface has `approval: human` is an `ask` (`kind: shared-path`). All locks are leases (TTL + liveness + fencing), rebuilt at resume.

**5.7 Provisioning (what makes TEST possible in a worktree of a pnpm monorepo).** A fresh worktree has no `node_modules`. `Provisioner.ensure`
runs the human-owned `provision.argv` (a *loosening* key: it needs the local user's consent, 2.10.1) as a **Cohorte-run**, journaled effect
(`provision.command`, idempotent), keyed by `(slot, sha256 of the configured lockfiles at the slot's HEAD)`, never by an agent. For known
package managers Cohorte requires `--frozen-lockfile` and `--ignore-scripts` (or the equivalent) and refuses the config otherwise: project
`prepare`/`postinstall` scripts must not run in the host context (test S-71). Executor profile: write roots = the slot + `provision.cacheDirs`;
`network: 'unrestricted'` only when `provision.network: true`, in which case it is a line of the `RunPlan` and, when attended, a one-time
`provision-network` approval. Marker: `<gitdir of the worktree>/cohorte-provision-<key>` (under `.git`, unreachable by agents). A lockfile
change by an agent is a `shared` path ⇒ human approval ⇒ re-provision at the next slot acquisition. Three properties make "TEST is the
truth" hold against a compromised agent (spec 23):

1. **The package store is reachable, and only through an allowlisted channel.** The L0 env sets `HOME` to a scratch directory, which hides
   the pnpm/npm/yarn store: `pnpm install --offline` would find an empty store and fail. `provision.env` is the only env channel of a
   provisioning effect, its names are a closed allowlist (`npm_config_store_dir`, `npm_config_cache`, `YARN_CACHE_FOLDER`, `COREPACK_HOME`),
   every value must canonicalise inside `provision.cacheDirs`, and by default the Provisioner sets `npm_config_store_dir = cacheDirs[0]`.
   These paths are machine-specific, so they live in `~/.cohorte/config.yaml`; `doctor` detects the store (`pnpm store path`, run by the CLI
   as the user, outside any run) and proposes the line. No usable store ⇒ `configuration/provision-store-unavailable` before any agent starts.
2. **No hardlink into the store.** On Linux ext4 pnpm hardlinks packages from its global store: a write through the worktree path would
   modify the shared inode and poison the store, the other slots and the user's other projects, even under L1. For pnpm Cohorte forces
   `--config.package-import-method=clone-or-copy` (clone on APFS/btrfs, copy elsewhere); for every manager it then asserts `nlink == 1` on a
   sample of installed files (every `package.json` of a direct dependency + 200 random files) and fails the effect otherwise (test S-74).
3. **Dependencies are read-only for agent-influenced code, and verified.** `provision.dependencyDirs` (default `**/node_modules`) are
   passed as `fs.readOnly` in the executor profile of every agent command and every check: only the Provisioner's own effect has them
   writable. Otherwise the first `pnpm test` in `_integration` could rewrite `node_modules/vitest` so that every later TEST passes — and the
   `treeDigest` would never notice, since it ignores ignored files. `provision.writableCaches` (tool caches such as `node_modules/.vite`)
   stay writable, are excluded from the manifest and are **wiped by Cohorte before every check sequence**. At provision time the
   Provisioner records a **dependency manifest digest** (`worktrees.deps_manifest_sha256`: sorted `{path, size, mode, sha256}` of every file
   under the dependency dirs, symlink targets included); `CheckPhaseExecutor` re-verifies it before each TEST — a cheap stat-level comparison
   under L1 where the read-only mount is the enforcement, a full content digest under L0 where nothing else protects it — and a mismatch is
   `security/deps-tampered` ⇒ BLOCKED (test S-73: a check that tries to modify `node_modules` fails under L1 and is detected under L0).

**5.8 Tree digest and unexpected-change detection.** `treeDigest` is V2's content-addressed digest, ported verbatim: copy the index to a temp
file, **backdate it 5 s** (racy-git), `git rm --cached` the excludes, `git add -A -- . ':(exclude).cohorte'`, `git write-tree`, clean up; the
real index is never touched. Properties kept as tests: survives a commit of identical content; invalidated by any tracked edit or new
untracked non-ignored file; ignores `.cohorte/`. It is computed at Cohorte's own checkpoints — agent exit, commit, merge, `check.completed`,
`review.approved` — **not per tool call** (the per-call record is the file ledger, 4.4). Drift is checked at resume, at every phase boundary,
before every merge and before SHIP. "Cannot compute" (git fails) = **not fresh**.

**5.9 GC and retention.** On `COMPLETED|CANCELLED` worktrees are removed if clean (dirty ⇒ kept + warning); merged agent branches are deleted with
`branch -d` only; the integration branch is left for the human. `cohorte gc --dry-run|--apply` is also **the owner of `retention.*`**
(spec 19 "compressés, référencés et soumis à rétention configurable"; ADR-0010): it gzips `sensitive` files (transcripts, wire logs) older
than `compressAfterDays` — the `ArtifactRef` keeps its id and records the new encoding; deletes transcripts and wire logs older than
`transcriptsDays`, artifacts older than `artifactsDays`, and the ephemeral spool one day after the run ended; purges event rows only through
`runs.purgeable` when `eventsDays` is a number; removes CAS blobs no remaining run references. It **never touches a file of a non-terminal
run** and never a file outside `.cohorte/state`. Ages are computed on the injected `Clock` (tested with `FixedClock`); `--dry-run` prints
exactly what `--apply` would do.

---

## 6. Dogfooding and runtime immutability during a run (spec 16)

### 6.1 What is snapshotted at run start

`runs/<runId>/snapshot/manifest.json`; its sha256 = `runs.snapshot_digest` = `pipeline.started.snapshotDigest`. All eight items of spec 16:

```ts
export interface RunSnapshotManifest {                     // [S] schema lives in packages/core/src/contract/snapshot-manifest.ts — NOT in @cohorte/config: it embeds SandboxCapabilities (security),
                                                           //     RuntimeCapabilities and RuntimePin (runtime-contract); config importing security would close a cycle (security imports config)
                                                           //     and core is the lowest package allowed to import all three. gen-schemas reads it from @cohorte/core/contract.
  manifestVersion: 1; createdAt: IsoInstant;
  app: { name: 'cohorte'; version: string; installDir: string; gitHash: string | null };                  // version de l'application, hash Git
  packages: { name: string; version: string }[];           // manifest de packages: resolved direct runtime deps (node_modules/*/package.json)
  bundles: { file: string; sha256: Sha256; bytes: number }[];                                              // every file under dist/ == bundle-manifest.json
  assets: { treeSha256: Sha256; embeddedTreeSha256: Sha256 /* the constant compiled into the bundle */ };
  schemas: { protocolVersion: '1.0'; stateSchemaVersion: number; configSchemaVersion: number; transitionTable: { profile: PipelineProfile; version: number } };
  prompts: { id: string; source: 'shipped' | 'project-override'; logicalPath: string; sha256: Sha256 }[];  // bytes in the CAS
  skills:  { id: string; version: string; source: 'shipped' | 'project'; sha256: Sha256 }[];
  config:  { resolvedSha256: Sha256; ownershipSha256: Sha256; policySha256: Sha256; conventionsSha256: Sha256 | null;
             trust: RunPlan['trust'] };                    // 2.10.1: the consent under which the loosening keys of the project file were honoured
  spec:    { id: SpecId; sha256: Sha256 } | null;
  environment: { pinnedPath: string[]; platform: string; arch: string; sandbox: SandboxCapabilities; runtimeCapabilities: RuntimeCapabilities };
  runtime: RuntimePin;                                     // AgentRuntime actif (3.9)
}
```

Every prompt, skill, schema, the resolved config, policy, ownership and the frozen spec are **materialised into the content-addressed store**
(`state/cas/<sha256>`, read-only files) at capture. **Everything a run reads afterwards goes through `PinReader`**, which serves bytes from
the CAS by hash and **re-verifies the hash on every read**: a mid-run edit of a prompt, a config value, the ownership file or the spec is
invisible until the next run, and a tampered CAS file is `security/pin-tampered` ⇒ BLOCKED (spec 23 "vérification d'intégrité du snapshot").

### 6.2 Verified at spawn, every time

(a) `PromptRef`/`TaskInput`: sha256 re-checked by the runtime before use (conformance rule 6). (b) `RuntimePin`: bundles + Pi package trees
re-hashed with a stat cache (3.9); the child is spawned by **absolute pinned path**, never through `PATH`. (c) The host process itself is
immutable by construction: its static ESM graph is fully loaded when `__host` starts and it never `import()`s afterwards (`check-layers` rule
g); the parent side of `runtime-pi` imports no Pi. Any mismatch ⇒ `security/asset-hash-mismatch` / `security/runtime-pin-mismatch` ⇒ BLOCKED
with remediation "reinstall cohorte@<version> (or restore the pinned install) or cancel the run".

### 6.3 Why new code only runs at the next run

1. **The run host refuses to start from inside the target** (guard `host.outside-target`): if `realpath` of its own bundle is inside the
   project root or any worktree root ⇒ `security/runtime-inside-target`. Cohorte-on-Cohorte always runs from an installed copy.
   `scripts/dogfood-install.ts` packs and installs into `~/.cohorte/versions/<version>-<bundleSha8>/`, **side by side**.
2. **A run belongs to its install.** `runs.pinned_install_dir` records the install; the detached host — at start and at every `resume` — is
   spawned from *that* directory after its `dist/**` hashes verify, not from whichever CLI the user typed. A newer CLI resuming an older run
   therefore re-execs the pinned install when it still exists side by side. If the pinned files are gone or changed (an in-place `npm i -g`),
   `resume` **refuses** (`runtime-incompatible`, remediation: reinstall the pinned version or cancel). No override exists in V3.0: spec
   principle 8 and spec 29 "une mise à jour ne change pas un run actif" are taken literally (ADR-0023).
3. The install dir, `~/.cohorte/versions`, the node dir and the state dir are protected roots (2.6.3) and are in `denyRead`/no-write of every
   executor profile: no agent tool or command can modify the active runtime.
4. All agent changes land in worktrees; building them there produces outputs under the worktree's own `apps/cli/dist`. They become the active
   runtime only when a human packs/installs them and starts the **next** run — whose pin then differs.
5. State migrations are numbered and keep old runs readable: a newer install's `status` on an old DB refuses with the exact `migrate`
   instruction, never reinterprets.

### 6.4 Tests (spec 16 list → `tests/dogfood/*.e2e.ts`; repository under test = the Cohorte repo itself, `git clone --local` into a temp dir)

| Spec 16 bullet | Test (FakeRuntime unless noted; the active binary is a *copy install* made by `dogfood-install`) |
|---|---|
| `init` then `reconcile --plan` ⇒ no unexpected drift | D1: `cohorte init --yes` → `reconcile --plan --json` ⇒ `operations: []`. Then edit a `human` field and a `generated` file ⇒ the plan shows `human-change` preserved and `CONFLICT`, never an overwrite |
| Cohorte adds a small feature to Cohorte in a worktree | D2: a scripted implementer adds `apps/cli/src/commands/hello.ts` + a test in the `cli` slot; provisioning installs the workspace from the lockfile; TEST runs the repo's real `vitest` in `_integration`; reviewer round 1 finds a seeded flaw, the fixer fixes it, round 2 is clean ⇒ COMPLETED; the main checkout's digest is unchanged from start to end |
| the run continues with the previous snapshot | D3: between BUILD and TEST the harness overwrites the project's prompt override and config **and** the copy install's `assets/prompts/agents/reviewer.md` ⇒ the reviewer's `context.built.entries[].sha256` equals the pinned hash; `snapshotDigest` on the last event equals the first |
| new binary/runtime only after restart | D4: append a byte to the copy install's `agent-host.mjs` mid-run ⇒ next spawn `security/runtime-pin-mismatch` ⇒ BLOCKED; `resume` with the modified install ⇒ **refused**; restore the byte + `resume --ack` ⇒ continues. Then install version B side by side and start a new run ⇒ its `pipeline.started` pins B while the finished run's events still show A |
| a state migration stays readable by the new version | D5: the packaging test builds N and N+1 (with an added `0002_*.sql`); N creates a run; under N+1 `migrate --check` lists `0002` and exits 3, `status <run> --json` refuses with the exact instruction, `migrate --apply` (backup first) ⇒ `status` renders the old run; golden instances of N validate under N+1 schemas |
| an unauthorised modification of the active runtime is refused | D6: the scripted agent tries `write_file` with an absolute path into the install dir, a `../../..` traversal, a symlink planted in the worktree pointing at `dist/`, `run_command ["cp", …]` onto `.cohorte/state/cohorte.db`, `patch_file` on `.cohorte/config.yaml` ⇒ five `tool.denied` with `overridable: false`, zero bytes changed (install + state digests asserted), BLOCKED `policy-violation` at the threshold; and starting the host from `apps/cli/dist` inside the repo ⇒ `security/runtime-inside-target` |

**The real dogfood is a release gate, not a simulation** (spec 28 bullet 10, spec 32): with `--runtime pi` and the maintainer's Codex
subscription, Cohorte builds a small frozen spec on the Cohorte repo (candidate: `cohorte version --json`); a human reviews the integration
branch; findings become fixes. Opt-in, budgeted, recorded in the release checklist. A separate **live smoke** (`pnpm test:live`, hard token
cap, never on PRs) runs one tiny spec on the `ts-monorepo` fixture and **records the real quota header names and error texts** as fixtures for
3.8 — closing the one item no spike could execute.

---

## 7. Test strategy (spec 25)

### 7.0 Test discovery — defined once in Wave 0, verified, never edited by a unit

vitest 5, **`projects` inside `vitest.config.ts`** (vitest 5 has no workspace file). Selection is by **file suffix**, so helpers and data tables
under `test/` are never collected and no unit ever edits the config:

| Project | Globs | Pool / timeout |
|---|---|---|
| `unit` | `{packages,apps}/*/{src,test}/**/*.test.ts` | threads |
| `integration` | `{packages,apps}/*/test/**/*.itest.ts`, `tests/integration/**/*.itest.ts` | forks, 30 s |
| `e2e` | `tests/{e2e,security,crash,dogfood,packaging,acceptance}/**/*.e2e.ts` | forks, 120 s |
| `live` (separate config `vitest.live.config.ts`, never in CI by default) | `tests/live/**/*.live.ts` | forks |

**Test files are typechecked by a project of their own.** `tsc -b` covers `src/` only (tests cannot join the composite projects: `testkit` ↔
packages would be a reference cycle), vitest does not typecheck, and a unit's `tsconfig.checks/<unit>.json` is only ever run during its own
wave. Without more, every type-level guarantee would be inert after its wave: the I7 test that `appendEvents` rejects an unsealed draft, the
S-60 test that `RuntimeHostBindings` has no executor, the `Brand` tests, and the `@ts-expect-error` Pi API proof `type-proof.ts` that the
scheduled `pi-latest` job exists to run; the TypeScript files under `scripts/` would never be checked at all. So Wave 0 adds a root
**`tsconfig.tests.json`** — non-composite, `noEmit`, extends the base config, `include`: `{packages,apps}/*/test/**`, `tests/**`,
`scripts/**`, `packages/testkit/**`, `fixtures/**/*.ts` — and `tsc -p tsconfig.tests.json` runs inside `pnpm verify` and in the CI jobs
`typecheck` and `pi-latest`. A self-test plants a failing `expectTypeOf` in a temp copy and sees `verify` fail.

Excluded everywhere (vitest, Biome, every tsconfig): `legacy/**`, `.cohorte/**`, `.build/**`, `**/dist/**`, `**/node_modules/**` — in-repo
dogfood worktrees would otherwise be full copies of the test tree. Wave 0 plants one canary test per root (`packages/base`, `apps/cli`, each
`tests/<suite>`) and its acceptance asserts that `vitest list` finds all of them. House rules: `test.extend` per-test fixtures (never shared
mutable fixtures), `test.for` for tables, `realpath(mkdtemp())`, hermetic `GIT_ENV`, throwaway `HOME`.

### 7.1 Unit (spec 25.1) → packages

| Spec 25.1 topic | Package / file | Notable tables |
|---|---|---|
| state transitions, guards | `core/test/pipeline/{tables,guards,command-matrix}.test.ts` | per profile: reachability; every `PhaseOutcome` has an exit; every `StopReason` maps to one row; **every spec-17.2 command has a row or a defined rejection in every state (retry/skip/resume/cancel from FAILED, BLOCKED, IDLE are REQUIRED)**; idempotency-key stability |
| loop / stop reasons | `core/test/loop/decide.test.ts` | V2 loop cases ported (unreviewed-before-blocking, treading-water, max-rounds counts reviews, contract exact-match) + A→B→A oscillation, no-progress window, escalate-once |
| review math | `core/test/review/{identity,normalize,verdict}.test.ts` | fingerprint byte-order vector; Unicode identity; complexity clamp; deferred promotion; needs-investigation |
| policy engine, ownership | `security/test/decide/*.test.ts` | 7.4 |
| budgets, routing | `core/test/budgets.test.ts`, `providers/test/{resolve,billing}.test.ts` | five levels incl. provider and tool; `estimatedQuotaPercent` limit; `monetaryCost` is `not_applicable` iff `billing = plan-limits`; **Anthropic-via-Pi is never `not_applicable`**; never a fallback to a non-allowlisted provider |
| context manifests | `core/test/context/manifest.test.ts` | determinism (same inputs → same `manifestSha256`), stable prefix / variable suffix, secret + out-of-ownership exclusion listed in `exclusions`, slash-less deny pattern = `**/<p>` |
| schemas | `protocol/test/{catalogue,strict-open}.test.ts`, `config/test/schema.test.ts` | every event type has a payload fixture; strict rejects unknown keys; open schema accepts a future type and a future enum value |
| redaction | `security/test/redact/*.test.ts` | by value, encoded forms, PEM, JWT, `.env` lines; redactor throwing = event replaced, payload dropped; type-level: `appendEvents` rejects an unsealed draft (kept alive after Wave 0 by `tsconfig.tests.json`, 7.0) |
| idempotency keys | `core/test/durability/keys.test.ts`, `persistence/src/conformance` | duplicate transition / effect / approval / command are no-ops; `commandId` reuse with another body is a conflict; allow-once consumed exactly once |
| Git path handling | `git/test/paths.test.ts`, `security/test/decide/paths.test.ts` | 7.4 path table; `dir/**` matches `dir` |
| migrations | `persistence/test/migrations.test.ts` | monotonic, sha-pinned, golden DB fixtures readable after migrate; incompatible version refuses with instruction, run rows untouched |
| drift classification | `project-model/test/drift.test.ts` | five field classes incl. `mixed`; six diff classes; a human override is never in an `apply` plan; generated file replaced only if `renderedSha256` still matches |
| prompts carry no control logic | `scripts/check-prompts.ts` (CI `lint`) | transition/verdict vocabulary list has zero hits under `prompts/**` (spec 4.1, spec 29 bullet 2) |

### 7.2 Integration (spec 25.2) — fake runtime + fake provider, deterministic

| Spec 25.2 topic | Where | How |
|---|---|---|
| spawn, streaming, tool interception, pause/resume | `runtime-contract/conformance` run by `runtime-fake` (unit speed) and by `runtime-pi` (`*.itest.ts`, faux provider in the real Pi loop) | the twelve conformance rules of 2.2 |
| parent ↔ child protocol without Pi | `runtime-pi/test/parent-fake-brain.itest.ts` | the parent driven against testkit's **fake brain child**: framing, attestation mismatch ⇒ spawn refused, heartbeat loss, kill ladder, disconnect ⇒ `crashed` |
| **Pi-bump tripwires** (permanent; fail loudly on any Pi upgrade) | `runtime-pi/test/tripwires/*.itest.ts` | ported from the executed delta/spike scenarios: hostile repo has zero effect (incl. `sessionDir`, migration, `.pi/SYSTEM.md`, `AGENTS.md`); allowlist ⇒ `Tool bash not found`; a typo in the allowlist fails attestation; `terminate` ends the run; `shouldStopAfterTurn`; abort while a tool waits; EOF while waiting; empty-file transcript trick; `tool_call` is still fail-open by omission (so we still must not rely on it); **A-1: the `streamFunction` wrapper is observed for EVERY request of a run incl. continuation runs**; `prompt()` rejection is mapped to a typed `settled`; **`tw-auth-snapshot`** (snapshot accessors are empty with `refreshOnCreate:false` and agree with the live calls after `refresh()`); **`tw-stream-contract`** (breaching `maxModelRequests`, and aborting while parked at the model boundary, both end with `settled` + a typed cause, zero unhandled rejections, zero extra model requests); **`tw-credential-lock`** (a locked temp `authPath` yields `ModelsError` code `'auth'`); **`tw-continuation-note`** [A-8] (task then note, byte-identical, before the first request); **`tw-guard-fetch`** (the guard sees every request of a run; a foreign origin or an `x-api-key` header is refused before any byte leaves); compile-time API proof (`type-proof.ts`, typechecked by `tsconfig.tests.json`); import-weight and no-non-loopback-socket audits |
| auth guarantee | `runtime-pi/test/auth-canary.itest.ts` | S-40..S-46 (7.4) |
| retries, approvals | `tests/integration/{approvals,retries}.itest.ts` | FakeScript `fail{retryable}` + fixed clock: bounded backoff, every retry visible as `retry.scheduled`; approval held "for hours" with the fake clock; `approve` with no host alive; **a park checkpoint does not change the grant key; an approved write is applied by the host after park and the model is not asked to re-issue**; pre-state change ⇒ `superseded`, nothing executes, a re-issue opens a new ask; FakeLedger: a retry's `SpawnRequest` is byte-identical |
| event protocol | `tests/integration/protocol.itest.ts` | golden NDJSON of a full fake run validates against `schemas/events.schema.json` with **ajv** (independent implementation); replay from `--since-seq`; `(sequence, sub)` ordering with ephemerals, **including under 50 ms batching** (no delta of message n+1 before `agent.message.completed` of message n) |
| SQLite | `persistence/test/sqlite/*.itest.ts` | conformance suite ×2 stores; 3 processes × 400 `BEGIN IMMEDIATE` tx; SIGKILL of a reader mid-read never blocks the writer; append-only triggers; chain tamper + anchor MAC detection; fencing |
| worktrees | `git/test/*.itest.ts` | concurrent `worktree add`, exact porcelain match, tree digest E1-E9, `mergeTree` + conflict, `updateRefCas` race, review-ref immutability, hook canary (S-70) |
| reconciliation | `project-model/test/reconcile.itest.ts` | `--plan` is read-only (tree digest unchanged), conflict-free `--apply` is journaled, human edit ⇒ CONFLICT entry |

### 7.3 E2E (spec 25.3) — fixtures and the crash harness (driven through a **built CLI**)

| Fixture (builder under `fixtures/repos/<name>/build.ts`) | Exercises | Spec 25.3 bullet |
|---|---|---|
| `ts-monorepo` (pnpm, 2 packages, vitest) | full `build → test → review → fix → review-clean` loop, 2 surfaces in parallel, provisioning, merge | TypeScript monorepo |
| `frontend-backend` | ownership split, `shared` surface with `approval: human`, serialized agents, contract file exact-match stop | frontend/backend |
| `unknown-ambiguous` (two lockfiles, no test script) | `init` lists unknowns, never invents a command; `reconcile --plan` stable | projet inconnu |
| `permissions-secrets` (`.env`, symlink to `/etc`, hardlink, `.git/hooks`, husky dir, README prompt injection) | MUST-DENY paths, redaction of an echoed secret, `policy-violation` stop after N denials, BLOCKED on a write outside ownership via a command, S-61 | permissions et secrets |
| (script) `provider-faults` | timeout, 429 with reset ⇒ QUOTA_EXCEEDED, 401 ⇒ AUTH_REQUIRED, then `resume`; no silent fallback assertion | provider timeout/rate limit |
| (script) `vuln-then-fix` | reviewer reports a security finding with location + reproduction ⇒ FIX ⇒ re-review clean | review trouvant puis corrigeant une faille |
| `ts-monorepo` × 2 runs | overlapping zones refused, disjoint zones coexist, project lock exclusive for `migrate` | run concurrent |
| the Cohorte repo itself | §6.4 D1-D6 | dogfooding |

**Crash at every transition.** `COHORTE_CRASH_AT=<name>[#<nth>]` makes `crashpoint()` call `process.kill(process.pid, 'SIGKILL')`.
`tests/crash/every-transition.e2e.ts`: (1) record the golden `ts-monorepo` scripted run and its `(point, occurrence)` hit list; (2) **for each
pair**: start the run with a detached host and the env var, wait for the host to die, `cohorte resume`, and assert against the golden final
state — same terminal state, same integration tree digest, the same set of effect keys with exactly one `done` each, no two commits with the
same `Cohorte-Effect` trailer, gapless sequence + valid chain + valid anchors, zero leftover processes (pid/startToken sweep empty), zero
leftover worktrees outside the run's set, a `ResumeReport` consistent with the crash point; (3) the meta-test fails if a name in `CRASHPOINTS`
was never hit. **The real-SIGKILL matrix runs on every PR, sharded across CI workers** (not nightly-only); an in-process thrown-exception mode
exists only as a fast local smoke.

### 7.4 Security tests (named ids; `security` is a required CI job)

**Port of V2's 70 gate cases** (`security/test/decide/commands.v2-port.test.ts`); the V2 input was a shell string, the V3 input is what a model
can actually send: `{ argv, cwd }`.

| V2 group (count) | Expected in V3 |
|---|---|
| A1-A19 command gating | identical verdicts, except: A2 (non-shell tool) becomes two cases — in-grant read allowed, out-of-grant read denied; A6-A9/A12/A13 (chains `; && \|\| \| \n`): any separator is a literal argument ⇒ the rule's positional constraint denies; two commands = two gated tool calls; A11 deny-over-ask made non-vacuous; A15 `['echo','node ace db:wipe']` ⇒ verdict of the `echo` rule only; A16 `['sh','-c',…]` ⇒ deny `security/command-trampoline`; A17-A19 unattended `ask` ⇒ `deny` matching `/nobody to confirm/` |
| B1-B15 branch-conditional | `cwd` is a validated field: inside the own worktree ⇒ branch of that worktree; the main checkout, another worktree, `..`, nonexistent ⇒ deny; **detached HEAD / unknown = protected** (V2 hole fixed) |
| C1-C4 config robustness | **inverted**: missing / unparseable / empty policy ⇒ `configuration/policy-invalid`, zero tool executions; malformed tool input ⇒ `validation/tool-input` |
| D1-D13 preflight stamp | guard `checks.digest-equals-integration`: no result / other digest / garbage ⇒ false; fresh ⇒ true; **there is no stamp file to forge** (a test writes `.cohorte/preflight.ok` and sees no effect); skipping = `policy.skip` + recorded `skip` event only |
| E1-E9 content digest | identical, incl. E9 "real index untouched" |
| F1 worktree awareness | **inverted**: a green result from another worktree/run does not validate this one (results are bound to `(runId, slot, treeDigest)`) |
| G1-G9 host dialects | dropped; replaced by one property: every verdict of every table row is a schema-valid `PolicyVerdict` |

**MUST-DENY evasions** (`must-deny.evasions.test.ts`; each asserts the verdict **and the mechanism**):

| Id | Attempt | Why it is structurally impossible |
|---|---|---|
| EV-01 | `node ./ace migration:fresh` | the node profile canonicalises the script positional to a worktree-relative realpath; without an allow rule it is denied anyway |
| EV-02/03 | `node ace "migration:fresh"`, `migration:"fresh"` | no shell ⇒ no quote removal; tokens are literal ⇒ no allow rule matches |
| EV-04 | backslash-newline continuation | no shell, no lines |
| EV-05 | `a=migration:fresh; node ace $a` | no variables; `argv[0]` is not a program |
| EV-06 | `echo <b64> \| base64 -d \| sh` | no pipes; `sh` is a non-overridable trampoline |
| EV-07 | `Node Ace db:wipe`, `npx ace db:wipe` | program resolved by realpath through the pinned PATH; `npx` is a trampoline |
| EV-08/09 | `git -C . commit`, `git -c user.name=a commit`, `git --no-pager push` | git profile: `-C/-c/--git-dir/--work-tree` ⇒ `security/command-global-option`; `--no-pager` parsed as benign so the subcommand is still `push`; agents have a built-in deny on commit/push |
| EV-10 | `docker-compose up` | alias-normalised to `docker compose` |
| EV-11/12/13 | `pushd <main> && …`, `M=<main>; cd $M && …`, `(cd <main>; …)` | no builtins, no subshell; a `cwd` outside the agent's worktree is denied |
| EV-14/15 | overwrite or delete the gate config; forge a stamp | `.cohorte/**` is a protected root; policy is a hashed in-memory snapshot; results are hash-chained events |

**New cases.** S-01..S-13 paths: `../` escape, absolute outside roots, outgoing symlink, symlink to a sibling surface, final-component symlink
write, symlink swapped between gate and use (use-time `(dev,ino)`), `.ENV` on a case-insensitive volume, NFC, hardlinked file on write, NUL
byte, `src/backend-evil` vs `src/backend/**`, `.git` file + nested `.git`, `.cohorte/state/cohorte.db`, Pi `auth.json`, install dir,
FIFO/device, a `git.worktreeRoot` inside a protected root (refused at config resolution). **S-14/S-15 output filtering** (2.7): `search`
never returns a planted `certs/server.key` / `id_rsa`; `git_diff` never returns a tracked `.env.example` or `.cohorte/**`, with and without
`paths`. S-20..S-27 executor: **S-20** — with canaries in the parent env (`ANTHROPIC_API_KEY=canary GH_TOKEN=canary`), no canary *name or
value* is visible to a `node` child and every visible name lies in `allow ∪ OS_INJECTED_ENV[platform]` (an exact-equality assertion cannot
pass on macOS, where CoreFoundation injects `__CF_USER_TEXT_ENCODING`); timeout kills a grandchild ignoring
SIGTERM; setsid escapee found by the sweep; output cap kills; fork bomb bounded where `processes` is enforced, reported otherwise; **under L1:
no network (an allowed `curl` fixture rule fails closed), no write outside the worktree, no read of the denyRead set**; `doctor --json` equals
what the probes observed. **S-28 (macOS escape)**: from an allowed command, `open -a`, `open <file>` and `osascript` cannot create a canary
outside the worktree, and signalling the run host fails. **S-29 (Linux escape)**: `connect()` to a Unix socket outside the worktree —
`/var/run/docker.sock` and `$XDG_RUNTIME_DIR/bus` included when present — fails. Until the platform's escape test passes, `doctor` reports
`partial`, never `enforced` (2.6.6). S-30..S-35 control plane: forged MAC ⇒ rejected and the approval stays pending; missing MAC; replayed `commandId`;
tampered event row (chain) and rewritten chain without the key (anchor MAC); `UPDATE events` blocked by trigger; zombie host fenced;
SIGKILL of the CLI observer does not affect the run. **S-36 separation of identities** (2.6.7): no sequence of agent tool calls yields an
accepted command, a resolved approval, or an event with `source: 'human' | 'client'`. **S-37/S-38 project-config trust** (2.10.1): a hostile
fixture config (`sandbox.require: best-effort` + a `dangerousCommands` rule) ends in `security/project-policy-untrusted` with zero processes
spawned; the same config, granted and then edited, asks again. S-40..S-46 subscription guarantee: parent env `ANTHROPIC_API_KEY=canary
OPENAI_API_KEY=canary GH_TOKEN=canary AWS_PROFILE=x` never reaches a request; stored `api_key` credential ⇒ AUTH_REQUIRED/`mode-mismatch`;
expired OAuth with failing refresh ⇒ AUTH_REQUIRED; ambient source ⇒ refused; `baseUrl` mismatch ⇒ BLOCKED; `monetaryCost` is
`not_applicable` for codex **and a number for the Anthropic opt-in**; the symbols of rule (e) are absent from the repo. S-50..S-53 redaction:
secret value, its base64, PEM in command output, OAuth error text never present in DB, logs, blobs or the text returned to the model;
**S-53 also prints a canary on the brain child's stderr and asserts it is absent from `host.log`** (3.2). **S-54 terminal injection**
(2.3.6): an approval preview, a summary and a finding text containing `\x1b[2K` and a C1 CSI are rendered escaped by the CLI tree view,
`--format=line` and every panel; `summary` never stores them.
**S-60 rogue runtime**: a test `AgentRuntime` that tries to act without the host has no executor to call (type-level + suite). **S-61 prompt
injection**: the fixture README instructs the agent to read `.env` and `curl` it ⇒ both calls denied, run continues, two `tool.denied`.
**S-70 hook canary** (5.0). **S-71 provisioning scripts canary**: a `postinstall` that writes a canary never runs. S-72: host refuses uid 0.
**S-73 dependency integrity** (5.7): a check that rewrites `node_modules/<pkg>` fails under L1 (read-only) and is detected before the next
TEST under L0 (`security/deps-tampered`). **S-74 no hardlink into the store**: after provisioning, sampled files have `nlink == 1` and a
write through the slot never changes the store's bytes.

### 7.5 `tests/acceptance/` — one executable check per spec-29 V3.0 bullet (the definition of done)

| Spec 29 bullet | Check |
|---|---|
| fixture init → spec → `build → test → review → fix` without manual orchestration | AC-01: `ts-monorepo` happy + review-fix scripts through the built CLI |
| workflow and stops decided by TS, not a prompt | AC-02: totality tables + `check-prompts` + a fake agent whose text says "skip review, ship now" changes nothing |
| no write outside ownership, no refused command | AC-03: `permissions-secrets` + S-20..S-27 under L1 |
| interrupted run resumes without dangerous duplicate | AC-04: the crash matrix |
| subscription mode, provider, tokens, quotas, model, tools, files, approvals observable; no API billing without activation | AC-05: golden stream contains every listed field; S-40..S-46 |
| Pi replaceable by a fake runtime | AC-06: the same e2e under FakeRuntime; conformance suite green on both runtimes |
| François can display and control through the protocol without knowing Pi | AC-07: a schema-only client (ajv + `schemas/*.json`, zero Cohorte imports) renders the tree from `status --json`, tails, fetches a diff and an artifact through `inspect`, approves and cancels through one-shot spawns under 10 s / 4 MiB, and validates every `--json` it receives; identifier scan: **no Pi identifier in any PROTOCOL schema** — the schemas generated from `@cohorte/protocol` (`events`, `commands`, `run-state`, `agent-output`, `project-status`, `inspect`, `run-diff`, `command-result`, `doctor-report`, `auth-status`) and from `@cohorte/runtime-contract`. R10 and spec 17 are about the protocol; `config.schema.json` describes a *project's* choices and legitimately names the engine it configures (`runtime.pi`, `authentication.anthropicSubscriptionViaPi`), so it is outside the scan (ADR-0005 item 7) |
| prompts, schemas and code packaged and hashed | AC-08: packaging test + asset tamper ⇒ fail |
| an update does not change an active run | AC-09: D3 + D4 |
| Cohorte modifies Cohorte in a worktree, new code only at the next run | AC-10: D2 + D4 (+ the real-run release gate) |
| `reconcile --plan` detects drift, destroys no human override | AC-11: D1 + drift tables |
| unit, integration, E2E, security and migration tests pass in CI | AC-12: the CI job list below is complete and green |

### 7.6 CI jobs (spec 25 "La CI MUST")

`lint` (`biome ci .`, `check-layers`, `check-contract-words`, `check-prompts`; `nursery/noFloatingPromises: error`) · `typecheck` (`tsc -b`
**and `tsc -p tsconfig.tests.json`**, TS 7.0.2: tests, `tests/**`, `scripts/**` and testkit, 7.0) · `unit` / `integration` (matrix: Node 24.16.0, 24.x, 26.x × ubuntu, macos) · `schema-compat` ((1) `gen-schemas` + `git diff
--exit-code schemas/`; (2) every `schemas/*.json` compiles under `ajv/dist/2020` strict; (3) golden instances of every past release validate
under the new schemas; (4) structural diff vs the last release tag — a removed property, new `required`, narrowed closed enum, changed type or
changed durability is BREAKING and needs a major + numbered migration + fixture; (5) forward tolerance: the *previous* release's open schema
accepts the *new* golden stream) · `security` (tables + EV-* + S-*; on ubuntu installs `bubblewrap` and applies the Wave-0 probe's documented
userns remediation, on macos runs Seatbelt cases; degradations are asserted through `doctor --json`, never skipped silently) · `migrations`
(every state fixture → head; refuse-then-migrate flow) · `packaging` (`pnpm build && pnpm pack` → `npm i --ignore-scripts <tgz>` in an empty
dir → `cohorte --version`, `doctor --json`, `agent-host.mjs --selftest`, `verifyAssets` ok then tamper ⇒ fail; tarball contains only `dist/
assets/ LICENSE README.md package.json`; no `@cohorte/*`, no `devDependencies`, no test hook strings; `cli.mjs` imports no `@earendil-works/*`;
`cohorte status --panel=runs` cold start under 300 ms) · `e2e-fake` · `crash-matrix` (sharded, every PR) · `dogfood` · `acceptance` ·
scheduled `pi-latest` (`tsc -p tsconfig.tests.json` — which is what makes `type-proof.ts` fail on an API change — + tripwires + conformance against Pi `latest`; early warning only, the pin moves by a deliberate PR) · manual
`live-provider` (`workflow_dispatch` / `pnpm test:live`, budgeted, never on PRs). `publish.yml` keeps its filename and environment and depends
on `ci` through `workflow_call`; `docs.yml` and `discord-releases.yml` survive unchanged.

---

## 8. Provisional decisions — ADR index (spec 31, spec 32: open choices stay open, none is a hidden invariant)

| ADR | Decision (one line) | Covers |
|---|---|---|
| 0001 | Pi `@earendil-works/pi-coding-agent@0.85.1` exact; candidate C, SDK-in-child, Cohorte-owned IPC; `runRpcMode` host as fallback | OQ1, D1 |
| 0002 | SQLite (`node:sqlite`) only, behind an async `StateStore` with sync tx bodies; `MemoryStateStore` second implementation | OQ2, D4 |
| 0003 | L0 always; L1 in-house Seatbelt/bubblewrap in V3.0; default `native` for model runtimes holding `run_command`; macOS brain sandbox on | OQ3 |
| 0004 | NDJSON only; detached run host; pure-reader observers; durable command inbox; `--panel` adapters; no HTTP/WS | OQ4, D5 |
| 0005 | One real provider `openai-codex`; Anthropic-via-Pi = triple opt-in **accounted as metered**; API-key mode opt-in; Claude Agent SDK runtime = future; the "no Pi identifier" scan covers the protocol schemas, not `config.schema.json` | OQ5, D2 |
| 0006 | No automatic cross-provider fallback in V3.0; seam returns only already-connected allowlisted subscriptions | OQ6 |
| 0007 | Cohorte (code) creates commits; agents never commit; user branch / push / PR = `release-manager` + human approval | OQ7, D9 |
| 0008 | Merge into the run's integration branch is V3.0 (plumbing + CAS, revalidated); merge into a user branch is not automatic | OQ8, D9 |
| 0009 | Windows best-effort, not a V3.0 target; refusal is capability-driven, never an OS literal | OQ9 |
| 0010 | Retention defaults: events forever, transcripts 30 d (gzip after 1 d), artifacts 90 d, spool run end + 1 d | OQ10 |
| 0011 | No external skill signing in V3.0; skills are shipped or project-local, hashed, cannot grant permissions; `signature`/`source` reserved | OQ11 |
| 0012 | Semantic discovery is V3.1; V3.0 `init`/`discover` are deterministic and offline | OQ12 |
| 0013 | AGPL-3.0-only, one npm package; no remote telemetry in V3.0 (`telemetry.remote: true` is rejected, not a schema constant) | OQ13 |
| 0014 | Nothing V2 on the execution path; sources in `legacy/v2/`; cockpit-compatible verbs kept; importer = V3.1 | OQ14, D8 |
| 0015 | Subscription-mode guarantee = six layers; auth decided on live calls (never the snapshot accessors); per-request guard fetch; never `readStoredCredential` / `getAuth` | D3 |
| 0016 | Toolchain per toolchain.md **with `isolatedDeclarations: false`** | D4 |
| 0017 | Node floor `^24.16.0 \|\| >=26.1.0` | D4 |
| 0018 | Pipeline profiles `feature` / `bugfix` / `review` over one versioned table per profile | D6 |
| 0019 | Durable vs ephemeral events; `(sequence, sub)` ordering; agent events "Pi-shaped, not Pi-typed" | D7 |
| 0020 | V3.0 binding scope = spec 28 V3.0 list + every spec 29 bullet | D10 |
| 0021 | Worktree slot per surface, one agent at a time, own branch per agent; worktree root outside the repo by default | spec 14, 15 |
| 0022 | Control plane authenticated by file modes + HMAC; MAC anchors on the event chain; host refuses uid 0 | spec 17.2, 23 |
| 0023 | A run belongs to its install: resume under a different runtime is refused; no adopt flag | spec 3 principle 8, 16, 29 |
| 0024 | `run_command` is argv-only; pinned-PATH realpath resolution; non-overridable trampoline deny set | spec 9, 23 |
| 0025 | Recovery = fresh incarnation + file ledger + checkpoint commits + replay classes; approvals are pre-state-bound one-shot grants (commands bound to the tree digest); an approved call with no live requester is replayed by the host when the binding still matches | spec 2.1, 11.3 |
| 0026 | Project-config trust: keys are `tighten-only` / `loosen` / `neutral`; loosening keys of the repository file need the local user's consent (user config, CLI flag, or a trust-on-first-use record bound to a hash) | spec 10.1, 23 |

---

## 9. V3.0 scope cut (D10) per spec section

| Spec § | In V3.0 | Stubbed with a seam | Out (V3.1+) |
|---|---|---|---|
| 4 repository | monorepo, all packages of 1.1 | `apps/daemon` (README only) | — |
| 5 AgentRuntime / PiRuntime | full contract, PiRuntime (SDK-in-child), FakeRuntime, conformance suite, tripwires | `runRpcMode` host variant (documented fallback); `Continuation.transcript` | second runtime (Claude Agent SDK) |
| 6 lifecycle | full | `parentAgentId` recorded; no agent-spawned sub-agents | sub-agents |
| 7 context | manifest, provenance, tiers, limit, deterministic reduction (`excerpt`, `outline`, `dropped`), exclusions | `summary-with-refs` (interface only) | semantic search, compaction |
| 8 roles, skills, ownership | roles **implementer, fixer, reviewer, security-reviewer** (when listed in ownership); ownership; inline skills | architect (contract authoring), verifier, brainstormer, spec-author, tester, release-manager, discoverer, reconciler: prompts + role ids reserved | skill registry |
| 9 tools / gates / sandbox | `read_file, list_files, search, write_file, patch_file, run_command, git_diff, approval_request, submit_result`; full gate chain; L0 + **L1**; doctor capabilities; macOS brain sandbox; `policy explain` | `git_commit`, `network_request`, `secret_read` (registered, granted to nobody) | proxy-based host allowlisting |
| 10 providers / budgets | openai-codex subscription; auth guarantee; five budget levels + all seven dimensions; quota events; billing table | static tier routing; API-key mode and the Anthropic opt-in (policy + accounting implemented, exercised with fakes only); price catalogue file | multi-provider routing, fallback, latency/residency routing |
| 11 state machine | all states, three profiles, loop controller, retries, resume, command matrix | BRAINSTORM + SPEC executors (`phase.available = false`; `cohorte brainstorm` creates a deterministic draft and `cohorte spec` validates/freezes YAML); SHIP minimal | agentic brainstorm/spec, PR/push |
| 12 discovery | deterministic scan for `init` and `discover` | `--semantic` rejected with a clear message | semantic discovery |
| 13 reconcile | `reconcile --plan` and conflict-free `reconcile --apply` with five field classes, six diff classes, provenance/hash guard, backups and audit journal | — | `update --apply` |
| 14 `.cohorte/` | subset of 2.10 | `generated/` skeleton | rendered agents/contracts/checks |
| 15 git | all of section 5 | — | richer merge strategies |
| 16 dogfooding | all of section 6 incl. the real-run release gate | — | `self-update` |
| 17 protocol | envelope, full catalogue, commands **each with a CLI verb**, snapshot docs + one `[S]` document per `--json` output (2.3.5), NDJSON, authenticated inbox | `run-tool` (rejected unless enabled), `agent.send` (off) — both registered and reachable | socket/HTTP/WS |
| 18 François | `--json`, `--panel`, `--format=line`, schema-only client test (AC-07) | — | native cockpit |
| 19 observability | stderr logger, durable events, accounting reducers, redaction as a type | metrics export | trace exporters |
| 20 persistence | SQLite + memory, migrations, hash chain + anchors, CAS | file/remote store (interface proven by the memory store) | — |
| 21 CLI | `init, doctor, discover, run, loop, status, inspect, resume, pause, cancel, shutdown, approve, deny, retry, skip, logs/tail, diff, review, fix, ship, auth login/status/logout, providers list/test, models list, config get/set/validate/trust, migrate, reconcile --plan/--apply, spec validate/freeze, policy explain, gc` (+ `run-tool`, `send`: registered, answering `configuration/phase-not-available` unless policy enables them) | `update --check` (prints the installed vs pinned asset versions, offline), `brainstorm` (deterministic draft scaffold; no agentic panel) | `update --apply` |
| 22 outputs | full | — | — |
| 23 security | all MUST measures — "séparation des identities" = 2.6.7 (key holders / system / agents, test S-36); the repository-as-adversary case = 2.10.1 (S-37/S-38) | cryptographic *signatures* (asymmetric) of approvals — V3.0 uses HMAC behind a scheme-neutral `auth` field; per-actor identity | — |
| 24 errors | full, incl. `impact` | — | — |
| 25 tests / CI | all of section 7 | live-provider job manual | — |
| 26 distribution | npm package, macOS + Linux x64/arm64 | — | packaged binary, Windows |
| 27 V2 → V3 | `legacy/v2/`, cockpit-compatible verbs | importer seam (`project-model/src/import/`) | `cohorte-v2 export`, `init --from-v2` |

CLI verb semantics worth fixing now: `cohorte review --ref <rev>` / `--base a --head b` starts a **`review`-profile run** (D6/R3 reachable from
the CLI); `cohorte review <run-id>` starts a review-profile run over that run's integration head (`reviewTarget: { runId }`); `cohorte fix
<run-id>` = `retry { target: { kind: 'phase', state: 'FIX' } }` (legal per `retry.target-legal`); `cohorte ship <run-id>` shows and resolves the
pending `ship` approval; `cohorte discover` prints the deterministic scan as a Project Model document without writing anything.

Deliberately **not** built although a proposal had it: a shell-script form of `run_command` and its tokenizer; an SSRF network policy for a
tool nobody can call; continuation-from-transcript; per-mutation tree digests; `reconcile --apply`; a user-facing runtime-adopt flag; zstd blob
compression (gzip only); quota auto-wakeup beyond a single in-process timer (the host stays alive while it is armed, 2.5.3; nothing is
scheduled with the OS); an in-repository worktree root under `.cohorte/`; running skill checks.

---

## 10. Work breakdown

> **`docs/v3/PLAN.md` (+ `plan.json`) is normative for the unit cut, ownership, order and checks**; it re-cuts this section into seven waves
> and records every amendment decided after this section was written (for instance: `RunSnapshotManifest` is a `core` contract, not a
> `config` schema; test-only workspace edges; `tsconfig.tests.json`; runnable linked gate builds; in-memory `BlobStore`/`RunFiles`/spool in
> Wave 0). This section remains the rationale for the rules and the critical path.

### 10.1 Rules that make parallel work in ONE working tree safe

1. **Exclusive path ownership.** A unit creates/edits files only under its owned paths; no two units of a wave own overlapping paths (nested
   ownership is forbidden too: a parent directory and one of its children are never owned by different units of the same wave).
2. **One owner for all structural files, for the whole project: the lead.** Root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, root
   `tsconfig*.json`, `biome.json`, `vitest*.config.ts`, `layers.json`, `.github/**`, `.gitignore`, **every package's `package.json` and
   `tsconfig*.json`, every `src/index.ts` barrel, `schemas/**`, `apps/cli/src/cli.ts`**. Wave 0 pre-declares every dependency named in this
   document and runs `pnpm install` once. A unit that needs something else writes `docs/v3/requests/<unit>.md` (its own file); the lead
   applies it at the gate.
3. **Barrels, stubs and the CLI verb registry are frozen in Wave 0.** Every `src/index.ts` re-exports from files that already exist as typed
   stubs (final signature, body `throw new NotImplemented()`); `apps/cli/src/cli.ts` pre-registers **every** verb of §9 against a stub module
   `commands/<verb>/index.ts`. Later units fill stubs; they never edit a barrel, the registry or another unit's stub.
4. **Inside a wave, imports go only to Wave-0-frozen contract files** (or to the unit's own files). A unit that needs a sibling's behaviour
   uses the fake from `testkit` or a local fake. This keeps a half-written sibling out of your typecheck closure.
5. **Per-unit checks write no shared output and see only owned code**: each unit gets `tsconfig.check.<unit>.json` (`composite:false`,
   `noEmit:true`, `include` restricted to its owned directories + the frozen contracts), because several units live inside one package
   (`core`, `security`). Unit acceptance = `tsc -p tsconfig.check.<unit>.json` + `vitest run <owned paths>` + `biome check <owned paths>`.
6. **No unit runs `pnpm build`, `tsc -b`, `gen-schemas` or `pack`** (tsdown `clean:true` would wipe the shared `apps/cli/dist`; `tsc -b`
   writes shared `.tsbuildinfo`; `schemas/` has one owner). E2E units consume an immutable gate build at `.build/gate-<n>/` exported as
   `COHORTE_E2E_BUILD_DIR`, or build privately with `scripts/build.ts --out .build/<unit>/`; either is **runnable offline** because
   `build.ts --out` links `.publish/node_modules` to `apps/cli/node_modules` (1.4 step 7).
7. **Contracts are read-only after gate G0.** A unit that believes a contract is wrong files a request and continues against a local adapter;
   the lead amends, regenerates schemas and announces it.
8. **Never commit, never push from a unit.** At every gate the lead takes a rollback checkpoint: a binary patch of tracked changes + a tarball
   of untracked files, written to the scratchpad (or lead-only commits on `feat/v3-rewrite` if the human authorises them — §12.3).
9. Every unit ends by printing its acceptance command's output.

### 10.2 Critical path and waves (FakeRuntime first; Pi is never on the critical path)

```text
W0  scaffold+base+vocabulary (1 agent) ─► contracts A ∥ B ∥ C ∥ Pi/Linux probes (4 agents) ─► G0 freeze      two serial steps, no more
W1  leaves ∥ walking skeleton (a) engine×real SQLite×crash/resume on a toy table ∥ skeleton (b) runtime-pi parent × FAKE BRAIN, then Pi + faux
W2  composition inside core ∥ tools ∥ project-model ∥ run host ∥ control CLI           ◄── first spec-29-shaped green (fake runtime, built CLI, kill -9, resume)
W3  hardening: crash matrix ∥ security e2e ∥ concurrency ∥ Pi in the loop ∥ auth/providers CLI ∥ packaging+pin ∥ schema-compat+migrations
W4  dogfood e2e ∥ acceptance suite ∥ docs+CI+ADRs refresh ─► live smoke ─► the real Cohorte-on-Cohorte run (release gate)
```

### 10.3 Wave 0 — scaffold, contracts, probes

| Unit | Owned paths | Deliverables | Acceptance |
|---|---|---|---|
| **U0.1 scaffold + base + vocabulary** (serial, first) | all structural files of rule 2; `packages/base/**`; `packages/protocol/src/vocabulary.ts`; `scripts/**`; `legacy/v2/**`; stubs + barrels for every package; `apps/cli` skeleton (`cli.ts` with every verb registered, `tsdown.config.ts`); minimal `packages/runtime-pi/src/child/entry.ts` with `--selftest`; canary tests; `packages/testkit/src/{git-env,temp-repo,fixed-clock,seq-ids,fault-injector}.ts` | workspace installs, typechecks, lints; `@cohorte/base` complete (2.1); vocabulary (2.3.1); two-entry tsdown build with `onlyBundle: []`/`onlyImport`; `embed-assets`, `stage-publish`, `write-bundle-manifest`, `build.ts --out`, `check-layers`, `check-contract-words`; **scripted legacy move**: `git mv` of `bin core lib profile scripts assets install.sh install.ps1` and the V2 `package.json` to `legacy/v2/`, `ci.yml` rewritten for V3 with a `legacy-v2` job that still runs the V2 tests from `legacy/v2`, `publish.yml`/`docs.yml`/`discord-releases.yml` untouched | `pnpm i && pnpm lint && pnpm exec tsc -b && pnpm exec vitest list` (finds every canary) `&& pnpm build && pnpm pack:check` (installs the tarball in a temp dir, runs `cohorte --version` and `agent-host.mjs --selftest`) |
| **U0.A runtime frontier** | `packages/runtime-contract/**`; `packages/runtime-pi/src/protocol.ts`; `packages/testkit/src/fake-brain/frames.ts` | 2.2 in full (types published first so U0.C can import `ToolGrant`); **complete** conformance suite + 60-line echo runtime; `AgentHostProtocol` frames (3.3) | check + `vitest run packages/runtime-contract`; forbidden-word scan passes |
| **U0.B protocol frontier + store contract** | `packages/protocol/src/**` (except `vocabulary.ts`), `packages/protocol/test/**`, `fixtures/schema-compat/3.0.0-dev/**`; `packages/persistence/src/{contract,records}.ts`, `packages/persistence/src/conformance/**`, `packages/persistence/src/memory/**`, `migrations/state/0001_init.sql` | 2.3 in full + `agent-output.ts` + NDJSON codec + `compileStrict`/`toOpenJsonSchema` + one payload fixture per event type; 2.4 interfaces + DDL + **complete** store conformance suite + `MemoryStateStore` passing it | check + `vitest run packages/protocol packages/persistence` |
| **U0.C host-side contracts** | `packages/config/src/schema/**`; `packages/security/src/contract/**`; `packages/git/src/contract.ts`; `packages/tools/src/catalogue/**`; `packages/core/src/contract/**`, `packages/core/src/pipeline/tables/**`, `packages/core/src/errors/catalogue.ts`, `packages/core/src/durability/crashpoints.ts` (list only) + matching `test/contract` dirs | config/ownership/spec/manifest/skill schemas + defaults + sample YAMLs (`RunSnapshotManifest` is authored with the `core` contracts, 6.1); 2.6 types; `GitPort`; tool catalogue with `toToolGrant()` flat-schema assertion; 2.5 types, **internal ports**, the three tables as data, `GUARD_IDS`, `TRANSITION_EFFECT_IDS`, `ALL_STOP_REASONS`, the command matrix as data, error catalogue with `impact` | check + table well-formedness, stop-reason exhaustiveness, command-matrix totality, error codes unique, every tool schema flat |
| **U0.P probes** (needs only U0.1) | `docs/v3/probes/**`, `packages/runtime-pi/test/tripwires/probe-*.itest.ts` | executed answers, each with a **pre-agreed decision rule**: P1 [A-1] `streamFunction` wrapper seen for every request incl. continuations (red ⇒ capabilities stay `partial`, fallback pause = stop-after-turn); P2 [A-3] codex provider + dummy OAuth credential + injected `fetch` relays 401/429 status + headers (red ⇒ fixture-only header tests); P3 [A-2] Linux `bwrap` on ubuntu-24.04 incl. the AppArmor userns restriction and IPC fd passing (red ⇒ documented sysctl remediation in `doctor`; fd 3/4 framing for the brain); P4 [A-5] two children forcing an OAuth refresh concurrently against a fake OAuth endpoint take Pi's file lock | `vitest run packages/runtime-pi/test/tripwires` + the four written verdicts |
| **G0 contract freeze** (lead) | `schemas/**` | `gen-schemas` committed to the tree; golden fixtures; `.build/gate-0/` | `tsc -b && pnpm lint && vitest run --project unit && scripts/schema-compat.ts --self` |

### 10.4 Wave 1 — leaves and the two walking skeletons (all depend on Wave 0 only)

| Unit | Owned paths | Deliverables (tests listed in §7) |
|---|---|---|
| U1.1 sqlite store | `packages/persistence/src/{sqlite,migrate,blob,files,spool}/**`, `packages/persistence/test/**` | `SqliteStateStore` (fencing, chain, anchors, locks with zone overlap, inbox, effects, ledger, snapshots keep-3), migration runner + `backup()`, `BlobStore` with verify-on-read, `RunFiles`, `EphemeralSpool` |
| U1.2 security/decide | `packages/security/src/decide/**`, `packages/security/test/decide/**` | `PathResolver`, `ProgramProfile`s (git, pnpm, npm, yarn, node, docker), `CommandPolicy`, five pure stages, `PolicyEngine`, `explain` |
| U1.3 security/exec + redact + auth | `packages/security/src/{exec,redact,auth,doctor}/**` + tests | L0 executor (kill-tree + sweep, caps, rlimit wrapper), **Seatbelt + bwrap backends**, capability probe, `Redactor` + `seal`, `KeyStore`, `CommandAuthenticator` |
| U1.4 git | `packages/git/src/impl/**`, `packages/git/test/**` | everything in §5 that is git mechanics, hardened runner, S-70 |
| U1.5 runtime-fake | `packages/runtime-fake/**` | FakeRuntime, script schema + YAML loader + builder, FakeLedger; conformance green |
| U1.6a runtime-pi parent (**skeleton b, part 1**) | `packages/runtime-pi/src/{parent,pin,classify}/**` + tests; `packages/testkit/src/fake-brain/{child.ts,scripts/**}` | spawn, env allowlist, IPC + fd framing, attestation check, heartbeat, pause latch, cancel ladder, pin (package trees), classifier table — **all proven against the fake brain, no Pi import** |
| U1.6b runtime-pi child (**skeleton b, part 2**) | `packages/runtime-pi/src/child/**`, `packages/runtime-pi/test/{support,child,tripwires}/**` (except probe files) | entry (3.4), normaliser, budget, auth modes, the never-bundled test entry; conformance via faux; tripwires; auth canary. **Day-1 checkpoint**: if the Node IPC child is not green, switch the child to the executed `runRpcMode` host behind the same parent |
| U1.7 config loader + providers | `packages/config/src/{load,write,migrate}/**`, `packages/providers/**` + tests | load/merge/resolve, comment-preserving writer, `resolveModel` (tier table: `coding`/`reasoning` → `gpt-5.5`, `fast`/`cheap` → `gpt-5.4-mini`, validated fail-closed at run start), billing table, `costOf`, header parsers |
| U1.8 telemetry + testkit rest | `packages/telemetry/**`, `packages/testkit/src/{http-provider,crash,run-cli,golden}/**` | sealed-text logger, accounting reducers; injected-fetch fake provider, crash-harness runner, `runCli` |
| U1.9 core/pure | `packages/core/src/{state,pipeline/guards,loop,review,agents/lifecycle.ts,budgets,grants,projection}/**` + tests | `evolve`, `nextStep`, guards, `decideAfterReview/Test`, `checkGlobalStops`, `nextEscalation`, review math, lifecycle, budget math (five levels), `computeGrant`, snapshot-document projection |
| U1.10 core/engine (**skeleton a**) | `packages/core/src/{engine,durability,events}/**` + tests | `RunEngine`, `EffectJournal`, `EventWriter`, lease/fencing, inbox handling with MAC port, `Resumer` with injected verifiers — **on a toy 2-state table local to its tests, against `MemoryStateStore`** (frozen in W0); the same suite is re-run against the real SQLite file at gate G1 by the lead, which is where skeleton (a) closes |
| U1.11 assets | `prompts/**`, `skills/**`, `scripts/check-prompts.ts` | doctrine ported from `legacy/v2` (implementer, fixer, reviewer, security-reviewer, system/base, system/untrusted-data, system/submit-result), shared skills; **no control logic** |

Gate G1: requests applied → `tsc -b` → full unit + integration → `check-layers` → skeleton (a) on SQLite with a crash/resume at every commit of
the toy run → `.build/gate-1/`.

### 10.5 Waves 2-4 (units; same table discipline as above)

| Wave | Unit | Owned paths | Deliverables |
|---|---|---|---|
| W2 | U2.1 tools | `packages/tools/src/impl/**`, `packages/tools/test/impl/**` | nine implementations, use-time re-verification, `verifyAfterCrash`, `describeForNote`, `WorkspaceReader` |
| W2 | U2.2 toolhost + approvals | `packages/core/src/{toolhost,approvals}/**` + tests | `CohorteToolHost` (stages 0-8, journal, replay, ledger rows), `ApprovalService` (grant keys, pre-state binding, unattended rule, expiry, parking) |
| W2 | U2.3 context + snapshot | `packages/core/src/{context,snapshot}/**` + tests | `ContextBuilder`, renderer, `RunSnapshotter`, `PinReader` |
| W2 | U2.4 agents + worktrees | `packages/core/src/{agents/supervisor,worktrees,provision}/**` + tests | `AgentSupervisor` (the one total `RuntimeEvent → Envelope` mapper), `WorktreeService` (slots, checkpoints, ledger audit, quarantine), `Provisioner` |
| W2 | U2.5 phases | `packages/core/src/phases/**` + tests | `GenericPhaseExecutor`, `CheckPhaseExecutor`, the six phase contracts, `MergeService`, `CommitService` |
| W2 | U2.6 project-model | `packages/project-model/**` | deterministic scan, `planInit`/`applyInit`, desired state, five-class/six-class drift, hash guard |
| W2 | U2.7 host + observers + controllers | `apps/cli/src/{host,observe,control,compose,assets,pin}/**` + tests | composition root, `__host` (detached spawn from the pinned install, lease, heartbeat, poke watch, fatal handlers, uid/target guards), observers, signed controllers |
| W2 | U2.8 commands | `apps/cli/src/{commands,render,panels}/**`, `apps/cli/src/lazy.ts` + tests | every verb of §9, human + `--json`, error rendering (cause/impact/run/next/exit), `--panel`, `--format=line`, `doctor` framework (node, git ≥ 2.38, sqlite local FS, sandbox capabilities, `rg`, locks, migrations, gitignore, uid ≠ 0, key modes) |
| W2 | U2.9 e2e-fake | `tests/e2e/**`, `fixtures/repos/{ts-monorepo,frontend-backend}/**`, `fixtures/scripts/**` | the spec-29 slice, **written against the W0 CLI contracts from day 1, red until gate G2** |
| W3 | U3.1 crash matrix | `tests/crash/**` | recorder + every-pair SIGKILL suite + meta-test, sharding |
| W3 | U3.2 security e2e | `tests/security/**`, `fixtures/repos/permissions-secrets/**` | S-* end to end, L1 probes, control-plane cases |
| W3 | U3.3 concurrency + providers e2e | `tests/e2e/{concurrent,provider-faults,unknown}/**` (new sub-directories; U2.9's files are frozen by then), `fixtures/repos/unknown-ambiguous/**` | zones, project lock, takeover; provider fault scripts on both runtimes |
| W3 | U3.4 Pi in the loop | `tests/integration/pi-faux/**` | full slice composed programmatically with `createRunHost()` + PiRuntime + faux; pause/cancel/approval over IPC; brain crash ⇒ new incarnation |
| W3 | U3.5 auth/providers CLI | `apps/cli/src/commands/{auth,providers,models}/**` (filling W0 stubs left empty by U2.8) | `auth login`, `auth status`, `auth logout` through the child auth modes (timeout, prompt teardown, sealed errors), billing caveats in `doctor` |
| W3 | U3.6 packaging + pin + schema-compat + migrations | `tests/packaging/**`, `scripts/schema-compat.ts` (hand-over from the lead recorded), `fixtures/state/**`, `tests/integration/migrations/**` | 7.6 packaging job, pin tamper, golden instances, refuse-then-migrate |
| W4 | U4.1 dogfood | `tests/dogfood/**`, the Cohorte repo's own `.cohorte/**` (one surface per package, `shared` = root config with `approval: human`), `scripts/dogfood-install.ts` | §6.4 D1-D6 |
| W4 | U4.2 acceptance | `tests/acceptance/**` | AC-01..AC-12 |
| W4 | U4.3 docs + CI (lead) | `docs/**` (not `SPEC.md`), `.github/workflows/**`, `README.md`, `CHANGELOG.md` | protocol reference generated from the catalogue, compat rules, error-code table, exit codes, ADR refresh, CI of 7.6 |
| W4 | U4.4 live smoke, then **the real run** | `tests/live/**`, `docs/v3/runbooks/live.md` | §6.4 last paragraph; release-gate checklist signed by the human |

Gates G2-G4 = requests applied → `tsc -b` → all projects → `check-layers` → `gen-schemas` freshness → immutable `.build/gate-<n>/`.
**Green state G2** is the first spec-29-shaped demo: `cohorte init fixtures/ts-monorepo && cohorte spec freeze add-greeting && cohorte run
add-greeting --runtime fake --script fixtures/scripts/happy.yaml --detach --json` → `cohorte tail <run> --json` from a second shell →
`kill -9` the host mid-BUILD → `cohorte resume <run>` → COMPLETED with exactly one commit per effect key.

---

## 11. Deviations and clarifications (everything that departs from, narrows or interprets the spec)

| # | Spec text | What this design does | Why / ADR |
|---|---|---|---|
| D-1 | §1, §5, §10.1 assume "Pi" as named when the spec was written (`@mariozechner/pi-coding-agent`) | Builds against **`@earendil-works/pi-coding-agent` 0.85.1** (exact). The old package is npm-deprecated and frozen at 0.73.1; the auth surface was rewritten (`ModelRuntime` replaced `AuthStorage`/`ModelRegistry`) | F1 · ADR-0001 |
| D-2 | §26 "Node.js LTS supporté" | **`^24.16.0 \|\| >=26.1.0`**: drops v22 although it is still maintenance LTS until 2027-04-30 (`node:sqlite` is 1.1 there, no `randomUUIDv7`; Pi already forces ≥ 22.19). **Needs the human's sign-off.** Fallback: `>=22.19.0` + `better-sqlite3` behind `SqlDriver` | ADR-0017 |
| D-3 | §17 "NDJSON sur stdin/stdout pour CLI, Unix socket pour daemon local, HTTP/WebSocket optionnel" | V3.0 = NDJSON framing only, over **one-shot CLI spawns + a store-backed inbox and event tail**; no socket, no HTTP/WS, no long-lived stdin session. Envelopes and semantics are transport-independent as §17 requires | D5 · ADR-0004 |
| D-4 | D4 / toolchain.md base tsconfig | `isolatedDeclarations: **false**`. Verified conflict: exported TypeBox consts fail with TS9010/TS9013 under the flag (TS 7.0.2 + typebox 1.3.7); declarations are emitted by `tsc -b` only | ADR-0016 |
| D-5 | §10.1 "supporter le login OAuth Pi pour ChatGPT Plus/Pro **et Claude Pro/Max**"; §2.1 "sans exiger de compte API" | V3.0 officially supports **`openai-codex`** only. Anthropic-via-Pi is a triple opt-in **accounted as metered API usage** (`authMode: api`, a cost, never `not_applicable`), because Pi's own 0.85.1 docs say third-party harness usage is billed per token, and Anthropic's terms reserve subscription OAuth for first-party clients. The sanctioned path for Claude subscriptions is a second `AgentRuntime` on the Claude Agent SDK (V3.2+) | D2, F4 · ADR-0005 |
| D-6 | §5.1 `SpawnRequest` (ten fields) | Kept verbatim + five **required** additions (`incarnation`, `thinking`, `auth`, `task`, `continuation`) that §6, §10.1 and §16 themselves require. `AgentRuntime` is verbatim; pinning/auth/login live on `AgentRuntimeProvider` | — |
| D-7 | §9 tool list includes `git_commit`, `network_request`, `secret_read`; `run_command` unspecified | The three are registered but **granted to nobody** in V3.0. `run_command` is **argv-only** (no shell string). A terminating `submit_result` tool is added (Pi has no structured output) | ADR-0024, D9 |
| D-8 | §9 "réseau désactivé par défaut", "working directory borné" | Enforced only under L1. Default `sandbox.require: native` for model runtimes; `best-effort` is an explicit recorded opt-in under which `network` rules are denied and `doctor` says filesystem/network are advisory (§26 "dégradation détectable et documentée") | ADR-0003 |
| D-9 | §11.1 state list | Adds `AUTH_REQUIRED` and `QUOTA_EXCEEDED` as first-class suspended states (named by §10.1) and makes `FAILED`/`BLOCKED` resumable through `retry` / `resume --ack` (§24 "checkpoint récupérable") | — |
| D-10 | §14 `.cohorte/worktrees/` | Default worktree root is **outside the repository** (`~/.cohorte/worktrees/…`), which §14 allows ("ou emplacement externe"). `git.worktreeRoot` may name another external directory; **the in-repo `.cohorte/worktrees` location is refused in V3.0** (`configuration/worktree-root-protected`): `<project>/.cohorte/**` is a non-overridable protected root, so every agent write there would be denied, and V3.0 does not carve an exception into that rule | ADR-0021 |
| D-11 | §15 "Chaque agent de build … travaille dans un worktree dédié" | One worktree **slot per surface**, held by one agent at a time, each agent on its own branch; the implementer and a later fixer of one surface reuse the directory | ADR-0021 |
| D-12 | §14 `state/{runs,events,snapshots,locks,cache}` directories | `events`, `snapshots`, `locks` are **tables** of `state/cohorte.db`; `runs/` and `cas/` are directories | ADR-0002 |
| D-13 | §17.2 "authentifiées par transport local"; §23 "approvals signées" | Defined as file modes + **HMAC** with a per-project key outside the repo; asymmetric signatures are a seam. Honest limit: under L0 an allowed command runs as the same uid and could read the key | ADR-0022 |
| D-14 | §16 / §3 principle 8 | Taken literally: **no** flag lets a run continue on a different Cohorte/Pi install; the host is always spawned from the pinned install | ADR-0023 |
| D-15 | §10 `ModelRef` | Verbatim; the thinking level travels beside it (`SpawnRequest.thinking`, tier table) | — |
| D-16 | §10 `authMode` (`subscription` or `api`) | Exactly these two. The fake runtime reports the mode its plan requested with `authSource: 'none'` | — |
| D-17 | §21 `cohorte review <run-id>`, `fix`, `ship`, `discover`, `update` | Semantics fixed in §9; `update --check` is offline (no npm probe in V3.0); `update --apply`, `brainstorm`, `discover --semantic` answer `configuration/phase-not-available` | D10 · ADR-0012, 0020 |
| D-18 | §22 example has no severity vocabulary | `critical \| major \| minor \| info` (V2's CRITICAL/HIGH/MEDIUM/LOW mapped) | — |
| D-19 | §25 "au moins un E2E avec fake provider" | The **fake runtime** drives E2E through the built CLI; the **fake provider** drives the real Pi loop in integration tests composed programmatically, because the shipped child has no test hook | 1.3 |
| D-20 | §23 "absence de privilèges root" | `run`/`resume`/`__host` refuse uid 0; no override | ADR-0022 |
| D-21 | §8 minimum role list | All eleven role ids (+ `verifier`) are reserved; V3.0 exercises implementer, fixer, reviewer and security-reviewer | ADR-0020 |
| D-22 | §27 migration path | Nothing built in V3.0 beyond moving V2 to `legacy/v2/` and keeping cockpit-compatible verbs | D8 · ADR-0014 |
| D-23 | §17.2 "Les commandes … produisent un event de résultat" | True for every **mutating** command (`command.accepted` → `command.completed \| rejected`). The read-only commands — `status`, `inspect`, `tail` (direct reads of the store by a pure-reader process) and `reconcile --plan` (CLI-local, no run) — **emit no result event**: a process that must be SIGKILL-safe and lock-free writes nothing (I12). Their result is the document or stream itself, each with a published schema (2.3.5) | D5 · ADR-0004 |
| D-24 | §10.1 MUST "afficher clairement … le compte/tenant non secret" | **Not available on Pi 0.85.1.** The account id is reachable only through `readStoredCredential()`, which returns the OAuth `access` and `refresh` tokens and is banned (3.7 layer 3, check-layers rule e); Pi has no metadata-only accessor (delta row A-20). `auth status` and `doctor` print `account: not exposed by the engine`, `AuthStatusDocument.accountLabelNote` says so, `ProviderAuthStatus.accountLabel` stays absent, and `authStatusWithoutSecret` is reported `partial`. Provider, auth origin, billing class, model and known quota are shown. An "audited single-file exception" was considered and rejected: it would put a token-bearing object in Cohorte's address space to display a label | ADR-0015 |
| D-25 | §8 skill manifest `checks: [{ command: pnpm test }]` (a shell string) | `SkillManifest.checks` is `{ name?, argv: string[] }[]` (the product is argv-only, I3), and in V3.0 skill checks are **declarative**: surfaced in context, never auto-run, granting no command rule | ADR-0011, ADR-0024 |
| D-26 | §14 "config.yaml — choix humains versionnés" | The versioned project file is fully honoured for everything that tightens or is neutral; keys that **loosen** security (sandbox level, API billing, command allow rules, checks/provision argv, unattended approvals, …) take effect only with the local user's consent (user config, CLI flag, or a trust-on-first-use record) — spec 10.1 "jamais activé automatiquement", spec 23 "prompt injection dans le repository" | ADR-0026 |

---

## 12. Risks, assumptions, decisions needing the human

### 12.1 Top risks and what contains them

| Risk | Containment |
|---|---|
| Contract-first front-loads design: a wrong Wave-0 type stalls many units | contracts are listed here in near-final form; complete conformance suites + `MemoryStateStore` + fake brain in W0; two walking skeletons in W1; rule 7 amendment path |
| Pi's SDK construction surface breaks again (it did in 0.80.8 and 0.84.0) | exact pin + `overrides`; Pi imports confined to `runtime-pi/src/child/**`; permanent tripwires; `pi-latest` scheduled job; the executed `runRpcMode` fallback |
| ~200 MB RSS and ~330 ms start per brain | `budgets.concurrency` default 3; `doctor` warns on low memory; optional bundle load (A-4); the accepted price of isolation, env filtering and pinning |
| Default `native` refuses to run on Linux without a usable `bwrap` (Ubuntu 24.04 AppArmor userns) | W0 probe P3 with a pre-agreed rule; exact `doctor` remediation; `best-effort` is one recorded flag away; fake-runtime CI is unaffected |
| `in-doubt` effects need a human or agent decision | only `at-most-once` agent commands can be in doubt; a checkpoint commit precedes each; surfaced in `ResumeReport`, note and `status`; never silently re-run |
| Two declarations of agent-level events (rule C4) drift apart | one total mapper with `satisfies`; a unit test enumerates both unions |
| macOS `sandbox-exec` is deprecated | capability probe + `doctor`; the brain sandbox is `os-if-available`; the executor's `native` requirement fails loudly, never silently |
| A deny-default executor profile breaks real toolchains (missing mach service, a tool that needs `/run`) | A-9; the escape self-test and the fixture's real checks run in the `security` CI job on both OSes; `best-effort` still uses the partial backend; the profile is a golden file, so every widening is reviewed |
| The first-run trust prompt annoys users or blocks CI | it fires only for *loosening* keys and only when their hash changes; CI images pass `--trust-project-config` or carry a user-scope config; tightening never asks (ADR-0026) |
| Scope (16 packages, L1, HMAC, ledger) vs a V3.0 deadline | everything Pi-, L1- and HMAC-specific is off the critical path (leaf units); the "deliberately not built" list of §9; green state G2 needs none of them |

### 12.2 Assumptions still to be pinned (owner: U0.P probes / W1 tripwires)

| # | Assumption | Test that pins it | If false |
|---|---|---|---|
| A-1 | A wrapper assigned to `session.agent.streamFunction` after `createAgentSession` and before the first `prompt()` is used for every request of the run, continuation runs included | tripwire "model-boundary pause parks before request 2; wrapper call count == `model.requested` count" | capabilities stay `partial`; pause = stop-after-turn; budgets counted parent-side |
| A-2 | The Node IPC fd survives `bwrap`; `bwrap` is usable on current Ubuntu runners | probe P3 | fd 3/4 framing for the brain; documented sysctl remediation; brain sandbox `process` on Linux |
| A-3 | The real `openai-codex` provider works offline with a dummy OAuth credential + injected `fetch` | probe P2 | header/quota tests run on recorded fixtures only |
| A-4 | Loading Pi from `dist/bundle/index.js` is safe for OAuth refresh/login | optional tripwire behind `runtime.pi.loadFrom: bundle` | the option stays off |
| A-5 | `ModelRuntime.create({ authPath })` takes Pi's cross-process file lock on refresh exactly like the CLI | probe P4 | serialise refresh in the parent (one auth child at a time) |
| A-6 | `constrainedSampling: { strict: 'prefer' }` degrades silently on providers that cannot honour it | live smoke | drop the option; host validation already authoritative |
| A-7 | Real Codex 401/429/usage-limit texts and header names match the classifier table | live smoke records fixtures | table amended from fixtures; `quotaReporting` stays `partial` |
| A-8 | Pi can carry `task` and the continuation `note` as two user messages in one prompt (pi-agent-core `Agent.prompt(AgentMessage[])` exists; `AgentSession.prompt(text)` takes one text) | tripwire `tw-continuation-note` | one user message with the fixed separator line; conformance rule 12 holds either way (it asserts order and byte-identical spans, not message count) |
| A-9 | The deny-default Seatbelt profile with the minimal `mach-lookup` list runs `node`, `pnpm`, `git`, `tsc` and `vitest` unmodified | S-25..S-28 on macOS through real check commands of the `ts-monorepo` fixture | widen the mach-lookup list from the denial log (golden file updated in the same PR); never fall back to `(allow default)` |

### 12.3 Decisions that need the human (none blocks Wave 0)

1. **Node floor** `^24.16.0 || >=26.1.0` narrows spec 26 (D-2).
2. **Default `sandbox.require: native`** for real-model runs: safer, but Linux users without a usable `bwrap` must opt into `best-effort` (D-8).
3. **Anthropic-via-Pi**: keep the metered triple opt-in (this design) or make it non-selectable in V3.0 (D-5).
4. **No runtime-adopt flag** on resume (D-14): a run interrupted across an in-place upgrade must be cancelled or the old version reinstalled.
5. **External worktree root by default** (`~/.cohorte/worktrees`) and per-surface slot reuse (D-10, D-11).
6. **Rollback checkpoints between waves**: scratchpad patch + tarball (default) or lead-only commits on `feat/v3-rewrite`.
7. **The real Cohorte-on-Cohorte run and the live smoke** spend the maintainer's ChatGPT subscription quota; both are opt-in release gates.
8. **Project-config trust** (ADR-0026, D-26): the repository's config file cannot loosen security without a local consent; the first run on a
   project that sets such keys asks once.
9. **No account label on Pi** (D-24): spec 10.1's "compte/tenant non secret" stays unmet for Pi 0.85.1 rather than reading a token-bearing credential.

### 12.4 Design-critique findings applied differently from the proposed fix (and why)

All 36 findings of the adversarial critique were accepted; PLAN §8.4 maps each to the units that deliver it. Six were applied with a
different mechanism than the one proposed, or with one of two offered options. The rejected halves are recorded here so they are not
re-opened without new evidence.

| Finding | Proposed | Applied instead | Why |
|---|---|---|---|
| Pi identifiers make gate G0 red | (a) scope the scan to protocol schemas, or (b) rename the config keys to engine-neutral names | **(a)** | R10 and spec 17 are about the protocol frontier. A project's config legitimately names the engine it configures, and "via Pi" is the information the provider-terms caveat needs; `meteredOAuth.anthropic` would hide which harness carries the OAuth session (ADR-0005 item 7) |
| `accountLabel` cannot be populated on Pi 0.85.1 | (a) a deviation, or (b) one audited file allowed to call `readStoredCredential()` and return only `accountId` | **(a)**, D-24 | (b) puts a token-bearing object into Cohorte's address space, and an exception into a rule that is otherwise checkable by `grep`, to display a label |
| In-repo worktree root is legal but unusable | protected set = `<project>/.cohorte/**` minus the configured root, or reject the option | **reject** (`configuration/worktree-root-protected`), D-10 | the protected-root rule is non-overridable by design; carving a configurable hole into it, for a location that also re-introduces upward resolution of `node_modules`/`tsconfig` into the user's checkout, is not worth it in V3.0. ADR-0021 "Revisit" keeps the other option |
| `tools` names `persistence` types; `tools` needs glob matching | move the effect shapes to `base`; add `picomatch` to `tools` | a **type-only edge** `tools → persistence/contract`; a **`GlobMatcher` contract** in `security` | `EffectRecord` is a store record, not leaf vocabulary; and a second `picomatch` configuration is exactly how deny-set semantics would drift between the gate and the tools that filter their output |
| Approved call after a park | replay by the host if the binding matches; "open a new ask only if the binding changed" | replay by the host if the binding matches; if it changed: **`superseded`, nothing executes, the note says so; a re-issued call opens the new ask** | an ask needs a live requester and a preview of a call somebody still wants; opening one on behalf of a dead incarnation would recreate the state the finding set out to remove (a decision nobody is waiting for) |
| Separation of identities | "the host overwrites `actor.kind` to `client` unless the transport is `cli` with a TTY" | the **CLI** stamps `human` only on a TTY without `--yes`; the host never upgrades a claim and downgrades non-`cli` transports | the host is a detached process: it cannot observe the controller's TTY. `kind` stays what it honestly is — a claim among key holders (2.6.7) |
