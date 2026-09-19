// DESIGN 4.2 / factories.ts's `Projection.evolve` — the pure fold `RunState x DurableEnvelope -> RunState`. Not how
// the live engine keeps `RunTreeRows` (core writes projections explicitly, in the same transaction as the events
// that justify them); this is the SECONDARY reconstruction used for verification / resume audits, so what matters
// here is that folding is well-behaved as a fold: the same sequence of events yields the same final state no matter
// where you cut it and resume, and that only DURABLE events typecheck as input at all.
import type { AgentId, EventId, IsoInstant, PhaseRunId, RunId, Sha256, SpecId, ToolCallId } from '@cohorte/base';
import type { DurableEventType, Envelope, PipelineState } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import type { RunState } from '../../src/contract/types.ts';
import { evolve } from '../../src/state/evolve.ts';
import { initialRunState } from '../../src/state/initial-run-state.ts';

const RUN_ID = 'run_00000000000000000000000009' as RunId;
const AGENT_ID = 'agt_implementer_main' as AgentId;
const PHASE_RUN_ID = 'phs_PREFLIGHT_1' as PhaseRunId;

function baseState(): RunState {
  return initialRunState({
    runId: RUN_ID,
    profile: 'feature',
    tableVersion: 1,
    specId: 'spc_00000000000000000000000001' as SpecId,
    specSha256: 'a'.repeat(64) as Sha256,
    title: 'evolve fixture',
    pinnedInstallDir: '/tmp/u0.09-evolve-fixture',
    baseBranch: 'main',
    cohorteVersion: '3.0.0-test',
    schemaVersion: 1,
    startedAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
  });
}

/** Fills the `EnvelopeBase` boilerplate every fixture envelope shares; the payload is the only thing a test case
 * actually cares about. */
function env<T extends DurableEventType>(seq: number, type: T, payload: Envelope<T>['payload']): Envelope<T> {
  return {
    protocolVersion: '1.0',
    eventId: `evt_${seq.toString(16).padStart(32, '0')}` as EventId,
    sequence: seq,
    sub: 0,
    durability: 'durable',
    timestamp: `2026-01-01T00:${String(seq).padStart(2, '0')}:00.000Z` as IsoInstant,
    runId: RUN_ID,
    type,
    source: 'cohorte',
    summary: `${type} #${seq}`,
    severity: 'info',
    payload,
    redactions: [],
  } as Envelope<T>;
}

const HUMAN_ACTOR = { kind: 'human', id: 'u_test', transport: 'cli' } as const;
const SYSTEM_ACTOR = { kind: 'system', id: 'cohorte', transport: 'cli' } as const;

const EVENTS: readonly Envelope<DurableEventType>[] = [
  env(1, 'run.state.changed', {
    transitionId: 'trn_1',
    defId: 'T04',
    tableVersion: 1,
    from: 'IDLE',
    to: 'PREFLIGHT',
    reason: 'start',
    actor: HUMAN_ACTOR,
    guards: [],
    idempotencyKey: 'k1',
  }),
  env(2, 'phase.started', {
    phase: { phaseRunId: PHASE_RUN_ID, state: 'PREFLIGHT', iteration: 1 },
    contractId: 'preflight',
    contractVersion: 1,
    planned: [],
    budget: {},
  }),
  env(3, 'agent.declared', {
    agent: { agentId: AGENT_ID, role: 'implementer', incarnation: 1, attempt: 1 },
    owner: 'implementer',
    ownedPaths: ['packages/core/**'],
    grantsDigest: 'b'.repeat(64) as Sha256,
    requestedModel: { provider: 'anthropic', model: 'test-model' },
    thinking: 'medium',
    routingReason: 'default tier',
    budget: {},
  }),
  env(4, 'agent.spawned', {
    agent: { agentId: AGENT_ID, role: 'implementer', incarnation: 1, attempt: 1 },
    worktree: { slot: 'slot-1', path: '/tmp/slot-1', branch: 'cohorte/slot-1', baseSha: 'deadbeef' },
    tools: ['read_file'],
    systemPromptSha256: 'c'.repeat(64) as Sha256,
    effectiveSystemPromptSha256: 'c'.repeat(64) as Sha256,
    authMode: 'subscription',
    isolation: { level: 'L0-process', backend: 'none', filesystem: 'advisory', network: 'unenforced' },
    runtimeRef: { runtime: 'pi', version: '0.85.1', sessionId: 'sess_1', transcriptRef: 'trn_ref_1' },
  }),
  env(5, 'phase.completed', {
    phase: { phaseRunId: PHASE_RUN_ID, state: 'PREFLIGHT', iteration: 1 },
    outcome: 'passed',
    outputs: [],
    checks: [],
    durationMs: 42,
  }),
  env(6, 'run.state.changed', {
    transitionId: 'trn_2',
    defId: 'T05',
    tableVersion: 1,
    from: 'PREFLIGHT',
    to: 'BUILD',
    reason: 'ready',
    actor: SYSTEM_ACTOR,
    guards: [],
    idempotencyKey: 'k2',
  }),
  env(7, 'budget.updated', {
    scope: { level: 'run', id: RUN_ID },
    consumed: { tokens: 100 },
    limit: { tokens: 100000 },
  }),
  env(8, 'run.host.attached', {
    hostId: 'host-1',
    pid: 4242,
    cohorteVersion: '3.0.0-test',
    fencingToken: 1,
    takeover: false,
  }),
  env(9, 'run.host.detached', { hostId: 'host-1', cause: 'shutdown-command' }),
];

