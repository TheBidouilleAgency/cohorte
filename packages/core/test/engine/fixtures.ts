// Toy fixtures for the engine's own tests. Every port `RunEngineDeps` needs whose real implementation is a Wave-1
// sibling (`guards`, `factCollector`, `transitionEffects`, `checkGlobalStops`, `authenticator`, `events`, `leases`,
// `resume`, `phases`) is faked HERE, never imported from a sibling area (PLAN §3 rule 4 — "this holds for test
// files too"). `store`, `clock`, `ids`, `redactor` come from `@cohorte/testkit` (foundation + `store-factory`,
// explicitly allowed in any wave).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock, IdSource, PhaseRunId, RunId } from '@cohorte/base';
import type {
  DurableEnvelope,
  LeaseToken,
  LockOwner,
  LockRequest,
  StateStore,
  StoreTx,
} from '@cohorte/persistence/contract';
import type {
  ActivePipelineState,
  Actor,
  CommandEnvelope,
  CommandType,
  PipelineProfile,
  StopRecord,
} from '@cohorte/protocol';
import { canonicalCommandBody, PROTOCOL_VERSION } from '@cohorte/protocol';
import { fakeRedactor } from '@cohorte/testkit/fake-redactor';
import type { FaultInjector as TestkitFaultInjector } from '@cohorte/testkit/fault-injector';
import { FixedClock } from '@cohorte/testkit/fixed-clock';
import { SeqIds } from '@cohorte/testkit/seq-ids';
import { makeStore } from '@cohorte/testkit/store-factory';
import { GUARD_IDS } from '../../src/contract/ids.ts';
import type { EventWriter, LeaseManager, Resumer } from '../../src/contract/internal.ts';
import type {
  CommandAuthenticator,
  FactCollector,
  GuardRegistry,
  TransitionEffectRunner,
} from '../../src/contract/ports.ts';
import type {
  EventDraftInput,
  GlobalFacts,
  HostContext,
  LoopPolicy,
  PhaseOutcome,
  PhaseRunContext,
  RunState,
  TransitionDef,
  TransitionTable,
} from '../../src/contract/types.ts';
import type { FaultInjector as CoreFaultInjector, Crashpoint } from '../../src/durability/crashpoints.ts';
import type { RunEngineDeps, TableLookup } from '../../src/engine/deps.ts';
import { hostComputedColumnsForStart } from '../../src/engine/inbox.ts';
import { makePhaseRunId } from '../../src/engine/transitions.ts';
import { FEATURE_V1 } from '../../src/pipeline/tables/index.ts';
import { buildTailRows } from '../../src/pipeline/tables/shared.ts';

/**
 * `@cohorte/testkit`'s `FaultInjector` (`arm`/`hit`, throws `InjectedFault`) and `core/durability/crashpoints.ts`'s
 * own `FaultInjector` port (`shouldFail(point, occurrence): boolean`, frozen `U0.08`) are two different shapes for
 * the same idea; `setFaultInjector` wants the latter. This adapts one to the other: `hit()` does the testkit
 * injector's own arming/counting, and a caught `InjectedFault` becomes `shouldFail`'s `true` — `crashpoint()` then
 * throws its OWN `SimulatedCrash`, not the testkit one.
 */
export function coreFaultInjectorFrom(injector: TestkitFaultInjector): CoreFaultInjector {
  return {
    shouldFail(point: Crashpoint, _occurrence: number): boolean {
      try {
        injector.hit(point);
        return false;
      } catch {
        return true;
      }
    },
  };
}

