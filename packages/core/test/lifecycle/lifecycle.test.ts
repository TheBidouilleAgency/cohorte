import type { AgentId, IsoInstant, PhaseRunId, RunId } from '@cohorte/base';
import type { AgentRecord } from '@cohorte/persistence/contract';
import { describe, expect, test } from 'vitest';
import { reincarnate } from '../../src/agents/lifecycle.ts';

const agent = (state: AgentRecord['state']): AgentRecord => ({
  runId: 'run_01J0000000000000000000000A' as RunId,
  agentId: 'agt_implementer_main' as AgentId,
  phaseRunId: 'phr_01J0000000000000000000000A' as PhaseRunId,
  role: 'implementer',
  label: 'implementer/main',
  state,
  attempt: 2,
  incarnation: 1,
  maxAttempts: 3,
  maxIncarnations: 5,
  model: { provider: 'fake', model: 'test' },
  usage: {},
  createdAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
  updatedAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
});

describe('lifecycle reincarnation', () => {
  test('recovery increments incarnation but not attempt', () => {
    const before = agent('running');
    const after = reincarnate(before, 'recovery');
    expect(after).toMatchObject({ state: 'spawning', incarnation: 2, attempt: 2 });
    expect(before.state).toBe('running');
  });

  test('completed agents cannot be reincarnated', () => {
    expect(() => reincarnate(agent('completed'), 'recovery')).toThrow(TypeError);
  });
});