/** Deeply frozen input turns any in-place write inside `evolve` into a `TypeError` (ESM is strict mode), instead of a
 * silent pass — without it, "fold in two pieces equals fold in one" is a tautology of `Array.prototype.reduce` for any
 * PURE function and can only ever catch mutation. Freezing the fold's every intermediate is what makes it a test. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

const foldFrozen = (state: RunState, envelope: Envelope<DurableEventType>): RunState =>
  deepFreeze(evolve(state, envelope));

describe('evolve — fold(events) is identical whatever the snapshot cut', () => {
  it('resuming from a SERIALISED snapshot at any cut point reaches the same state, and evolve never mutates its input', () => {
    const whole = EVENTS.reduce(foldFrozen, deepFreeze(baseState()));
    for (let cut = 1; cut < EVENTS.length; cut += 1) {
      const head = EVENTS.slice(0, cut).reduce(foldFrozen, deepFreeze(baseState()));
      // a REAL snapshot cut (the property the plan asks for): the state is round-tripped through serialisation, as a
      // persisted snapshot is, before the tail is folded onto it — not merely handed on as the same live object.
      const restored = deepFreeze(structuredClone(head));
      expect(restored, `cut at ${cut}: the snapshot survives serialisation`).toEqual(head);
      const resumed = EVENTS.slice(cut).reduce(foldFrozen, restored);
      expect(resumed, `cut at ${cut}`).toEqual(whole);
    }
  });

  it('is otherwise deterministic: folding the same stream twice from the same start yields equal states', () => {
    const a = EVENTS.reduce(foldFrozen, deepFreeze(baseState()));
    const b = EVENTS.reduce(foldFrozen, deepFreeze(baseState()));
    expect(a).toEqual(b);
  });
});

describe('evolve — per-event projection (spot checks)', () => {
  it('run.state.changed advances run.state, run.lastSequence and run.updatedAt', () => {
    const after = evolve(baseState(), EVENTS[0] as Envelope<DurableEventType>);
    expect(after.run.state).toBe('PREFLIGHT');
    expect(after.run.lastSequence).toBe(1);
    expect(after.run.updatedAt).toBe(EVENTS[0]?.timestamp);
  });

  /** `version` and `lastHash` are STORE-assigned per TRANSACTION (`RunRecord`'s own comment: "store-assigned by
   * `appendEvents`, like `lastHash` and `version`"), and `appendEvents` bumps `version` ONCE per call whatever the
   * batch size — while DESIGN 4.2's E5/E8 transactions routinely append several events at once. A per-EVENT fold
   * cannot know where a transaction ends (`envelope.sub` is 0 for every durable event), so this reconstruction
   * leaves both fields alone instead of fabricating a value that could never equal the stored record. */
  it('leaves the store-assigned run.version / run.lastHash untouched, whatever the batch shape', () => {
    const after = EVENTS.reduce(evolve, baseState());
    expect(after.run.version).toBe(baseState().run.version);
    expect(after.run.lastHash).toBe(baseState().run.lastHash);
    expect(after.run.lastSequence).toBe(EVENTS.length); // the one bookkeeping field that IS per-event and gapless
  });

  it('phase.started/completed upsert ONE phase row, keyed by phaseRunId', () => {
    const after = EVENTS.slice(0, 5).reduce(evolve, baseState());
    expect(after.phases).toHaveLength(1);
    expect(after.phases[0]).toMatchObject({ phaseRunId: PHASE_RUN_ID, status: 'completed', outcome: 'passed' });
  });

  it('agent.declared then agent.spawned upsert ONE agent row, keyed by agentId', () => {
    const after = EVENTS.slice(0, 4).reduce(evolve, baseState());
    expect(after.agents).toHaveLength(1);
    expect(after.agents[0]).toMatchObject({ agentId: AGENT_ID, state: 'declared', slot: 'slot-1' });
  });

  it('run.host.attached sets hostId/hostPid; run.host.detached clears them (never leaves an explicit undefined)', () => {
    const attached = EVENTS.slice(0, 8).reduce(evolve, baseState());
    expect(attached.run.hostId).toBe('host-1');
    expect(attached.run.hostPid).toBe(4242);

    const detached = evolve(attached, EVENTS[8] as Envelope<DurableEventType>);
    expect(detached.run.hostId).toBeUndefined();
    expect('hostId' in detached.run).toBe(false);
    expect('hostPid' in detached.run).toBe(false);
    expect('hostStartToken' in detached.run).toBe(false);
  });

  it('a resume back into an active state CLEARS a stale resumeTo/stop from an earlier suspend', () => {
    const paused = evolve(
      baseState(),
      env(1, 'run.state.changed', {
        transitionId: 'trn_pause',
        defId: 'T20',
        tableVersion: 1,
        from: 'BUILD',
        to: 'PAUSED',
        reason: 'pause-command',
        actor: HUMAN_ACTOR,
        guards: [],
        idempotencyKey: 'kp',
        resumeTo: 'BUILD',
      }),
    );
    expect(paused.run.resumeTo).toBe('BUILD');

    const resumed = evolve(
      paused,
      env(2, 'run.state.changed', {
        transitionId: 'trn_resume',
        defId: 'T30',
        tableVersion: 1,
        from: 'PAUSED',
        to: 'BUILD',
        reason: 'resume-command',
        actor: SYSTEM_ACTOR,
        guards: [],
        idempotencyKey: 'kr',
      }),
    );
    expect(resumed.run.state).toBe('BUILD' satisfies PipelineState);
    expect(resumed.run.resumeTo).toBeUndefined();
    expect('resumeTo' in resumed.run).toBe(false);
  });
});

describe('evolve — type-level: only a DURABLE event typechecks as input', () => {
  it('an ephemeral envelope (e.g. tool.progress) is rejected at compile time', () => {
    const state = baseState();
    const ephemeral = {
      protocolVersion: '1.0',
      eventId: 'evt_00000000000000000000000000' as EventId,
      sequence: 1,
      sub: 1,
      durability: 'ephemeral',
      timestamp: '2026-01-01T00:00:00.000Z' as IsoInstant,
      runId: RUN_ID,
      type: 'tool.progress',
      source: 'runtime',
      summary: 'progress',
      severity: 'progress',
      payload: { toolCallId: 'tc_1' as ToolCallId },
      redactions: [],
    } as Envelope<'tool.progress'>;
    // Also refused at RUNTIME by `evolve`'s own totality switch (`assertNever`'s default case) — belt and
    // suspenders: a caller that defeats the type system some other way still cannot fold an ephemeral event.
    expect(() => {
      // @ts-expect-error evolve only accepts Envelope<DurableEventType>; 'tool.progress' is ephemeral (E, 2.3.3).
      evolve(state, ephemeral);
    }).toThrow(TypeError);
  });
});