// ── the toy table (DESIGN's own vocabulary — real `PipelineState`/`TransitionReason`/guard & effect ids — but a
// hand-picked pipeline of ONE active phase, plus the standard T20-T32 tail so pause/cancel/resume/retry/approve/deny
// exercise the same machinery a real table would) ───────────────────────────────────────────────────────────────
export const TOY_START: TransitionDef = {
  id: 'TOY-START',
  from: 'IDLE',
  to: 'BUILD',
  reason: 'start',
  actor: 'either',
  preconditions: [],
  effects: [],
};
export const TOY_BUILT: TransitionDef = {
  id: 'TOY-BUILT',
  from: 'BUILD',
  to: 'COMPLETED',
  reason: 'built',
  actor: 'system',
  preconditions: [],
  effects: [],
};
export const TOY_FAILED: TransitionDef = {
  id: 'TOY-FAILED',
  from: 'BUILD',
  to: 'FAILED',
  reason: 'tests-fail',
  actor: 'system',
  preconditions: [],
  effects: [],
};

export const TOY_TABLE: TransitionTable = {
  profile: 'feature',
  version: 1,
  initial: 'IDLE',
  phases: ['BUILD'],
  rows: [TOY_START, TOY_BUILT, TOY_FAILED, ...buildTailRows()],
};

export function toyResolveTable(profile: string, tableVersion: number): TableLookup {
  return profile === TOY_TABLE.profile && tableVersion === TOY_TABLE.version
    ? { ok: true, table: TOY_TABLE }
    : { ok: false, stop: 'runtime-incompatible' };
}

/** The full `feature@1` table (`U0.09`, frozen) resolved regardless of the run's own (profile, tableVersion) — used
 * by the command-matrix test, which drives `T20`/`T27`/`T30`/… directly by id. */
export function realResolveTable(_profile: string, _tableVersion: number): TableLookup {
  return { ok: true, table: FEATURE_V1 };
}

// ── permissive ports: every guard passes, every fact is quiet, nothing ever stops the run on its own ─────────────
export function permissiveGuards(): GuardRegistry {
  return {
    get: (id) => () => ({ id, ok: true }),
    ids: () => GUARD_IDS,
  };
}

export function factCollectorFor(store: StateStore, runId: RunId): FactCollector {
  return {
    async collect(): Promise<GlobalFacts> {
      const run = await store.getRun(runId);
      return {
        cancelRequested: run?.cancelRequested ?? false,
        pauseRequested: run?.pauseRequested ?? false,
        leaseLost: false,
        pinMismatch: false,
        tableVersionKnown: true,
        securityErrorPending: false,
        deniedCallsByAgent: {},
        unexplainedWorktreeChange: false,
        blockingApprovalPending: false,
        authProbeMatchesExpected: true,
        quotaWindowExhausted: false,
        budgets: { run: {} },
        nowMs: Date.now(),
        startedAtMs: Date.now(),
      };
    },
  };
}

/** DESIGN 2.5.3's ladder, restricted to the two facts this fixture's `factCollectorFor` actually populates — order
 * matches DESIGN ("cancel requested -> cancelled | pause requested -> paused | ..."). */
export function ladderCheckGlobalStops(_run: RunState, facts: GlobalFacts, _policy: LoopPolicy): StopRecord | null {
  if (facts.cancelRequested) return { reason: 'cancelled', detail: 'cancel requested', resumable: false };
  if (facts.pauseRequested) return { reason: 'paused', detail: 'pause requested', resumable: true };
  return null;
}

export const neverStops = (_run: RunState, _facts: GlobalFacts, _policy: LoopPolicy): StopRecord | null => null;

export interface EffectCall {
  id: string;
  runId: string;
}
export function recordingTransitionEffects(): { runner: TransitionEffectRunner; calls: EffectCall[] } {
  const calls: EffectCall[] = [];
  return {
    calls,
    runner: {
      async run(id, ctx) {
        calls.push({ id, runId: ctx.runId });
      },
    },
  };
}

export function noopResumer(): Resumer {
  return {
    async recover() {
      return {
        takeover: false,
        hostId: 'test-host',
        fencingToken: 0,
        locks: { rebuilt: [], conflicts: [] },
        orphans: [],
        worktrees: [],
        effects: [],
        approvalsCarried: [],
        commandsApplied: [],
        inDoubt: [],
        approvedReplays: [],
      };
    },
  };
}

