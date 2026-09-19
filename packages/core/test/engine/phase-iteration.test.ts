// The FIX loop of a real table (`feature@1`: TEST -> FIX -> TEST, `maxFixRounds` 5) revisits the SAME phase state
// several times. Each visit is its own phase RUN: its own `phs_<STATE>_<iteration>` row, and its own transition
// (`pipeline/idempotency-key.ts`'s own header: the discriminator is "the piece that keeps two firings of the SAME row
// — e.g. T09 on round 2 of a FIX loop — from colliding"). The one-active-phase toy table of `fixtures.ts` cannot
// reach that case, so this file drives a table that loops.

import { describe, expect, it } from 'vitest';
import type { PhaseOutcome, PhaseRunContext, TransitionDef, TransitionTable } from '../../src/contract/types.ts';
import { createEngine } from '../../src/engine/index.ts';
import { buildTailRows } from '../../src/pipeline/tables/shared.ts';
import { makeHarness, seedIdleRun, signedCommand } from './fixtures.ts';

const LOOP_ROWS: readonly TransitionDef[] = [
  { id: 'L-START', from: 'IDLE', to: 'BUILD', reason: 'start', actor: 'either', preconditions: [], effects: [] },
  { id: 'L-BUILT', from: 'BUILD', to: 'TEST', reason: 'built', actor: 'system', preconditions: [], effects: [] },
  { id: 'L-RED', from: 'TEST', to: 'FIX', reason: 'tests-fail', actor: 'system', preconditions: [], effects: [] },
  { id: 'L-FIXED', from: 'FIX', to: 'TEST', reason: 'fixed', actor: 'system', preconditions: [], effects: [] },
  {
    id: 'L-GREEN',
    from: 'TEST',
    to: 'COMPLETED',
    reason: 'tests-pass',
    actor: 'system',
    preconditions: [],
    effects: [],
  },
];

/** IDLE -> BUILD -> TEST, TEST --tests-fail--> FIX --fixed--> TEST, TEST --tests-pass--> COMPLETED. */
const LOOP_TABLE: TransitionTable = {
  profile: 'feature',
  version: 1,
  initial: 'IDLE',
  phases: ['BUILD', 'TEST', 'FIX'],
  rows: [...LOOP_ROWS, ...buildTailRows()],
};

/** Fails TEST `redRounds` times, then passes it; every other phase passes. Aborts the run rather than let a loop
 * that never advances hang the suite. */
function loopingExecutor(redRounds: number, hardStopAfter = 12) {
  const seen: string[] = [];
  return {
    seen,
    execute: async (ctx: PhaseRunContext): Promise<PhaseOutcome> => {
      const state = ctx.phase.state;
      seen.push(`${state}#${ctx.phase.iteration}`);
      if (seen.length > hardStopAfter) {
        throw new Error(`the engine never advanced: ${seen.join(' -> ')}`);
      }
      const redSoFar = seen.filter((entry) => entry.startsWith('TEST')).length;
      if (state === 'TEST' && redSoFar <= redRounds) {
        return {
          kind: 'failed',
          failure: { code: 'checks-red', error: { code: 'x', message: 'red' } as never, findings: [] },
        };
      }
      return { kind: 'passed', output: {}, artifacts: [] };
    },
  };
}

describe('a phase revisited by a loop gets its own iteration', () => {
  it('two red TEST rounds produce two distinct phase rows and two tests-fail transitions', async () => {
    const executor = loopingExecutor(2);
    const harness = await makeHarness({ table: LOOP_TABLE, phases: executor });
    await seedIdleRun(harness);
    const start = signedCommand(harness, 'start', { profile: 'feature', unattended: true });
    await harness.store.enqueueCommand(start);

    const engine = createEngine(harness.deps);
    const stop = await engine.run(harness.runId, harness.host);

    expect(stop.reason).toBe('review-clean');
    expect((await harness.store.getRun(harness.runId))?.state).toBe('COMPLETED');
    expect(executor.seen).toEqual(['BUILD#1', 'TEST#1', 'FIX#1', 'TEST#2', 'FIX#2', 'TEST#3']);

    // One phase ROW per visit — a revisit must not overwrite the earlier row.
    const tree = await harness.store.readRunTree(harness.runId);
    expect(tree.phases.map((p) => p.phaseRunId).sort()).toEqual([
      'phs_BUILD_1',
      'phs_FIX_1',
      'phs_FIX_2',
      'phs_TEST_1',
      'phs_TEST_2',
      'phs_TEST_3',
    ]);
    expect(tree.phases.filter((p) => p.status === 'running')).toHaveLength(0);

    // Both red rounds really fired L-RED: a shared idempotency key would have swallowed the second as a duplicate.
    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 500 });
    const changes = events
      .filter((e) => e.type === 'run.state.changed')
      .map((e) => e.payload as { defId: string; idempotencyKey: string });
    expect(changes.filter((c) => c.defId === 'L-RED')).toHaveLength(2);
    expect(changes.filter((c) => c.defId === 'L-FIXED')).toHaveLength(2);
    expect(new Set(changes.map((c) => c.idempotencyKey)).size).toBe(changes.length);

    await harness.store.close();
  });
});
