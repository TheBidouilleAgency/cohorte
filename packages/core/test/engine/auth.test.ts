// plan.json U1.09 test 2 — "forged / missing MAC => command.rejected{security/command-auth-invalid}, never applied;
// replayed commandId no-op; same id + other body => conflict/command-id-reuse".
import { describe, expect, it } from 'vitest';
import { drainInbox } from '../../src/engine/inbox.ts';
import { makeHarness, seedIdleRun, signedCommand, TOY_TABLE } from './fixtures.ts';

async function drain(harness: Awaited<ReturnType<typeof makeHarness>>) {
  const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
  await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });
}

describe('E1: MAC verification, before anything else', () => {
  it('a missing auth is rejected with security/command-auth-invalid, never applied', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const signed = signedCommand(harness, 'pause', {});
    const { auth: _auth, ...rest } = signed;
    await harness.store.enqueueCommand(rest as typeof signed);

    await drain(harness);

    const record = await harness.store.getCommand(signed.commandId);
    expect(record?.status).toBe('rejected');
    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('IDLE'); // never applied: no `pauseRequested`, no transition
    expect(run?.pauseRequested).toBe(false);

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 100 });
    const rejected = events.find((e) => e.type === 'command.rejected');
    expect(rejected).toBeDefined();
    const payload = rejected?.payload as { error: { code: string } };
    expect(payload.error.code).toBe('security/command-auth-invalid');
    expect(events.some((e) => e.type === 'command.accepted')).toBe(false);

    await harness.store.close();
  });

  it('a forged MAC (right shape, wrong value) is rejected the same way', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const signed = signedCommand(harness, 'pause', {});
    const forged = { ...signed, auth: { scheme: signed.auth?.scheme ?? 'hmac-sha256', value: '00'.repeat(32) } };
    await harness.store.enqueueCommand(forged);

    await drain(harness);

    const record = await harness.store.getCommand(signed.commandId);
    expect(record?.status).toBe('rejected');
    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 100 });
    const payload = events.find((e) => e.type === 'command.rejected')?.payload as { error: { code: string } };
    expect(payload.error.code).toBe('security/command-auth-invalid');

    await harness.store.close();
  });

  it('an unknown auth.scheme is rejected like a bad value', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const signed = signedCommand(harness, 'pause', {});
    const wrongScheme = { ...signed, auth: { scheme: 'some-future-scheme', value: signed.auth?.value ?? '' } };
    await harness.store.enqueueCommand(wrongScheme);

    await drain(harness);

    const record = await harness.store.getCommand(signed.commandId);
    expect(record?.status).toBe('rejected');

    await harness.store.close();
  });

  it('replayed commandId (same id, same body): enqueued once, processed once, no-op on the retry', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const cmd = signedCommand(harness, 'pause', {});

    const first = await harness.store.enqueueCommand(cmd);
    expect(first.status).toBe('enqueued');
    const second = await harness.store.enqueueCommand(cmd);
    expect(second.status).toBe('duplicate');

    await drain(harness);

    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.status).toBe('rejected'); // pause on IDLE: conflict/not-running — but applied exactly ONCE
    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 100 });
    expect(events.filter((e) => e.type === 'command.accepted' || e.type === 'command.rejected')).toHaveLength(2);

    await harness.store.close();
  });

  it('same commandId, a different body => conflict/command-id-reuse at the store, and the FIRST body wins', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const cmd = signedCommand(harness, 'pause', {}, { commandId: 'cmd_00000000000000000000000000000042' });
    const reused = signedCommand(
      harness,
      'cancel',
      { keepWorktrees: true },
      { commandId: 'cmd_00000000000000000000000000000042' },
    );

    const first = await harness.store.enqueueCommand(cmd);
    expect(first.status).toBe('enqueued');
    const second = await harness.store.enqueueCommand(reused);
    expect(second.status).toBe('id-reuse-conflict');
    expect(second.record.envelope.type).toBe('pause'); // the FIRST body's own type, untouched

    await drain(harness);
    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.envelope.type).toBe('pause');

    await harness.store.close();
  });
});