export function fakePhaseExecutor(produce: (ctx: PhaseRunContext) => PhaseOutcome | Promise<PhaseOutcome>): {
  execute: (ctx: PhaseRunContext) => Promise<PhaseOutcome>;
} {
  return { execute: async (ctx) => produce(ctx) };
}

/** Always answers `passed` with no artifacts — enough to drive the toy table's ONE phase to `COMPLETED`. */
export function passingPhaseExecutor(): { execute: (ctx: PhaseRunContext) => Promise<PhaseOutcome> } {
  return fakePhaseExecutor(() => ({ kind: 'passed', output: {}, artifacts: [] }));
}

export function fakeLeaseManager(
  store: StateStore,
  hostId = 'test-host',
  options: { takeover?: boolean } = {},
): LeaseManager {
  return {
    async acquire(scope: { runId: RunId } | 'project', key: string, mode: 'shared' | 'exclusive', ttlMs: number) {
      const owner: LockOwner = { hostId, pid: process.pid, startToken: `seed:${hostId}` };
      if (scope !== 'project') owner.runId = scope.runId;
      const req: LockRequest = { scope: scope === 'project' ? 'project' : 'run', key, mode, owner, ttlMs };
      const result = await store.acquireLock(req);
      if (result.ok) return result.lease;
      // `takeover: true` stands in for a crashed-host recovery a real `Resumer` would perform (DESIGN 4.4): steal
      // the stale lock (fencing + 1) rather than refuse. Off by default: most tests want a genuine conflict to stay
      // a conflict.
      if (options.takeover && result.heldBy[0]) return store.stealLock(req, result.heldBy[0]);
      throw new Error(`fakeLeaseManager: ${req.scope}:${key} is already held`);
    },
    renew: (lease: LeaseToken, ttlMs: number) => store.renewLock(lease.lockId, ttlMs),
    release: (lease: LeaseToken) => store.releaseLock(lease.lockId),
  };
}

/** Real HMAC-SHA256 over the canonical command body — a small, honest stand-in for `U2.02`'s `CommandAuthenticator`
 * (DESIGN 2.6.7 names the exact algorithm; nothing here is a shortcut on the crypto). */
