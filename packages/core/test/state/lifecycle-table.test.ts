// DESIGN 2.5.4 — the agent lifecycle table, through THIS unit's own deliverable entry point
// (`packages/core/src/agents/lifecycle-table.ts`). U0.08 already ships the verbatim implementation at
// `agents/lifecycle.ts`; `lifecycle-table.ts` re-exports it rather than duplicating a second source of truth (see
// that file's own header) — these tests prove the totality DESIGN 2.5.4 and this unit's "tests first" list require
// THROUGH the re-export, so a future accidental de-sync (the re-export silently pointing at something else) fails
// here, in this unit's own owned test path.
import type { AgentId, IsoInstant, PhaseRunId, RunId } from '@cohorte/base';
import { CohorteError } from '@cohorte/base';
import type { AgentRecord } from '@cohorte/persistence/contract';
import { AGENT_STATES, type AgentState } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TRANSITIONS,
  ATTEMPT_CONSUMING_EDGES,
  attemptConsumed,
  type ReincarnateCause,
  reincarnate,
} from '../../src/agents/lifecycle-table.ts';

const REINCARNATE_SOURCES: readonly AgentState[] = ['spawning', 'running', 'waiting', 'paused'];
const CAUSES: readonly ReincarnateCause[] = ['recovery', 'park', 'pause-expiry'];

const agentAt = (state: AgentState, over: Partial<AgentRecord> = {}): AgentRecord => ({
  runId: 'run_00000000000000000000000003' as RunId,
  agentId: 'agt_implementer_main' as AgentId,
  phaseRunId: 'phs_BUILD_1' as PhaseRunId,
  role: 'implementer',
  label: 'implementer/main',
  state,
  attempt: 1,
  incarnation: 1,
  maxAttempts: 3,
  maxIncarnations: 5,
  model: { provider: 'anthropic', model: 'test-model' },
  usage: {},
  createdAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
  updatedAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
  ...over,
});

describe('AGENT_TRANSITIONS (via agents/lifecycle-table.ts)', () => {
  it('is total over AgentState, as keys and as targets', () => {
    expect(Object.keys(AGENT_TRANSITIONS).sort()).toEqual([...AGENT_STATES].sort());
    for (const state of AGENT_STATES) {
      const targets: readonly AgentState[] = AGENT_TRANSITIONS[state];
      for (const target of targets) expect(AGENT_STATES).toContain(target);
    }
  });

  it('`completed` and `cancelled` are terminal', () => {
    expect(AGENT_TRANSITIONS.completed).toEqual([]);
    expect(AGENT_TRANSITIONS.cancelled).toEqual([]);
  });

  it('lifecycle totality: from every non-terminal, already-has-a-child state, a legal path to `spawning` exists whose ONLY possible attempt increment is the hop INTO retrying/escalated — never the hop landing on `spawning` itself', () => {
    const targetsOf = (state: AgentState): readonly AgentState[] => AGENT_TRANSITIONS[state] as readonly AgentState[];
    const noChildYet = new Set<AgentState>(['declared', 'planned']);
    for (const state of AGENT_STATES) {
      if (state === 'completed' || state === 'cancelled' || noChildYet.has(state)) continue;
      if (targetsOf(state).includes('spawning')) {
        // a direct edge: the four REINCARNATE_SOURCES (proved by `reincarnate` itself below), or `retrying` /
        // `escalated` — whose OWN attempt increment already happened on the edge INTO them, not on this one.
        continue;
      }
      // the only non-terminal, already-has-a-child state left without a direct edge is `failed`: it reaches
      // `spawning` in exactly one hop, through `retrying` or `escalated`, and THAT hop is where `attempt` moves.
      expect(state, `${state} has neither a direct edge to spawning nor is it "failed"`).toBe('failed');
      const oneHopTargets = targetsOf(state).filter((next) => targetsOf(next).includes('spawning'));
      expect(oneHopTargets.length, `${state}: no one-hop path to spawning`).toBeGreaterThan(0);
    }
  });

  it('exactly seven edges land on `spawning`: the four REINCARNATE_SOURCES, the initial `planned -> spawning` spawn, and `retrying`/`escalated` (whose own attempt increment already happened on the edge INTO them)', () => {
    const edgesIntoSpawning = AGENT_STATES.filter((state) =>
      (AGENT_TRANSITIONS[state] as readonly AgentState[]).includes('spawning'),
    );
    expect([...edgesIntoSpawning].sort()).toEqual([...REINCARNATE_SOURCES, 'planned', 'escalated', 'retrying'].sort());
  });
});

describe('the attempt rule, as data (DESIGN 2.5.4 / 2.3.3 `attemptConsumed`)', () => {
  it('ATTEMPT_CONSUMING_EDGES is exactly `failed -> retrying` and `failed -> escalated`', () => {
    expect(ATTEMPT_CONSUMING_EDGES.map(([from, to]) => `${from} -> ${to}`)).toEqual([
      'failed -> retrying',
      'failed -> escalated',
    ]);
    for (const [from, to] of ATTEMPT_CONSUMING_EDGES) {
      expect(AGENT_TRANSITIONS[from] as readonly AgentState[], `${from} -> ${to} is a real edge`).toContain(to);
    }
  });

  it('walking EVERY edge of AGENT_TRANSITIONS: those two consume an attempt, nothing else does', () => {
    const consuming: string[] = [];
    for (const from of AGENT_STATES) {
      for (const to of AGENT_TRANSITIONS[from] as readonly AgentState[]) {
        if (attemptConsumed(from, to)) consuming.push(`${from} -> ${to}`);
      }
    }
    expect([...consuming].sort()).toEqual(['failed -> escalated', 'failed -> retrying']);
  });

  it('is total and false everywhere else, edge or not, over the whole AgentState x AgentState square', () => {
    for (const from of AGENT_STATES) {
      for (const to of AGENT_STATES) {
        const expected = from === 'failed' && (to === 'retrying' || to === 'escalated');
        expect(attemptConsumed(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('no edge that LANDS on `spawning` consumes an attempt — the four reincarnations, `planned`, `retrying`, `escalated`', () => {
    for (const from of [...REINCARNATE_SOURCES, 'planned', 'retrying', 'escalated'] as readonly AgentState[]) {
      expect(attemptConsumed(from, 'spawning'), `${from} -> spawning`).toBe(false);
    }
  });
});

describe('reincarnate (via agents/lifecycle-table.ts)', () => {
  for (const state of REINCARNATE_SOURCES) {
    for (const cause of CAUSES) {
      it(`${state} + ${cause}: bumps incarnation, leaves attempt untouched`, () => {
        const before = agentAt(state, { attempt: 2 });
        const after = reincarnate(before, cause);
        expect(after.state).toBe('spawning');
        expect(after.incarnation).toBe(before.incarnation + 1);
        expect(after.attempt).toBe(before.attempt);
      });
    }
  }

  it('throws for an illegal source state (e.g. `declared`)', () => {
    expect(() => reincarnate(agentAt('declared'), 'recovery')).toThrow();
  });

  it('a `completed` agent is never re-spawned', () => {
    expect(() => reincarnate(agentAt('completed'), 'recovery')).toThrow();
  });

  it('throws `budget/incarnations` past the limit, and never bumps attempt getting there', () => {
    const agent = agentAt('running', { incarnation: 5, maxIncarnations: 5, attempt: 2 });
    expect(() => reincarnate(agent, 'park')).toThrow(CohorteError);
    expect(agent.attempt).toBe(2);
  });
});
