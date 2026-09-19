// U1.08 deliverable: `LeaseManager` (a port over the store's lock primitives, PLAN PC-4) and the lease keeper
// (DESIGN 2.4 / 6.4: renew every 5 s, TTL 15 s; 0.2 I6 "one writer per run, fenced" — "a lost lease stops every
// further effect with conflict/lease-lost"). Tests first (PLAN §3 rule 9).
import { CohorteError } from '@cohorte/base';
import type { LeaseToken, LockRecord, StateStore } from '@cohorte/persistence/contract';
import { FixedClock } from '@cohorte/testkit';
import { makeStore } from '@cohorte/testkit/store-factory';
import { describe, expect, test } from 'vitest';
import type { LeaseManager } from '../../src/contract/internal.ts';
import {
  createLeaseManager,
  keepLeaseAlive,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  processStartToken,
} from '../../src/durability/lease/index.ts';
import { asRunId, seedActiveRun } from './support.ts';

const fakeLease = (overrides: Partial<LeaseToken> = {}): LeaseToken => ({
  lockId: 'lock-1',
  runId: asRunId('lease-fake'),
  hostId: 'host-1',
  fencingToken: 1,
  ...overrides,
});

describe('createLeaseManager — a port over the store lock primitives (PLAN PC-4)', () => {
  test('acquire/renew/release round-trip through a real store', async () => {
    const store: StateStore = await makeStore();
    const clock = new FixedClock();
    const manager = createLeaseManager({ store, clock });
    const runId = asRunId('lease-rt');
    await seedActiveRun(store, runId);
    const [held] = await store.listLocks({ scope: 'run' });
    if (held) await store.releaseLock(held.lockId); // seedActiveRun already holds the run lock; free it first

    const lease = await manager.acquire({ runId }, runId, 'exclusive', 60_000);
    expect(lease.runId).toBe(runId);

    expect(await manager.renew(lease, 60_000)).toBe(true);
    await manager.release(lease);
    expect(await manager.renew(lease, 60_000)).toBe(false); // released: the row is gone
  });

  test('acquire on a held run lock throws a classified `conflict/run-host-alive`, naming the holder', async () => {
    const store: StateStore = await makeStore();
    const clock = new FixedClock();
    const manager = createLeaseManager({ store, clock });
    const runId = asRunId('lease-conflict');
    await seedActiveRun(store, runId); // already holds the run lock

    // Everything downstream classifies by `error.class` / `error.code` (checkGlobalStops, the retry policy,
    // T25/T26): a bare `Error` would surface a lock conflict as an unclassified internal failure.
    const thrown: unknown = await manager.acquire({ runId }, runId, 'exclusive', 60_000).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CohorteError);
    expect((thrown as CohorteError).info.code).toBe('conflict/run-host-alive');
    expect((thrown as CohorteError).info.class).toBe('conflict');
    expect((thrown as CohorteError).message).toContain('host-1'); // seedActiveRun's holder
  });

  // ── the G1-D1 adoption branch (docs/v3/gates/G1.md §2) ───────────────────────────────────────────────────────
  //
  // `RunEngine.run` calls `Resumer.recover` first, and recovery takes the run lease; the loop then asks for the SAME
  // lock under the SAME host identity. `acquireLock` refuses "as long as a CONFLICTING row exists", and a row whose
  // owner is this very process is not another holder — it is us. The three cases below are the whole rule: who may
  // adopt, who may not, and what adoption must not change.

  test('the run lock this exact host already holds is ADOPTED: same lockId, same fencing token, still one row', async () => {
    const store: StateStore = await makeStore();
    const clock = new FixedClock();
    const runId = asRunId('lease-adopt');
    await seedActiveRun(store, runId);
    const [seeded] = await store.listLocks({ scope: 'run' });
    if (seeded) await store.releaseLock(seeded.lockId);

    const host = { hostId: 'hst_adopt', pid: 4242, startToken: '1700000000000' };
    const manager = createLeaseManager({ store, clock }, host);

    const first = await manager.acquire({ runId }, runId, 'exclusive', 60_000);
    const second = await manager.acquire({ runId }, runId, 'exclusive', 60_000);

    expect(second.lockId).toBe(first.lockId);
    // NOT bumped: a `stealLock` would mint `fencingToken + 1` and the store would then refuse the next write
    // transaction of the holder — which is this same host, already writing with `first`.
    expect(second.fencingToken).toBe(first.fencingToken);
    expect(second.runId).toBe(runId);
    expect(await store.listLocks({ scope: 'run' })).toHaveLength(1);
    // And the adopted lease is live: one release, one row gone.
    await manager.release(second);
    expect(await store.listLocks({ scope: 'run' })).toHaveLength(0);
  });

  test('a DIFFERENT incarnation of the same hostId (other pid, other startToken) still throws conflict/run-host-alive', async () => {
    const store: StateStore = await makeStore();
    const clock = new FixedClock();
    const runId = asRunId('lease-not-me');
    await seedActiveRun(store, runId);
    const [seeded] = await store.listLocks({ scope: 'run' });
    if (seeded) await store.releaseLock(seeded.lockId);

    const host = { hostId: 'hst_same', pid: 4242, startToken: '1700000000000' };
    await createLeaseManager({ store, clock }, host).acquire({ runId }, runId, 'exclusive', 60_000);

    // A recycled pid under the same hostId, and a restart of the same pid: neither is the process that holds the
    // lock, and adopting either would hand two live writers one fencing token (0.2 I6).
    for (const other of [
      { ...host, pid: 4243 },
      { ...host, startToken: '1700000009999' },
      { ...host, hostId: 'hst_other' },
    ]) {
      const thrown: unknown = await createLeaseManager({ store, clock }, other)
        .acquire({ runId }, runId, 'exclusive', 60_000)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(thrown).toBeInstanceOf(CohorteError);
      expect((thrown as CohorteError).info.code).toBe('conflict/run-host-alive');
    }
    expect(await store.listLocks({ scope: 'run' })).toHaveLength(1);
  });

  test('adoption is the RUN lock in EXCLUSIVE mode only: a shared request never inherits an exclusive lock', async () => {
    const store: StateStore = await makeStore();
    const clock = new FixedClock();
    const host = { hostId: 'hst_modes', pid: 4242, startToken: '1700000000000' };
    const manager = createLeaseManager({ store, clock }, host);

    // DESIGN 4.4 step 6 rebuilds the PROJECT lock as `shared`. `locksConflict` matches on (scope, key), so a shared
    // request against this host's own exclusive project lock reaches the refusal branch — and must stay there:
    // handing back the exclusive lease would let either holder's `release()` destroy the other's.
    const exclusive = await manager.acquire('project', 'project', 'exclusive', 60_000);
    const shared: unknown = await manager.acquire('project', 'project', 'shared', 60_000).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(shared).toBeInstanceOf(CohorteError);
    expect((shared as CohorteError).info.code).toBe('conflict/unexpected');
    const [project] = await store.listLocks({ scope: 'project' });
    expect(project?.mode).toBe('exclusive');
    expect(project?.lockId).toBe(exclusive.lockId);

    // Same rule on the run scope, where the adoption branch does live.
    const runId = asRunId('lease-modes');
    await seedActiveRun(store, runId);
    const [seeded] = await store.listLocks({ scope: 'run' });
    if (seeded) await store.releaseLock(seeded.lockId);
    await manager.acquire({ runId }, runId, 'exclusive', 60_000);
    const sharedRun: unknown = await manager.acquire({ runId }, runId, 'shared', 60_000).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(sharedRun).toBeInstanceOf(CohorteError);
    expect((sharedRun as CohorteError).info.code).toBe('conflict/run-host-alive');
    expect(await store.listLocks({ scope: 'run' })).toHaveLength(1);
  });

  test('the lock owner carries a real host identity: the (pid, startToken) pair a sweeper can re-derive', async () => {
    const store: StateStore = await makeStore();
    const clock = new FixedClock();
    const runId = asRunId('lease-owner');
    await seedActiveRun(store, runId);
    const [seeded] = await store.listLocks({ scope: 'run' });
    if (seeded) await store.releaseLock(seeded.lockId);

    // DESIGN 4.4 step 3 and crash point #2 compare the STORED (pid, startToken) with the live process table, so
    // `startToken` has to be the OS process start time — a clock reading matches no property of the process and
    // makes the liveness check undecidable. Default: derived from this process.
    const fromProcess = createLeaseManager({ store, clock });
    await fromProcess.acquire({ runId }, runId, 'exclusive', 60_000);
    const [own] = await store.listLocks({ scope: 'run' });
    expect(own?.ownerPid).toBe(process.pid);
    expect(own?.ownerStartToken).toBe(processStartToken());
    // ~ the real process start: within a second of `Date.now() - uptime`, and NOT a `deps.clock` reading.
    const elapsedSinceToken = Date.now() - Number(processStartToken());
    expect(Math.abs(elapsedSinceToken - process.uptime() * 1000)).toBeLessThan(1_000);
    expect(own?.ownerStartToken).not.toContain(clock.now());

    // And when the run host passes its own identity (request R7), that is what the lock stores.
    await store.releaseLock((own as LockRecord).lockId);
    const host = { hostId: 'hst_42', pid: 4242, startToken: '1700000000000' };
    const fromHost = createLeaseManager({ store, clock }, host);
    await fromHost.acquire({ runId }, runId, 'exclusive', 60_000);
    const [named] = await store.listLocks({ scope: 'run' });
    expect(named?.ownerHostId).toBe('hst_42');
    expect(named?.ownerPid).toBe(4242);
    expect(named?.ownerStartToken).toBe('1700000000000');
  });
});

