// plan.json U1.09 test 3 — "pause/cancel orderings; events-before-snapshot; fatal handler path".

import type { ErrorInfo } from '@cohorte/base';
import type { LeaseToken } from '@cohorte/persistence/contract';
import type { Actor } from '@cohorte/protocol';
import { FaultInjector } from '@cohorte/testkit/fault-injector';
import { describe, expect, it } from 'vitest';
import type { PhaseOutcome } from '../../src/contract/types.ts';
import { setFaultInjector } from '../../src/durability/crashpoints.ts';
import { writeCheckpoint } from '../../src/engine/checkpoint.ts';
import { drainInbox } from '../../src/engine/inbox.ts';
import { createEngine } from '../../src/engine/index.ts';
import { settleStop } from '../../src/engine/transitions.ts';
import { nextStep } from '../../src/pipeline/next-step.ts';
import {
  coreFaultInjectorFrom,
  makeHarness,
  seedIdleRun,
  seedOpenPhase,
  signedCommand,
  TOY_TABLE,
} from './fixtures.ts';

describe('a suspended run ends the loop: "the engine schedules nothing new" (DESIGN 4.6)', () => {
  it('a pause on a run whose phase row is still open commits PAUSED and returns, re-running nothing', async () => {
    let calls = 0;
    const harness = await makeHarness({
      phases: {
        async execute(): Promise<PhaseOutcome> {
          calls += 1;
          return { kind: 'passed', output: {}, artifacts: [] };
        },
      },
    });
    // The shape a real run in an ACTIVE state always has: DESIGN 4.2 E5 opens the phase row at the transition, and a
    // pause never closes it — so the state alone must stop the loop.
    await seedIdleRun(harness, { state: 'BUILD' });
    await seedOpenPhase(harness, 'BUILD');
    await harness.store.enqueueCommand(signedCommand(harness, 'pause', {}));

    const engine = createEngine(harness.deps);
    const stop = await engine.run(harness.runId, harness.host);

    expect(stop.reason).toBe('paused');
    expect(stop.resumable).toBe(true);
    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('PAUSED');
    expect(run?.resumeTo).toBe('BUILD');
    expect(run?.stop?.reason).toBe('paused');
    expect(calls).toBe(0);

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 100 });
    expect(events.map((e) => e.type)).toEqual([
      'command.accepted',
      'run.paused',
      'run.state.changed',
      'command.completed',
      'checkpoint.created',
    ]);

    await harness.store.close();
  });
});

describe('cancel: durable flag first, then effects, then CANCELLED', () => {
  it('the durable flag survives a crash right after the accept tx, before CANCELLED ever commits', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD', resumeTo: 'BUILD' });
    const cmd = signedCommand(harness, 'cancel', { keepWorktrees: true });
    await harness.store.enqueueCommand(cmd);

    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    const injector = new FaultInjector().arm('command.external.after-accepted');
    setFaultInjector(coreFaultInjectorFrom(injector));
    try {
      await expect(
        drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE }),
      ).rejects.toThrow(/simulated crash/i);
    } finally {
      setFaultInjector(null);
    }

    // Crashed right after the accept tx: the durable flag survived, the command is still `claimed` (not finished —
    // recovering a `claimed`-but-unfinished command is `Resumer`'s job, a different port this unit is not handed),
    // and — the point of "durable flag first" — nothing committed the CANCELLED transition itself yet.
    const midCrash = await harness.store.getRun(harness.runId);
    expect(midCrash?.cancelRequested).toBe(true);
    expect(midCrash?.state).toBe('BUILD');
    const midRecord = await harness.store.getCommand(cmd.commandId);
    expect(midRecord?.status).toBe('claimed');

    await harness.store.close();
  });

  it('the ordinary (uncrashed) path clears the flag once CANCELLED is committed, and completes the command', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD', resumeTo: 'BUILD' });
    const cmd = signedCommand(harness, 'cancel', { keepWorktrees: true });
    await harness.store.enqueueCommand(cmd);

    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const after = await harness.store.getRun(harness.runId);
    expect(after?.state).toBe('CANCELLED');
    expect(after?.cancelRequested).toBe(false);
    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.status).toBe('completed');
    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 10 });
    // DESIGN 4.6 tx2: `{ run.cancelled ; state CANCELLED ; locks released ; command.completed }`, then the
    // checkpoint every suspension/halt writes (DESIGN 4.2 E2, spec 11.3).
    expect(events.map((e) => e.type)).toEqual([
      'command.accepted',
      'run.cancelled',
      'run.state.changed',
      'command.completed',
      'checkpoint.created',
    ]);

    await harness.store.close();
  });
});

