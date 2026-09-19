// Fix round 1 (reviewer findings on U1.09) — the three inbox properties DESIGN 4.2 E1 / 2.3.4 state and nothing
// exercised: `expectedSequence` is judged against the sequence the CLIENT last observed (not against the one the
// engine's own `command.accepted` just produced), a command the matrix does not apply leaves no durable
// pause/cancel flag behind, and a command without an external effect is exactly ONE transaction.

import { describe, expect, it } from 'vitest';
import { writeCheckpoint } from '../../src/engine/checkpoint.ts';
import { drainInbox } from '../../src/engine/inbox.ts';
import { countTransactions, makeHarness, seedIdleRun, signedCommand, TOY_TABLE } from './fixtures.ts';

describe('expectedSequence (DESIGN 2.3.4: "reject if the run moved past this sequence")', () => {
  it('a command carrying the sequence the client last observed is ACCEPTED and applied', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD' });
    const before = await harness.store.getRun(harness.runId);
    expect(before?.lastSequence).toBe(0);

    const cmd = signedCommand(harness, 'pause', {}, { expectedSequence: 0 });
    await harness.store.enqueueCommand(cmd);
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.status).toBe('completed');
    expect((await harness.store.getRun(harness.runId))?.state).toBe('PAUSED');

    await harness.store.close();
  });

  it('a command whose run has genuinely moved past that sequence is rejected', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD' });
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    // The run really moves: a checkpoint appends `checkpoint.created`, bumping `runs.lastSequence`.
    await writeCheckpoint({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, cause: 'interval' });
    const moved = await harness.store.getRun(harness.runId);
    expect(moved?.lastSequence).toBeGreaterThan(0);

    const cmd = signedCommand(harness, 'pause', {}, { expectedSequence: 0 });
    await harness.store.enqueueCommand(cmd);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.status).toBe('rejected');
    expect((await harness.store.getRun(harness.runId))?.state).toBe('BUILD');

    await harness.store.close();
  });
});

describe('a command the matrix does not apply leaves no durable flag behind', () => {
  it('pause on IDLE is rejected AND pauseRequested stays false', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const cmd = signedCommand(harness, 'pause', {});
    await harness.store.enqueueCommand(cmd);
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.status).toBe('rejected');
    const run = await harness.store.getRun(harness.runId);
    expect(run?.pauseRequested).toBe(false);
    expect(run?.state).toBe('IDLE');

    await harness.store.close();
  });

  it('pause on an already-suspended run is a {noop} AND pauseRequested stays false', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'PAUSED', resumeTo: 'BUILD' });
    const cmd = signedCommand(harness, 'pause', {});
    await harness.store.enqueueCommand(cmd);
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.status).toBe('completed');
    const run = await harness.store.getRun(harness.runId);
    expect(run?.pauseRequested).toBe(false);
    expect(run?.state).toBe('PAUSED');

    await harness.store.close();
  });

  it('cancel on a terminal run is a {noop} AND cancelRequested stays false', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'COMPLETED' });
    const cmd = signedCommand(harness, 'cancel', { keepWorktrees: true });
    await harness.store.enqueueCommand(cmd);
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.status).toBe('completed');
    expect((await harness.store.getRun(harness.runId))?.cancelRequested).toBe(false);

    await harness.store.close();
  });
});

describe('DESIGN 4.2 E1: ONE tx per command; two only for a command with an external effect', () => {
  it('a rejection is one transaction', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const cmd = signedCommand(harness, 'pause', {});
    await harness.store.enqueueCommand(cmd);
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);

    const counted = countTransactions(harness.store);
    await drainInbox({
      deps: { ...harness.deps, store: counted.store },
      runId: harness.runId,
      host: harness.host,
      lease,
      table: TOY_TABLE,
    });
    expect(counted.count()).toBe(1);

    await harness.store.close();
  });

  it('a transition command with no external effect (resume) is one transaction', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'PAUSED', resumeTo: 'BUILD' });
    const cmd = signedCommand(harness, 'resume', {});
    await harness.store.enqueueCommand(cmd);
    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);

    const counted = countTransactions(harness.store);
    await drainInbox({
      deps: { ...harness.deps, store: counted.store },
      runId: harness.runId,
      host: harness.host,
      lease,
      table: TOY_TABLE,
    });
    expect(counted.count()).toBe(1);
    expect((await harness.store.getRun(harness.runId))?.state).toBe('BUILD');

    await harness.store.close();
  });
});
