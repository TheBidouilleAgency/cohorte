import { FixedClock } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { GUARD_IDS } from '../../src/contract/ids.ts';
import { createFactCollector } from '../../src/pipeline/guards/facts.ts';

describe('FactCollector', () => {
  test('derives durable facts and leaves unprobed guards false', async () => {
    const store = {
      readRunTree: async () => ({
        run: {
          runId: 'run_1',
          specId: 'spec_1',
          specSha256: 'a'.repeat(64),
          tableVersion: 1,
          cancelRequested: false,
          pauseRequested: false,
          lastError: undefined,
          snapshotDigest: 'b'.repeat(64),
          runtimePin: { provider: 'fake' },
          baseSha: 'c'.repeat(40),
          integrationHead: 'd'.repeat(40),
          startedAt: '2026-09-19T00:00:00.000Z',
        },
        agents: [{ state: 'completed' }],
        approvals: [],
        budgets: [],
        locks: [{ ownerRunId: 'run_1' }],
      }),
    } as never;
    const facts = await createFactCollector({
      store,
      runId: 'run_1' as never,
      clock: new FixedClock('2026-09-19T01:00:00.000Z'),
      probes: { 'runtime.platform-supported': true },
    }).collect(GUARD_IDS);

    expect((facts as unknown as Record<string, unknown>)['snapshot.captured']).toBe(true);
    expect((facts as unknown as Record<string, unknown>)['locks.project+zones-held']).toBe(true);
    expect((facts as unknown as Record<string, unknown>)['runtime.platform-supported']).toBe(true);
    expect((facts as unknown as Record<string, unknown>)['checks.all-passed']).toBe(false);
  });
});
