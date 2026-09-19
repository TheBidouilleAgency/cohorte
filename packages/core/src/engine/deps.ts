// The RunEngine's own dependency shape.
//
// DEVIATION, LOUD (docs/v3/requests/U1.09.md): the Wave-0 `EngineDeps` (`contract/factories.ts`, frozen, owned by
// U0.08) has exactly six fields (`store`, `clock`, `ids`, `resume`, `phases`, `loopPolicy`) — enough for the typed
// `NotImplemented` stub, not for the real DESIGN 4.2 loop, which also needs the `GuardRegistry` + `FactCollector`
// the deliverable names, a `TransitionEffectRunner`, an injected `checkGlobalStops`, a `CommandAuthenticator` (E1's
// MAC verification), the project key it verifies against, an `EventWriter`, a `Redactor` (checkpoints seal the run
// state before it is stored), and a `LeaseManager` (E0's "renew the run lease"). `contract/factories.ts` is not in
// this unit's `ownedPaths`, so its frozen type cannot be edited here (PLAN §3 rule 7: contracts are read-only after
// G0). Per PLAN's own worked example for exactly this situation (`docs/v3/requests/U0.08.md` R2: "it may also
// choose to move the `Deps` type and the factory into its own area file instead"), `RunEngineDeps` lives HERE,
// additively — every field of the frozen `EngineDeps` is still present, under the same name and type, so a
// composition root that already built one only has to add fields, never rename or reshape what it has. The barrel
// (`packages/core/src/index.ts`, not owned by this unit) still exports `createEngine` unchanged: it re-exports
// whatever `./engine/index.ts` exports today, exactly as it does for `events`/`durability/journal`/`durability/lease`
// once THEIR owning units filled them in (`docs/v3/requests/U0.08.md` R10/R11). Filed as a request so the G1
// integrator can, if it prefers, fold this shape back into `contract/factories.ts`'s `EngineDeps` by the same
// "widen, never reshape" rule R1 already establishes for `EventsDeps`/`JournalDeps`.
import type { Clock, IdSource, Redactor } from '@cohorte/base';
import type { LeaseToken, RunRecord, StateStore } from '@cohorte/persistence/contract';
import type { StopRecord } from '@cohorte/protocol';
import type { EventWriter, LeaseManager, PhaseExecutor, Resumer } from '../contract/internal.ts';
import type { CommandAuthenticator, FactCollector, GuardRegistry, TransitionEffectRunner } from '../contract/ports.ts';
import type { GlobalFacts, LoopPolicy, RunState } from '../contract/types.ts';
import type { TableLookup } from '../pipeline/tables/index.ts';

/** `U0.09`'s own lookup result (`pipeline/tables/index.ts`), re-exported so a composition root can name the shape
 * `RunEngineDeps.resolveTable` returns without reaching past the engine. Declared there, never a second time. */
export type { TableLookup } from '../pipeline/tables/index.ts';

export interface RunEngineDeps {
  // ── the frozen `EngineDeps` (contract/factories.ts), unchanged ──────────────────────────────────────────────
  store: StateStore;
  clock: Clock;
  ids: IdSource;
  resume: Resumer;
  phases: PhaseExecutor;
  loopPolicy: LoopPolicy;

  // ── additive (see file header) ───────────────────────────────────────────────────────────────────────────────
  /** Every guard of `GUARD_IDS`, looked up by id (DESIGN 2.5.1). The real registry is `U2.05`'s. */
  guards: GuardRegistry;
  /** Gathers `GlobalFacts` before guard evaluation (E4) and before `checkGlobalStops` (E2) — one flat shape serves
   * both, so this engine calls it once per iteration and reuses the result for either. */
  factCollector: FactCollector;
  /** Runs one declarative `TransitionEffectId` of a firing row's `effects` column, through the journal. */
  transitionEffects: TransitionEffectRunner;
  /** DESIGN 2.5.3, pure; the real one is `U2.05`'s (checkpoint.ts, guards + FactCollector). */
  checkGlobalStops: (run: RunState, facts: GlobalFacts, policy: LoopPolicy) => StopRecord | null;
  /** DESIGN 2.5.1 "Versioning": `(profile, tableVersion) -> TransitionTable | 'runtime-incompatible'`. Injected,
   * not imported by this file, the same way `checkGlobalStops` is: the REAL one is
   * `../pipeline/tables/index.ts`'s `resolveTable` (a `U0.09`, Wave-0, same-package import a composition root wires
   * trivially); a unit test hands in a lookup over its OWN toy table instead — DESIGN's "toy 2-state table LOCAL to
   * the tests" is unreachable through a hard-coded `resolveTable(run.profile, run.tableVersion)` call, since that
   * always resolves to the real `feature`/`bugfix`/`review` tables. */
  resolveTable: (profile: string, tableVersion: number) => TableLookup;
  /** E1: verifies a command's MAC before anything else touches its payload. The real implementation is `U2.02`'s. */
  authenticator: CommandAuthenticator;
  /** The project key `authenticator.verify` / `.anchor` checks against — resolved once, outside a run, by whoever
   * builds these deps (a `KeyStore` read is out of this unit's scope: DESIGN 2.6.7's key path needs the project's
   * git common dir, which this loop never touches). */
  projectKey: Uint8Array;
  /** Writes durable events (strict-validate, redact, seal, append) — the real one is `U1.08`'s. */
  events: EventWriter;
  /** Seals the `RunState` a checkpoint snapshots before it is stored (DESIGN 0.2 I7: nothing unredacted persists). */
  redactor: Redactor;
  /** E0's "renew the run lease"; also acquires it once at the start of `run()`. */
  leases: LeaseManager;
  /** `StoredSnapshot.schemaVersion` (persistence's own migration counter, opaque here). */
  schemaVersion: number;
  /** Default `DEFAULT_LEASE_TTL_MS` (DESIGN 6.4: TTL 15s). */
  leaseTtlMs?: number;
  /** Lets a composition root bind host-side effects to the currently fenced run lease. */
  onLease?: (lease: LeaseToken | undefined) => void;
  /** How long `run()` sleeps when a pass finds nothing to do (no pending command, no open phase, no stop). Default
   * `DEFAULT_POLL_INTERVAL_MS` (DESIGN 4.7: "the host polls every 250 ms"). */
  pollIntervalMs?: number;
  /** Supplies the durable host-computed columns for an IDLE -> PREFLIGHT start. */
  startColumns?: (run: RunRecord) => Promise<Partial<RunRecord>>;
}

/** DESIGN 6.4. Not imported from `../durability/lease/index.ts` (`U1.08`'s area, a Wave-1 sibling this unit may not
 * depend on, PLAN §3 rule 4) even though it already defines the same constant. */
export const DEFAULT_LEASE_TTL_MS = 15_000;
