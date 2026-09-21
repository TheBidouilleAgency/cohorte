import { describe, expect, it } from 'vitest';
import { createPhaseContracts } from '../../src/phases/contracts/index.ts';

const context = {
  run: {
    run: { runId: 'run_00000000000000000000000000000000' },
    agents: [],
    worktrees: [{ slot: 'frontend' }],
    budgets: [],
  },
  phase: { state: 'BUILD', phaseRunId: 'phs_BUILD_1', iteration: 1 },
  now: '2026-01-01T00:00:00.000Z',
} as never;

describe('phase contracts', () => {
  it('publishes all executable V3 phases, including the migrated authoring phases', () => {
    const registry = createPhaseContracts({} as never);
    expect(['PREFLIGHT', 'BUILD', 'TEST', 'REVIEW', 'FIX', 'SHIP'].every((state) => registry.get(state as never))).toBe(
      true,
    );
    expect(registry.get('BRAINSTORM')).toMatchObject({ state: 'BRAINSTORM' });
    expect(registry.get('SPEC')).toMatchObject({ state: 'SPEC' });
  });

  it('plans isolated implementers and read-only reviewers, while TEST has no agents', () => {
    const registry = createPhaseContracts({} as never);
    const build = registry.get('BUILD');
    const review = registry.get('REVIEW');
    const test = registry.get('TEST');
    expect(build?.planAgents({ surfaces: ['frontend'] }, context)[0]).toMatchObject({
      role: 'implementer',
      workspace: { kind: 'slot', slot: 'frontend' },
    });
    expect(review?.planAgents({ surfaces: ['frontend'] }, context)[0]).toMatchObject({
      role: 'reviewer',
      workspace: { kind: 'readonly-ref', ref: 'review-ref' },
      grant: { ownedPaths: [], readOnlyPaths: ['frontend/**'] },
    });
    expect(test?.planAgents({}, context)).toEqual([]);
  });

  it('adds a human ship approval and preserves result order during assembly', () => {
    const contract = createPhaseContracts({} as never).get('SHIP');
    expect(contract?.approvals).toHaveLength(1);
    expect(contract?.approvals[0]?.kind).toBe('ship');
    const first = { agent: {}, outcome: 'completed', artifacts: [], usage: {} } as never;
    const second = { agent: {}, outcome: 'failed', artifacts: [], usage: {} } as never;
    expect(contract?.assemble({}, [first, second], context)).toMatchObject({
      ok: true,
      value: { phase: 'SHIP', results: [first, second] },
    });
  });
});
