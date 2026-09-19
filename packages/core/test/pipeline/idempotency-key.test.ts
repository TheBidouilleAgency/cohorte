// DESIGN 2.5.1 — the persisted TransitionRecord's idempotency key, verbatim template:
// `${runId}:${profile}@${tableVersion}:${defId}:${fromPhaseRunId ?? '-'}:${discriminator}`.
import type { PhaseRunId, RunId } from '@cohorte/base';
import { describe, expect, it } from 'vitest';
import { transitionIdempotencyKey } from '../../src/pipeline/idempotency-key.ts';

const RUN_ID = 'run_00000000000000000000000001' as RunId;
const PHASE_RUN_ID = 'phs_TEST_2' as PhaseRunId;

describe('transitionIdempotencyKey — golden vectors', () => {
  it('with a fromPhaseRunId', () => {
    expect(
      transitionIdempotencyKey({
        runId: RUN_ID,
        profile: 'feature',
        tableVersion: 1,
        defId: 'T09',
        fromPhaseRunId: PHASE_RUN_ID,
        discriminator: 'round-2',
      }),
    ).toBe('run_00000000000000000000000001:feature@1:T09:phs_TEST_2:round-2');
  });

  it('without a fromPhaseRunId (an IDLE-sourced row): the placeholder is a bare "-"', () => {
    expect(
      transitionIdempotencyKey({
        runId: RUN_ID,
        profile: 'feature',
        tableVersion: 1,
        defId: 'T04',
        discriminator: 'once',
      }),
    ).toBe('run_00000000000000000000000001:feature@1:T04:-:once');
  });

  it('a different profile and table version both show up in the key, verbatim', () => {
    expect(
      transitionIdempotencyKey({
        runId: RUN_ID,
        profile: 'review',
        tableVersion: 1,
        defId: 'R01',
        discriminator: 'x',
      }),
    ).toBe('run_00000000000000000000000001:review@1:R01:-:x');
  });
});

describe('transitionIdempotencyKey — stability', () => {
  it('is a pure function of its input: the same input always yields the same key', () => {
    const input = {
      runId: RUN_ID,
      profile: 'feature' as const,
      tableVersion: 1,
      defId: 'T13',
      fromPhaseRunId: PHASE_RUN_ID,
      discriminator: 'a',
    };
    expect(transitionIdempotencyKey(input)).toBe(transitionIdempotencyKey({ ...input }));
  });

  it('two different discriminators for the same row never collide', () => {
    const base = { runId: RUN_ID, profile: 'feature' as const, tableVersion: 1, defId: 'T13' };
    const first = transitionIdempotencyKey({ ...base, discriminator: 'round-1' });
    const second = transitionIdempotencyKey({ ...base, discriminator: 'round-2' });
    expect(first).not.toBe(second);
  });

  it('two different row ids on the same run never collide, even with the same discriminator', () => {
    const base = { runId: RUN_ID, profile: 'feature' as const, tableVersion: 1, discriminator: 'x' };
    expect(transitionIdempotencyKey({ ...base, defId: 'T08' })).not.toBe(
      transitionIdempotencyKey({ ...base, defId: 'T09' }),
    );
  });
});