describe('pause records resumeTo, so the next resume knows where to land', () => {
  it('pause on a run with NO pre-seeded resumeTo records it, and resume returns there', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD' });
    expect((await harness.store.getRun(harness.runId))?.resumeTo).toBeUndefined();

    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    const pause = signedCommand(harness, 'pause', {});
    await harness.store.enqueueCommand(pause);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const paused = await harness.store.getRun(harness.runId);
    expect(paused?.state).toBe('PAUSED');
    expect(paused?.resumeTo).toBe('BUILD');
    expect(paused?.pauseRequested).toBe(false);
    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 20 });
    expect(events.map((e) => e.type)).toEqual([
      'command.accepted',
      'run.paused',
      'run.state.changed',
      'command.completed',
      'checkpoint.created',
    ]);
    const changed = events.find((e) => e.type === 'run.state.changed')?.payload as { resumeTo?: string };
    expect(changed.resumeTo).toBe('BUILD');

    const resume = signedCommand(harness, 'resume', {});
    await harness.store.enqueueCommand(resume);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const resumed = await harness.store.getRun(harness.runId);
    expect(resumed?.state).toBe('BUILD');
    expect((await harness.store.getCommand(resume.commandId))?.status).toBe('completed');

    await harness.store.close();
  });
});

describe('settleStop: a human-actor stop row (T20 pause, T27 cancel) fires from the command that caused it', () => {
  /** Exactly what the accept transaction of a `pause` leaves on disk before its host dies (DESIGN 4.3 #19): the
   * command claimed, the durable flag set, `command.accepted` in the journal, nothing else. */
  async function acceptPauseAndDie(harness: Awaited<ReturnType<typeof makeHarness>>, lease: LeaseToken, actor: Actor) {
    const cmd = signedCommand(harness, 'pause', {}, { actor });
    await harness.store.enqueueCommand(cmd);
    await harness.store.transact({ runId: harness.runId }, lease, (tx) => {
      tx.claimCommand(cmd.commandId, harness.host.hostId);
      tx.patchRun(harness.runId, { pauseRequested: true });
      harness.deps.events.append(tx, [
        {
          type: 'command.accepted',
          payload: { commandId: cmd.commandId, type: 'pause', actor, authVerified: true, scheme: 'hmac-sha256' },
          summary: 'command pause accepted',
        },
      ]);
    });
    return cmd;
  }

  async function settle(harness: Awaited<ReturnType<typeof makeHarness>>, lease: LeaseToken) {
    const runState = await harness.store.readRunTree(harness.runId);
    const step = nextStep(runState, TOY_TABLE);
    const facts = await harness.deps.factCollector.collect(step.guards);
    await settleStop({
      deps: harness.deps,
      runId: harness.runId,
      host: harness.host,
      lease,
      table: TOY_TABLE,
      runState,
      step,
      facts,
      stop: { reason: 'paused', detail: 'pause requested', resumable: true },
    });
  }

  it('records THAT command actor and id, clears the flag, and completes the command', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD' });
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    const actor: Actor = { kind: 'human', id: 'alice', transport: 'cli' };
    const cmd = await acceptPauseAndDie(harness, lease, actor);

    await settle(harness, lease);

    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('PAUSED');
    expect(run?.resumeTo).toBe('BUILD');
    expect(run?.pauseRequested).toBe(false);
    expect((await harness.store.getCommand(cmd.commandId))?.status).toBe('completed');

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 20 });
    const changed = events.find((e) => e.type === 'run.state.changed')?.payload as { actor: Actor; defId: string };
    expect(changed.defId).toBe('T20');
    expect(changed.actor).toEqual(actor);
    // DESIGN 4.6 tx2 lists `run.paused` for BOTH paths: settling the stop the flag raised must leave the same
    // journal the inbox path leaves, or the same state change would read differently depending on who settled it.
    expect(events.map((e) => e.type)).toEqual([
      'command.accepted',
      'run.paused',
      'run.state.changed',
      'command.completed',
      'checkpoint.created',
    ]);

    await harness.store.close();
  });

  it('with NO such command behind the flag the row is refused: the engine never fires a human row on its own', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD' });
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    await harness.store.transact({ runId: harness.runId }, lease, (tx) => {
      tx.patchRun(harness.runId, { pauseRequested: true });
    });

    await expect(settle(harness, lease)).rejects.toThrow(/actor:"human"/);
    expect((await harness.store.getRun(harness.runId))?.state).toBe('BUILD');

    await harness.store.close();
  });
});

