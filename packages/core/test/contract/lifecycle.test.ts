// DESIGN 2.5.4 — the agent lifecycle table and `reincarnate`. The four REINCARNATION edges
// (`spawning|running|waiting|paused -> spawning`) are the only way to reach `spawning` without going through
// `failed -> retrying|escalated`, they bump `incarnation` and they NEVER touch `attempt`.

import type { AgentId, IsoInstant, PhaseRunId, RunId } from '@cohorte/base';
import { CohorteError } from '@cohorte/base';
import type { AgentRecord } from '@cohorte/persistence/contract';
import { AGENT_STATES, type AgentState } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import { AGENT_TRANSITIONS, type ReincarnateCause, reincarnate } from '../../src/agents/lifecycle.ts';

const REINCARNATE_SOURCES: readonly AgentState[] = ['spawning', 'running', 'waiting', 'paused'];
const CAUSES: readonly ReincarnateCause[] = ['recovery', 'park', 'pause-expiry'];

const agentAt = (state: AgentState, over: Partial<AgentRecord> = {}): AgentRecord => ({
  runId: 'run_01J0000000000000000000000A' as RunId,
  agentId: 'agt_implementer_main' as AgentId,
  phaseRunId: 'phr_01J0000000000000000000000B' as PhaseRunId,
  role: 'implementer',
  label: 'implementer/main',
  state,
  attempt: 2,
  incarnation: 1,
  maxAttempts: 3,
  maxIncarnations: 5,
  model: { provider: 'anthropic', model: 'test-model' },
  usage: {},
  createdAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
  updatedAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
  ...over,
});

describe('AGENT_TRANSITIONS', () => {
  it('is total over AgentState, as keys and as targets', () => {
    expect(Object.keys(AGENT_TRANSITIONS).sort()).toEqual([...AGENT_STATES].sort());
    for (const state of AGENT_STATES) {
      const targets: readonly AgentState[] = AGENT_TRANSITIONS[state];
      expect(targets).toBeDefined();
      for (const target of targets) expect(AGENT_STATES).toContain(target);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it('`completed` and `cancelled` are terminal, and every other state can still be cancelled', () => {
    expect(AGENT_TRANSITIONS.completed).toEqual([]);
    expect(AGENT_TRANSITIONS.cancelled).toEqual([]);
    for (const state of AGENT_STATES) {
      if (state === 'completed' || state === 'cancelled') continue;
      expect(AGENT_TRANSITIONS[state]).toContain('cancelled');
    }
  });

  it('exactly four states carry a REINCARNATION edge to `spawning`', () => {
    const withEdge = AGENT_STATES.filter(
      (state) => (AGENT_TRANSITIONS[state] as readonly AgentState[]).includes('spawning') && state !== 'planned',
    );
    expect([...withEdge].sort()).toEqual([...REINCARNATE_SOURCES, 'escalated', 'retrying'].sort());
  });
});

describe('reincarnate', () => {
  for (const state of REINCARNATE_SOURCES) {
    for (const cause of CAUSES) {
      it(`${state} + ${cause}: bumps incarnation, leaves attempt untouched`, () => {
        const before = agentAt(state);
        const after = reincarnate(before, cause);
        expect(after.state).toBe('spawning');
        expect(after.incarnation).toBe(before.incarnation + 1);
        expect(after.attempt).toBe(before.attempt);
        // the record is rebuilt, never mutated in place
        expect(before.state).toBe(state);
        expect(before.incarnation).toBe(1);
      });
    }
  }

  for (const state of AGENT_STATES) {
    if (REINCARNATE_SOURCES.includes(state)) continue;
    it(`throws for an illegal source (${state})`, () => {
      expect(() => reincarnate(agentAt(state), 'recovery')).toThrow(TypeError);
    });
  }

  it('the last legal incarnation still succeeds (incarnation === maxIncarnations - 1)', () => {
    const after = reincarnate(agentAt('running', { incarnation: 4, maxIncarnations: 5 }), 'recovery');
    expect(after.state).toBe('spawning');
    expect(after.incarnation).toBe(5);
  });

  it('throws `budget/incarnations` when the limit is reached (incarnation === maxIncarnations)', () => {
    const agent = agentAt('running', { incarnation: 5, maxIncarnations: 5 });
    expect(() => reincarnate(agent, 'park')).toThrow(CohorteError);
    try {
      reincarnate(agent, 'park');
      expect.unreachable('reincarnate must throw past maxIncarnations');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(CohorteError);
      expect((thrown as CohorteError).info.code).toBe('budget/incarnations');
      expect((thrown as CohorteError).info.class).toBe('budget');
    }
  });

  it('never consumes an attempt, even at the limit', () => {
    const agent = agentAt('waiting', { incarnation: 5, maxIncarnations: 5, attempt: 2 });
    expect(() => reincarnate(agent, 'pause-expiry')).toThrow();
    expect(agent.attempt).toBe(2);
  });
});