describe('keepLeaseAlive — DESIGN 6.4 (renew every 5 s, TTL 15 s)', () => {
  test('renews on schedule at the default interval and TTL until stopped', async () => {
    const clock = new FixedClock();
    const renewals: number[] = [];
    const manager: LeaseManager = {
      acquire: () => {
        throw new Error('not used in this test');
      },
      renew: async (_lease, ttlMs) => {
        renewals.push(ttlMs);
        return true;
      },
      release: async () => {},
    };

    const keeper = keepLeaseAlive(manager, clock, fakeLease(), {
      onLost: () => {
        throw new Error('must not be declared lost');
      },
    });

    await clock.tick(LEASE_RENEW_INTERVAL_MS * 3);
    expect(renewals).toEqual([LEASE_TTL_MS, LEASE_TTL_MS, LEASE_TTL_MS]);
    expect(keeper.lost()).toBe(false);

    keeper.stop();
    await clock.tick(LEASE_RENEW_INTERVAL_MS * 3);
    expect(renewals).toHaveLength(3); // stop() is final: no renewal fires afterwards
  });

  test('a renewal reporting the lease gone fires onLost exactly once and stops the keeper (DESIGN 2.4)', async () => {
    const clock = new FixedClock();
    let attempts = 0;
    const manager: LeaseManager = {
      acquire: () => {
        throw new Error('not used in this test');
      },
      renew: async () => {
        attempts += 1;
        return attempts < 2; // succeeds once, then the row is gone
      },
      release: async () => {},
    };
    let lostCalls = 0;
    const keeper = keepLeaseAlive(manager, clock, fakeLease(), { onLost: () => (lostCalls += 1) });

    await clock.tick(LEASE_RENEW_INTERVAL_MS * 5);

    expect(lostCalls).toBe(1);
    expect(keeper.lost()).toBe(true);
    expect(attempts).toBe(2); // no further renewal attempted once lost
  });

  test('a renewal that throws is treated the same as "lease gone": onLost fires once, the keeper stops', async () => {
    const clock = new FixedClock();
    const manager: LeaseManager = {
      acquire: () => {
        throw new Error('not used in this test');
      },
      renew: async () => {
        throw new Error('store unreachable');
      },
      release: async () => {},
    };
    let lostCalls = 0;
    const keeper = keepLeaseAlive(manager, clock, fakeLease(), { onLost: () => (lostCalls += 1) });

    await clock.tick(LEASE_RENEW_INTERVAL_MS);

    expect(lostCalls).toBe(1);
    expect(keeper.lost()).toBe(true);
  });

  test('a renewal still in flight when stop() lands never declares the lease lost', async () => {
    const clock = new FixedClock();
    let settle: ((held: boolean) => void) | undefined;
    const manager: LeaseManager = {
      acquire: () => {
        throw new Error('not used in this test');
      },
      renew: () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
      release: async () => {},
    };
    let lostCalls = 0;
    const keeper = keepLeaseAlive(manager, clock, fakeLease(), { onLost: () => (lostCalls += 1) });

    await clock.tick(LEASE_RENEW_INTERVAL_MS); // the first renewal is now in flight and does not settle
    expect(settle).toBeDefined();

    // The ORDINARY shutdown of a run host: release the lease, then stop the keeper. The renewal that was already
    // travelling to the store answers `false` afterwards — the row is gone because WE removed it, which is not a
    // lost lease. `onLost` is the signal that stops every further effect with `conflict/lease-lost`, so firing it
    // here would report a clean shutdown as a takeover.
    keeper.stop();
    settle?.(false);
    await clock.tick(LEASE_RENEW_INTERVAL_MS * 2);

    expect(lostCalls).toBe(0);
    expect(keeper.lost()).toBe(false);
  });

  test('a renewal in flight that REJECTS after stop() is equally silent', async () => {
    const clock = new FixedClock();
    let fail: ((error: Error) => void) | undefined;
    const manager: LeaseManager = {
      acquire: () => {
        throw new Error('not used in this test');
      },
      renew: () =>
        new Promise<boolean>((_resolve, reject) => {
          fail = reject;
        }),
      release: async () => {},
    };
    let lostCalls = 0;
    const keeper = keepLeaseAlive(manager, clock, fakeLease(), { onLost: () => (lostCalls += 1) });

    await clock.tick(LEASE_RENEW_INTERVAL_MS);
    expect(fail).toBeDefined();

    keeper.stop();
    fail?.(new Error('store closed during shutdown'));
    await clock.tick(LEASE_RENEW_INTERVAL_MS * 2);

    expect(lostCalls).toBe(0);
    expect(keeper.lost()).toBe(false);
  });

  test('stop() before any loss is idempotent and never fires onLost', async () => {
    const clock = new FixedClock();
    const manager: LeaseManager = {
      acquire: () => {
        throw new Error('not used in this test');
      },
      renew: async () => true,
      release: async () => {},
    };
    const keeper = keepLeaseAlive(manager, clock, fakeLease(), {
      onLost: () => {
        throw new Error('must not fire');
      },
    });

    keeper.stop();
    keeper.stop(); // idempotent

    await clock.tick(LEASE_RENEW_INTERVAL_MS * 3);
    expect(keeper.lost()).toBe(false);
  });
});