export function fakeAuthenticator(): CommandAuthenticator {
  return {
    scheme: 'hmac-sha256',
    sign: (canonicalBody, key) => createHmac('sha256', key).update(canonicalBody).digest('hex'),
    verify: (canonicalBody, value, key) => {
      const expected = createHmac('sha256', key).update(canonicalBody).digest('hex');
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(value, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    },
    anchor: (runId, atSequence, chainHash, key) =>
      createHmac('sha256', key).update(`${runId}:${atSequence}:${chainHash}`).digest('hex'),
  };
}

export const TEST_PROJECT_KEY = new Uint8Array(32).fill(7);

/** Builds an `EventWriter` without touching `../../src/events/index.ts` (a Wave-1 sibling area): strict-validates
 * nothing extra, just assembles the envelope fields `EventDraftInput` is missing and seals with the test redactor. */
export function fakeEventWriter(ids: IdSource, clock: Clock): EventWriter {
  return {
    append(tx: StoreTx, drafts: EventDraftInput[]): DurableEnvelope[] {
      const runId = tx.run().runId;
      const sealed = drafts.map((draft) => {
        const fields: Record<string, unknown> = {
          protocolVersion: PROTOCOL_VERSION,
          eventId: ids.next<'EventId'>('evt'),
          timestamp: clock.now(),
          runId,
          type: draft.type,
          source: draft.source ?? 'cohorte',
          summary: draft.summary,
          severity: draft.severity ?? 'info',
          payload: draft.payload,
          redactions: [],
        };
        if (draft.phase !== undefined) fields.phase = draft.phase;
        if (draft.agent !== undefined) fields.agent = draft.agent;
        if (draft.causationId !== undefined) fields.causationId = draft.causationId;
        return fakeRedactor().sealJson(fields as never).value;
      });
      return tx.appendEvents(sealed as never);
    },
    ephemeral() {
      /* not exercised by these tests */
    },
  };
}

export interface EngineHarness {
  store: StateStore;
  clock: FixedClock;
  ids: SeqIds;
  runId: RunId;
  host: HostContext;
  deps: RunEngineDeps;
  effectCalls: EffectCall[];
}

export interface HarnessOptions {
  /** A table LOCAL to one test, resolved for every `(profile, tableVersion)` — the short spelling of
   * `resolveTable: () => ({ ok: true, table })`, which still wins when both are given. */
  table?: TransitionTable;
  resolveTable?: (profile: string, tableVersion: number) => TableLookup;
  phases?: { execute: (ctx: PhaseRunContext) => Promise<PhaseOutcome> };
  checkGlobalStops?: (run: RunState, facts: GlobalFacts, policy: LoopPolicy) => StopRecord | null;
  hostId?: string;
  pollIntervalMs?: number;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<EngineHarness> {
  const store = await makeStore();
  const clock = new FixedClock();
  const ids = new SeqIds();
  const runId = ids.next<'RunId'>('run');
  const hostId = options.hostId ?? 'test-host';
  const signal = new AbortController().signal;
  const host: HostContext = {
    hostId,
    pid: process.pid,
    startToken: `seed:${hostId}`,
    cohorteVersion: '3.0.0-test',
    signal,
  };
  const effects = recordingTransitionEffects();
  const factCollector = factCollectorFor(store, runId);
  const localTable = options.table;
  const resolveTable =
    options.resolveTable ?? (localTable ? () => ({ ok: true as const, table: localTable }) : toyResolveTable);

  const deps: RunEngineDeps = {
    store,
    clock,
    ids,
    resume: noopResumer(),
    phases: options.phases ?? passingPhaseExecutor(),
    loopPolicy: {
      maxFixRounds: 5,
      noProgressWindow: 3,
      maxDeniedCallsPerAgent: 5,
      runWallClockMs: 60_000,
      escalation: { sameFailureCount: 2, ladder: [], maxPerRun: 2 },
    },
    guards: permissiveGuards(),
    factCollector,
    transitionEffects: effects.runner,
    checkGlobalStops: options.checkGlobalStops ?? ladderCheckGlobalStops,
    authenticator: fakeAuthenticator(),
    projectKey: TEST_PROJECT_KEY,
    events: fakeEventWriter(ids, clock),
    redactor: fakeRedactor(),
    leases: fakeLeaseManager(store, hostId),
    resolveTable,
    schemaVersion: 1,
    leaseTtlMs: 15_000,
    pollIntervalMs: options.pollIntervalMs ?? 5,
  };

  return { store, clock, ids, runId, host, deps, effectCalls: effects.calls };
}

// The store only REQUIRES the six host-computed columns outside `{IDLE, CANCELLED, FAILED}` (persistence's own
// `STATES_WITHOUT_HOST_COLUMNS`), but this fixture sets them for every non-IDLE state regardless: a FAILED or
// CANCELLED run seeded for a test may still be the SOURCE of a later `*resumeTo` transition landing back on an
// active state, which DOES need them already present (nothing patches them in along the way, on purpose — that is
// real `T04` work, out of this unit's scope, see `hostComputedColumnsForStart`'s own header comment).
const RESUMABLE_STATES: ReadonlySet<string> = new Set([
  'PAUSED',
  'WAITING_APPROVAL',
  'AUTH_REQUIRED',
  'QUOTA_EXCEEDED',
  'FAILED',
  'BLOCKED',
]);

/** `putRun` directly (bypassing `enqueueCommand`'s own atomic pairing — legitimate test setup, not something this
 * unit's OWN loop does) so a test can seed a run at any state it wants — including the persistence-enforced
 * host-computed columns (`HOST_COMPUTED_RUN_KEYS`) any state outside `{IDLE, CANCELLED, FAILED}` requires, and
 * `resumeTo` for any state a `*resumeTo` row (T30/T31/T32) can fire from. */
export async function seedIdleRun(
  harness: EngineHarness,
  overrides: {
    profile?: PipelineProfile;
    tableVersion?: number;
    state?: RunState['run']['state'];
    resumeTo?: RunState['run']['state'];
  } = {},
): Promise<void> {
  const now = harness.clock.now();
  const state = overrides.state ?? 'IDLE';
  const hostColumns = state === 'IDLE' ? {} : hostComputedColumnsForStart();
  const resumeTo = RESUMABLE_STATES.has(state) ? (overrides.resumeTo ?? 'BUILD') : undefined;
  await harness.store.transact('project', null, (tx) => {
    tx.putRun({
      runId: harness.runId,
      profile: overrides.profile ?? 'feature',
      tableVersion: overrides.tableVersion ?? 1,
      specId: 'spc_toy' as never,
      specSha256: '0'.repeat(64) as never,
      title: 'toy run',
      state,
      ...(resumeTo !== undefined ? { resumeTo: resumeTo as never } : {}),
      lastSequence: 0,
      lastHash: '',
      version: 0,
      ...hostColumns,
      pinnedInstallDir: '/tmp/toy',
      baseBranch: 'main',
      cancelRequested: false,
      pauseRequested: false,
      schemaVersion: 1,
      cohorteVersion: '3.0.0-test',
      purgeable: false,
      startedAt: now,
      updatedAt: now,
    });
  });
}

/**
 * Opens the phase row a real run in an ACTIVE state always has: DESIGN 4.2 E5 writes `putPhase(status running)` in
 * the very transaction that enters the phase, so `seedIdleRun(… state: 'BUILD')` alone is a shape no real run ever
 * shows. Takes (and hands back) the run lease for the one seeding transaction, so the engine can acquire it after.
 */
export async function seedOpenPhase(
  harness: EngineHarness,
  state: ActivePipelineState,
  iteration = 1,
): Promise<PhaseRunId> {
  const phaseRunId = makePhaseRunId(state, iteration);
  const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
  try {
    await harness.store.transact({ runId: harness.runId }, lease, (tx) => {
      tx.putPhase({
        runId: harness.runId,
        phaseRunId,
        state,
        iteration,
        status: 'running',
        checks: [],
        startedAt: harness.clock.now(),
      });
    });
  } finally {
    await harness.deps.leases.release(lease);
  }
  return phaseRunId;
}

/** Counts `store.transact` calls, so a test can assert DESIGN 4.2 E1's "per command ONE tx" directly instead of
 * inferring it. Everything else is delegated to the real store unchanged. */
export function countTransactions(store: StateStore): { store: StateStore; count: () => number } {
  let calls = 0;
  const handler: ProxyHandler<StateStore> = {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: never[]) => unknown;
      if (prop === 'transact') {
        return (...args: never[]) => {
          calls += 1;
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  };
  return { store: new Proxy(store, handler), count: () => calls };
}

export function testActor(kind: Actor['kind'] = 'human', transport: Actor['transport'] = 'cli'): Actor {
  return { kind, id: 'tester', transport };
}

/** Builds and signs a `CommandEnvelope` with the harness's own authenticator + project key. */
export function signedCommand<T extends CommandType>(
  harness: EngineHarness,
  type: T,
  payload: CommandEnvelope<T>['payload'],
  extra: { actor?: Actor; commandId?: string; expectedSequence?: number } = {},
): CommandEnvelope<T> {
  const base: Record<string, unknown> = {
    protocolVersion: PROTOCOL_VERSION,
    commandId: extra.commandId ?? harness.ids.next<'CommandId'>('cmd'),
    type,
    runId: harness.runId,
    issuedAt: harness.clock.now(),
    actor: extra.actor ?? testActor(),
    payload,
  };
  if (extra.expectedSequence !== undefined) base.expectedSequence = extra.expectedSequence;
  const body = canonicalCommandBody(base as unknown as CommandEnvelope);
  const value = harness.deps.authenticator.sign(body, harness.deps.projectKey);
  return { ...base, auth: { scheme: harness.deps.authenticator.scheme, value } } as unknown as CommandEnvelope<T>;
}
