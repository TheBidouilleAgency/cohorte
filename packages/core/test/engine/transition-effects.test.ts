import type { LeaseToken } from '@cohorte/persistence/contract';
import { describe, expect, it } from 'vitest';
import { createTransitionEffectRunner } from '../../src/effects/transition-runner.ts';

const lease = { lockId: 'lock_1', runId: 'run_1', hostId: 'host_1', fencingToken: 1 } as LeaseToken;

describe('transition effect runner', () => {
  it('journals a bound handler with a stable transition idempotency key', async () => {
    const calls: string[] = [];
    const journal = {
      run: async (
        _lease: LeaseToken,
        spec: { intent: { idempotencyKey: string }; perform: (signal: AbortSignal) => Promise<unknown> },
        signal: AbortSignal,
      ) => {
        calls.push(spec.intent.idempotencyKey);
        await spec.perform(signal);
        return { status: 'done' as const, result: true };
      },
    } as never;
    const runner = createTransitionEffectRunner({
      journal,
      handlers: {
        checkpoint: async (ctx) => {
          expect(ctx.lease).toBe(lease);
        },
      },
    });

    await runner.run('checkpoint', { runId: 'run_1', lease }, new AbortController().signal);
    expect(calls).toEqual(['transition:run_1:checkpoint']);
  });

  it('fails closed when an effect has no bound handler', async () => {
    const runner = createTransitionEffectRunner({ journal: {} as never });
    await expect(
      runner.run('checkpoint', { runId: 'run_1', lease }, new AbortController().signal),
    ).rejects.toMatchObject({
      info: { code: 'configuration/policy-invalid' },
    });
  });
});
