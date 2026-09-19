// plan.json U1.09 test 4 — "in-process crash at every engine crash point (FaultInjector) then a fresh engine =>
// identical final state (recordTransition duplicate is a no-op)".

import { FaultInjector } from '@cohorte/testkit/fault-injector';
import { describe, expect, it } from 'vitest';
import { setFaultInjector } from '../../src/durability/crashpoints.ts';
import { createEngine } from '../../src/engine/index.ts';
import { coreFaultInjectorFrom, fakeLeaseManager, makeHarness, seedIdleRun, signedCommand } from './fixtures.ts';

// The crash points the `start` golden run below hits. The fifth this engine declares,
// `command.external.after-accepted`, is reached only by `pause`/`cancel`, so it has its own golden run at the bottom
// of this file (DESIGN 4.3 #19).
const ENGINE_CRASH_POINTS = [
  'host.after-lease',
  'transition.before-commit',
  'transition.after-commit',
  'checkpoint.after-events-before-snapshot',
] as const;

describe("crash + fresh engine => the golden run's final state, every declared crash point", () => {
  it('records the golden run once, unarmed', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const start = signedCommand(harness, 'start', { profile: 'feature', unattended: true });
    await harness.store.enqueueCommand(start);
    const engine = createEngine(harness.deps);
    const stop = await engine.run(harness.runId, harness.host);
    expect(stop.reason).toBe('review-clean');
    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('COMPLETED');
    await harness.store.close();
  });

  for (const point of ENGINE_CRASH_POINTS) {
    it(`crashing at "${point}" (1st occurrence): a fresh engine still reaches COMPLETED`, async () => {
      const harness = await makeHarness();
      await seedIdleRun(harness);
      const start = signedCommand(harness, 'start', { profile: 'feature', unattended: true });
      await harness.store.enqueueCommand(start);

      const injector = new FaultInjector().arm(point, { nth: 1 });
      setFaultInjector(coreFaultInjectorFrom(injector));
      const crashedEngine = createEngine(harness.deps);
      try {
        await expect(crashedEngine.run(harness.runId, harness.host)).rejects.toThrow();
      } finally {
        setFaultInjector(null);
      }

      // A FRESH engine (a fresh `createEngine` call, same store otherwise — a new host process, in spirit), no
      // injector armed: it reads the CURRENT persisted state and carries the run the rest of the way. The crashed
      // engine's lease was never released, so this one takes over exactly as a real resume would (DESIGN 4.4).
      const freshDeps = {
        ...harness.deps,
        leases: fakeLeaseManager(harness.store, harness.host.hostId, { takeover: true }),
      };
      const freshEngine = createEngine(freshDeps);
      const stop = await freshEngine.run(harness.runId, harness.host);
      expect(stop.reason).toBe('review-clean');
      const run = await harness.store.getRun(harness.runId);
      expect(run?.state).toBe('COMPLETED');

      // `recordTransition`'s own idempotency key dedup means nothing was double-applied: exactly one
      // `run.state.changed` for the toy table's TWO transitions (`start`'s and the phase's), never more.
      const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 200 });
      const stateChanges = events.filter((e) => e.type === 'run.state.changed');
      expect(stateChanges).toHaveLength(2);

      await harness.store.close();
    });
  }
});

// DESIGN 4.3 #19, the fifth crash point: "on disk: cancel_requested flag; resume does: finish the cancellation
// idempotently, then command.completed". The golden run is a `cancel` on an active run; the crashed one dies between
// the accept tx and the CANCELLED commit.
describe('command.external.after-accepted: a fresh engine finishes the cancellation, it never FAILS the run', () => {
  it('records the golden run once, unarmed', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD' });
    const cmd = signedCommand(harness, 'cancel', { keepWorktrees: true });
    await harness.store.enqueueCommand(cmd);

    const stop = await createEngine(harness.deps).run(harness.runId, harness.host);
    expect(stop.reason).toBe('cancelled');
    expect((await harness.store.getRun(harness.runId))?.state).toBe('CANCELLED');
    expect((await harness.store.getCommand(cmd.commandId))?.status).toBe('completed');

    await harness.store.close();
  });

  it('crashing at "command.external.after-accepted" (1st occurrence): a fresh engine still reaches CANCELLED', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD' });
    const cmd = signedCommand(harness, 'cancel', { keepWorktrees: true });
    await harness.store.enqueueCommand(cmd);

    const injector = new FaultInjector().arm('command.external.after-accepted', { nth: 1 });
    setFaultInjector(coreFaultInjectorFrom(injector));
    try {
      await expect(createEngine(harness.deps).run(harness.runId, harness.host)).rejects.toThrow(/simulated crash/i);
    } finally {
      setFaultInjector(null);
    }
    // Mid-crash: the durable flag is the only trace, the command is `claimed`, the run has not moved.
    const mid = await harness.store.getRun(harness.runId);
    expect(mid?.cancelRequested).toBe(true);
    expect(mid?.state).toBe('BUILD');
    expect((await harness.store.getCommand(cmd.commandId))?.status).toBe('claimed');

    const freshDeps = {
      ...harness.deps,
      leases: fakeLeaseManager(harness.store, harness.host.hostId, { takeover: true }),
    };
    const stop = await createEngine(freshDeps).run(harness.runId, harness.host);
    expect(stop.reason).toBe('cancelled');

    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('CANCELLED');
    expect(run?.cancelRequested).toBe(false);
    expect(run?.lastError).toBeUndefined();
    expect((await harness.store.getCommand(cmd.commandId))?.status).toBe('completed');
    const changes = (await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 200 })).filter(
      (e) => e.type === 'run.state.changed',
    );
    expect(changes).toHaveLength(1);

    await harness.store.close();
  });
});
