// plan.json U1.09 test 5 — "identity: an envelope claiming actor.kind: 'human' over a non-cli transport is recorded
// as client; the engine never emits a transition with actor human without a causing commandId".

import type { Actor } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import { normalizeActor, systemActor } from '../../src/engine/actor.ts';
import { drainInbox } from '../../src/engine/inbox.ts';
import { makeHarness, seedIdleRun, signedCommand, TOY_TABLE } from './fixtures.ts';

describe('normalizeActor (DESIGN 2.6.7)', () => {
  it('kind: human is KEPT for transport: cli', () => {
    const actor: Actor = { kind: 'human', id: 'alice', transport: 'cli' };
    expect(normalizeActor(actor)).toEqual(actor);
  });

  it('kind: human over a non-cli transport is downgraded to client, never upgraded elsewhere', () => {
    const actor: Actor = { kind: 'human', id: 'alice', transport: 'stdin' };
    expect(normalizeActor(actor)).toEqual({ kind: 'client', id: 'alice', transport: 'stdin' });
  });

  it('client and system actors pass through unchanged, whatever the transport', () => {
    const client: Actor = { kind: 'client', id: 'c1', transport: 'cli' };
    const system: Actor = { kind: 'system', id: 'engine', transport: 'stdin' };
    expect(normalizeActor(client)).toEqual(client);
    expect(normalizeActor(system)).toEqual(system);
  });
});

describe('the engine records the normalised actor, from the command that caused the transition', () => {
  it('a `human` actor claimed over a non-cli transport is recorded as `client` on run.state.changed', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness, { state: 'BUILD', resumeTo: 'BUILD' });
    const cmd = signedCommand(
      harness,
      'cancel',
      { keepWorktrees: true },
      { actor: { kind: 'human', id: 'alice', transport: 'stdin' } },
    );
    await harness.store.enqueueCommand(cmd);

    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: TOY_TABLE });

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 10 });
    const accepted = events.find((e) => e.type === 'command.accepted');
    const changed = events.find((e) => e.type === 'run.state.changed');
    expect(accepted).toBeDefined();
    expect(changed).toBeDefined();
    const acceptedPayload = accepted?.payload as { actor: Actor };
    const changedPayload = changed?.payload as { actor: Actor };
    expect(acceptedPayload.actor).toEqual({ kind: 'client', id: 'alice', transport: 'stdin' });
    expect(changedPayload.actor).toEqual({ kind: 'client', id: 'alice', transport: 'stdin' });

    await harness.store.close();
  });

  it('a spontaneous (phase-outcome-driven) transition always records actor: system, via a causing host, never human', async () => {
    const harness = await makeHarness();
    await seedIdleRun(harness);
    const start = signedCommand(
      harness,
      'start',
      { profile: 'feature', unattended: true },
      { actor: { kind: 'human', id: 'bob', transport: 'cli' } },
    );
    await harness.store.enqueueCommand(start);

    const { createEngine } = await import('../../src/engine/index.ts');
    const engine = createEngine(harness.deps);
    await engine.run(harness.runId, harness.host);

    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 100 });
    const changes = events.filter((e) => e.type === 'run.state.changed');
    expect(changes).toHaveLength(2);

    // The FIRST (`start`'s own, IDLE -> BUILD) is command-driven: actor is the human who sent it.
    const first = changes[0]?.payload as { actor: Actor; defId: string };
    expect(first.actor).toEqual({ kind: 'human', id: 'bob', transport: 'cli' });

    // The SECOND (BUILD -> COMPLETED) is spontaneous, driven by the phase outcome, no command behind it: `system`,
    // never `human` — exactly `systemActor`'s own shape.
    const second = changes[1]?.payload as { actor: Actor; defId: string };
    expect(second.actor).toEqual(systemActor(harness.host.hostId));
    expect(second.actor.kind).toBe('system');

    await harness.store.close();
  });
});
