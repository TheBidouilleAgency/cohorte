import { describe, expect, test } from 'vitest';
import { createRunHost } from '../../src/host/index.ts';

describe('RunHost', () => {
  test('starts heartbeat before running the engine and stops it afterwards', async () => {
    const calls: string[] = [];
    const host = createRunHost({
      engine: {
        run: async (_runId, context) => {
          calls.push(`engine:${context.hostId}`);
          return { reason: 'review-clean', detail: 'done', resumable: false };
        },
      },
      runId: 'run_1' as never,
      cohorteVersion: '3.0.0-test',
      heartbeat: (value) => {
        calls.push(`heartbeat:${value.pid}`);
      },
      heartbeatMs: 60_000,
    });
    const result = await host.run();
    expect(result.reason).toBe('review-clean');
    expect(calls[0]).toMatch(/^heartbeat:/);
    expect(calls[1]).toMatch(/^engine:/);
  });

  test('refuses a host started inside its target tree', async () => {
    const host = createRunHost({
      engine: { run: async () => ({ reason: 'review-clean', detail: 'done', resumable: false }) },
      runId: 'run_1' as never,
      cohorteVersion: '3.0.0-test',
      cwd: process.cwd(),
      targetRoot: process.cwd(),
    });
    await expect(host.run()).rejects.toMatchObject({ info: { code: 'security/runtime-inside-target' } });
  });
});