describe('checkpoint: events before the snapshot (DESIGN 4.3 #18)', () => {
  it('a crash between the checkpoint event and the snapshot leaves the event committed and the snapshot absent', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);

    const injector = new FaultInjector().arm('checkpoint.after-events-before-snapshot');
    setFaultInjector(coreFaultInjectorFrom(injector));
    try {
      await expect(
        writeCheckpoint({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, cause: 'interval' }),
      ).rejects.toThrow(/simulated crash/i);
    } finally {
      setFaultInjector(null);
    }

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 10 });
    expect(events.some((e) => e.type === 'checkpoint.created')).toBe(true);
    const snapshot = await harness.store.loadSnapshot(harness.runId);
    expect(snapshot).toBeUndefined();

    // Resuming (a second `writeCheckpoint`, no injector) supplies the missing snapshot.
    await writeCheckpoint({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, cause: 'interval' });
    expect(await harness.store.loadSnapshot(harness.runId)).toBeDefined();

    await harness.store.close();
  });
});

describe('fatal handler: unknown throwable => FAILED + checkpoint.created{cause: fatal}', () => {
  it('a phase executor that throws an unclassified error lands the run on FAILED with a fatal checkpoint', async () => {
    const harness = await makeHarness({
      phases: {
        execute() {
          throw new Error('boom: a bug inside the phase executor');
        },
      },
    });
    await seedIdleRun(harness);
    const start = signedCommand(harness, 'start', { profile: 'feature', unattended: true });
    await harness.store.enqueueCommand(start);

    const engine = createEngine(harness.deps);
    const stop = await engine.run(harness.runId, harness.host);

    expect(stop.reason).toBe('internal-error');
    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('FAILED');
    expect(run?.lastError?.message).toMatch(/boom/);

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 100 });
    const checkpoints = events.filter((e) => e.type === 'checkpoint.created');
    expect(checkpoints.length).toBeGreaterThan(0);
    const lastCheckpoint = checkpoints.at(-1)?.payload as { cause: string };
    expect(lastCheckpoint.cause).toBe('fatal');

    await harness.store.close();
  });

  it('the fallback commit (no table row answers the stop) still journals `error` and `run.state.changed`', async () => {
    const harness = await makeHarness();
    // IDLE: T26 (and the toy table's own tail) is `*active -> FAILED`, so NO row answers `internal-error` here and
    // the fatal handler takes its unconditional-patch branch. A run row that says FAILED while the journal's last
    // state event says IDLE is a projection every pure reader (DESIGN 4.7) would get wrong.
    await seedIdleRun(harness);
    // The throw comes from a port the LOOP calls, not from `Resumer`: since gate G1 (G1-D1) `run()` calls
    // `resume.recover()` BEFORE it takes the run lease and outside the fatal handler, so a recovery that refuses
    // (typically `conflict/run-host-alive`) leaves the run alone instead of marking it FAILED under the host that
    // actually owns it. `factCollector.collect` is the first port of the loop body proper, still with the run IDLE,
    // which is the shape this case is about.
    harness.deps.factCollector = {
      async collect() {
        throw new Error('boom: a bug inside a port of the loop');
      },
    };

    const engine = createEngine(harness.deps);
    const stop = await engine.run(harness.runId, harness.host);
    expect(stop.reason).toBe('internal-error');

    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('FAILED');
    expect(run?.lastError?.message).toMatch(/boom/);

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 100 });
    expect(events.map((e) => e.type)).toEqual(['error', 'run.state.changed', 'checkpoint.created']);
    const errorPayload = events[0]?.payload as { error: ErrorInfo; fatal: boolean };
    expect(errorPayload.fatal).toBe(true);
    expect(errorPayload.error.message).toMatch(/boom/);
    const changed = events[1]?.payload as { from: string; to: string; reason: string; stop?: { reason: string } };
    expect(changed.from).toBe('IDLE');
    expect(changed.to).toBe('FAILED');
    expect(changed.reason).toBe('unexpected-error');
    expect(changed.stop?.reason).toBe('internal-error');
    const checkpoint = events[2]?.payload as { cause: string } | undefined;
    expect(checkpoint?.cause).toBe('fatal');

    await harness.store.close();
  });

  it('a lease loss is never turned into a FAILED commit: it is rethrown, exiting at once', async () => {
    const harness = await makeHarness({
      phases: {
        async execute() {
          return { kind: 'passed', output: {}, artifacts: [] };
        },
      },
    });
    await seedIdleRun(harness);
    const start = signedCommand(harness, 'start', { profile: 'feature', unattended: true });
    await harness.store.enqueueCommand(start);

    // A dead lease: renew() will report false on the SECOND E0 (this engine never actually held the run's lock).
    harness.deps.leases = {
      async acquire() {
        return { lockId: 'fake', runId: harness.runId, hostId: harness.host.hostId, fencingToken: 0 };
      },
      async renew() {
        return false;
      },
      async release() {},
    };

    const engine = createEngine(harness.deps);
    await expect(engine.run(harness.runId, harness.host)).rejects.toThrow(/conflict\/lease-lost|lease/i);

    await harness.store.close();
  });
});
