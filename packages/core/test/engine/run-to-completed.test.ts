// plan.json U1.09 test 1a — "toy 2-state table LOCAL to the tests + makeStore(): run to COMPLETED".
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/index.ts';
import { makeHarness, seedIdleRun, signedCommand } from './fixtures.ts';

describe('RunEngine: run to COMPLETED on a toy table', () => {
  it('drains a signed `start`, runs the one phase, and reaches COMPLETED', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const start = signedCommand(harness, 'start', {
      profile: 'feature',
      unattended: true,
    });
    const enqueued = await harness.store.enqueueCommand(start);
    expect(enqueued.status).toBe('enqueued');

    const engine = createEngine(harness.deps);
    const stop = await engine.run(harness.runId, harness.host);

    expect(stop.reason).toBe('review-clean');
    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('COMPLETED');

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 100 });
    const types = events.map((e) => e.type);
    expect(types).toContain('command.accepted');
    expect(types).toContain('command.completed');
    expect(types).toContain('run.state.changed');
    expect(types).toContain('phase.started');
    expect(types).toContain('phase.completed');
    expect(types).toContain('checkpoint.created');

    const command = await harness.store.getCommand(start.commandId);
    expect(command?.status).toBe('completed');

    await harness.store.close();
  });

  // The crash tests pin the other half — a host that dies keeps its row so a later host can take it over with
  // fencing + 1 (DESIGN 4.4). Nothing pinned this half, so a regression that left the row behind on a NORMAL exit
  // would have been invisible until a second run refused to start. Raised by the U1.INT reviewer (G1.md §4).
  it('hands the run lock back on a clean exit, leaving no row to take over', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    await harness.store.enqueueCommand(signedCommand(harness, 'start', { profile: 'feature', unattended: true }));

    expect(await harness.store.listLocks({ scope: 'run' })).toEqual([]);
    const stop = await createEngine(harness.deps).run(harness.runId, harness.host);

    expect(stop.reason).toBe('review-clean');
    expect(await harness.store.listLocks({ scope: 'run' })).toEqual([]);

    await harness.store.close();
  });
});
