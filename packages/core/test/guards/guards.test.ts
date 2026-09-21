import { describe, expect, test } from 'vitest';
import { GUARD_IDS } from '../../src/contract/ids.ts';
import { V3_0_GUARDS } from '../../src/pipeline/guards/index.ts';

describe('pipeline guards', () => {
  test('registers every table guard and fails closed when a fact is absent', () => {
    expect(Object.keys(V3_0_GUARDS).sort()).toEqual([...GUARD_IDS].sort());
    const context = {
      run: {
        run: { specId: 'spec', specSha256: 'a'.repeat(64), state: 'IDLE' },
        agents: [],
        worktrees: [],
      },
      facts: {
        cancelRequested: false,
        pauseRequested: false,
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
        nowMs: 0,
        startedAtMs: 0,
      },
      now: '2026-01-01T00:00:00.000Z',
    } as never;
    expect(V3_0_GUARDS['phase.available'](context)).toMatchObject({ id: 'phase.available', ok: true });
    expect(V3_0_GUARDS['host.not-root'](context)).toMatchObject({ id: 'host.not-root', ok: false });
  });
});
