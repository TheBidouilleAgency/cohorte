// @cohorte/core/durability/lease — DESIGN 2.4 / 6.4 ("lease TTL 15s, renewed every 5s"), 0.2 I6 (one writer per
// run, fenced). PLAN U1.08. Wave-0 seam (PLAN U0.08) replaced: this file is now the implementation.
//
// `LeaseManager` (frozen, contract/internal.ts) wraps the store's lock primitives (acquire/renew/release) — DESIGN
// PC-4's "own port over the store's lock/lease primitives". The keeper below is the "lease keeper" the deliverable
// names: it renews on a timer and tells its caller the moment a renewal stops succeeding, which is what makes "a
// lost lease stops every further effect with conflict/lease-lost" true in practice — the STORE already refuses the
// next write transaction on a stale fencing token (`transact`'s first statement, I6); the keeper's only job is not
// to let the host keep issuing work past that point without knowing.
import { type Clock, CohorteError, errorOf, type RunId } from '@cohorte/base';
import type { LeaseToken, LockRequest } from '@cohorte/persistence/contract';
import type { LeaseDeps } from '../../contract/factories.ts';
import type { LeaseManager } from '../../contract/internal.ts';
import type { HostContext } from '../../contract/types.ts';

// The FROZEN contract of `contract/factories.ts`, re-exported — never a second interface of the same name.
export type { LeaseDeps };

/**
 * The identity a `LockOwner` needs: DESIGN 4.4 step 3 and crash point #2 compare the stored `(pid, startToken)` of a
 * lock against the live process table ("live owner => conflict/run-host-alive; dead owner => stealLock"), so both
 * fields must describe a REAL process. It is `HostContext` (contract/types.ts) minus what a lock does not store —
 * the run host already carries exactly these three fields.
 */
export type LeaseHost = Pick<HostContext, 'hostId' | 'pid' | 'startToken'>;

/**
 * DESIGN.md §2.4: "`startToken`: OS process start time: orphan kill never trusts a bare pid". Derived from the REAL
 * wall clock and `process.uptime()` — never from `deps.clock`, which a test or a replay may freeze: the value has to
 * be the one a sweeper re-derives for that pid from the OS (`ps -o lstart`, `/proc/<pid>/stat`), not a run-local
 * timestamp. Computed ONCE per process: `process.uptime()` drifts by a millisecond between calls and the token must
 * be stable for every lock this process takes.
 */
const PROCESS_START_TOKEN = String(Math.round(Date.now() - process.uptime() * 1000));

/** `NO_RUN_ID` (`@cohorte/persistence/contract`), restated rather than imported: `core -> persistence` is a
 * TYPE-ONLY edge (`layers.json`), so the constant itself may not cross it from `src/**`. */
const NO_RUN_ID = '' as RunId;

/** The OS process start time of THIS process, as a `LockOwner.startToken` (see {@link PROCESS_START_TOKEN}). */
export function processStartToken(): string {
  return PROCESS_START_TOKEN;
}

/**
 * DEVIATION (docs/v3/requests/U1.08.md R7): the frozen `LeaseDeps` carries no host identity, so a manager built
 * without an explicit `host` names itself from the process it runs in. `pid` and `startToken` are then still exactly
 * what the sweeper checks; only `hostId` is a stand-in for the run host's own id, and it is marked as one.
 */
function processHost(): LeaseHost {
  return { hostId: `host:${process.pid}:${PROCESS_START_TOKEN}`, pid: process.pid, startToken: PROCESS_START_TOKEN };
}

/**
 * `host` is the run host's identity (`HostContext`). It is a second parameter rather than a field of `LeaseDeps`
 * because `LeaseDeps` is frozen in `contract/factories.ts` (U0.08): request R7 asks for it to move there, and until
 * it does, this optional parameter lets a composition root that HAS the identity pass the truth instead of the
 * process-derived stand-in. The frozen one-argument call `createLeaseManager(deps)` keeps working unchanged.
 */
export function createLeaseManager(deps: LeaseDeps, host: LeaseHost = processHost()): LeaseManager {
  return {
    async acquire(
      scope: { runId: RunId } | 'project',
      key: string,
      mode: 'shared' | 'exclusive',
      ttlMs: number,
    ): Promise<LeaseToken> {
      const req: LockRequest = {
        scope: scope === 'project' ? 'project' : 'run',
        key,
        mode,
        owner: {
          ...(scope === 'project' ? {} : { runId: scope.runId }),
          hostId: host.hostId,
          pid: host.pid,
          startToken: host.startToken,
        },
        ttlMs,
      };
      const acquired = await deps.store.acquireLock(req);
      if (acquired.ok) return acquired.lease;

      // ADOPTION, not a conflict: the store refuses "as long as a CONFLICTING row exists", and a row whose owner is
      // THIS very process — same hostId, same pid, same OS start token — is not another holder, it is us. The run
      // host reaches this on every run: `Resumer` takes the run lease in DESIGN 4.4 step 3 and the loop that called
      // it then asks for the same lock (`RunEngine.run`, G1-D1). The adopted token keeps the EXISTING fencing token:
      // bumping it (a `stealLock`) would invalidate the lease the holder — again, us — is already writing with.
      //
      // The branch is narrowed to EXACTLY the case G1-D1 needs: the RUN lock, EXCLUSIVE on both sides. `locksConflict`
      // matches on (scope, key) alone, so without the mode test a `shared` request would be handed the `exclusive`
      // lock this host holds — two leases over one row, either one's `release()` destroying the other's and the
      // survivor's next `renew()` answering `conflict/lease-lost`. DESIGN 4.4 step 6 rebuilds the PROJECT lock as
      // shared, so that request is real. Aliasing two acquisitions of one lock also hands them one fencing token,
      // which is 0.2 I6 ("one writer per run, fenced") lost inside a process. Everything else falls through to the
      // refusal below, exactly as before the gate.
      const sole = acquired.heldBy.length === 1 ? acquired.heldBy[0] : undefined;
      if (
        req.scope === 'run' &&
        mode === 'exclusive' &&
        sole &&
        sole.mode === 'exclusive' &&
        sole.ownerHostId === host.hostId &&
        sole.ownerPid === host.pid &&
        sole.ownerStartToken === host.startToken
      ) {
        return {
          lockId: sole.lockId,
          runId: sole.ownerRunId ?? NO_RUN_ID,
          hostId: sole.ownerHostId,
          fencingToken: sole.fencingToken,
        };
      }

      // A refused lock is a run OUTCOME, not an internal error: everything downstream (checkGlobalStops, the retry
      // policy, T25/T26) classifies by `error.class` / `error.code`. The run's own lock being held is precisely
      // "a run host already drives this run" (DESIGN 4.4 step 3); any other scope is an unclassified conflict.
      const holders = acquired.heldBy
        .map((lock) => `${lock.ownerHostId} (pid ${lock.ownerPid}, startToken ${lock.ownerStartToken})`)
        .join(', ');
      const code = req.scope === 'run' ? 'conflict/run-host-alive' : 'conflict/unexpected';
      throw new CohorteError(
        errorOf(code, `${req.scope}:${key} is already held by ${holders || 'a conflicting lock'}`),
      );
    },

    renew(lease: LeaseToken, ttlMs: number): Promise<boolean> {
      return deps.store.renewLock(lease.lockId, ttlMs);
    },

    release(lease: LeaseToken): Promise<void> {
      return deps.store.releaseLock(lease.lockId);
    },
  };
}

/** DESIGN 6.4: renew every 5 s, TTL 15 s. */
export const LEASE_TTL_MS = 15_000;
export const LEASE_RENEW_INTERVAL_MS = 5_000;

export interface LeaseKeeperOptions {
  ttlMs?: number;
  renewIntervalMs?: number;
  /** Called ONCE, the first time a renewal fails to confirm the lease is still held (`renewLock` returns false, or
   * throws). After this fires the keeper stops renewing: the caller is expected to stop issuing effects. */
  onLost: (lease: LeaseToken) => void;
}

export interface LeaseKeeper {
  /** Stops the renewal timer. Idempotent. */
  stop(): void;
  /** True once `onLost` has fired (or `stop()` has not been called and the last renewal failed). */
  lost(): boolean;
}

/**
 * Starts renewing `lease` on an interval until `stop()` is called or a renewal fails. `renewLock` returning `false`
 * means the row is simply gone (released, or never existed under this id) — the run host MUST stop producing
 * effects (DESIGN 2.4): the keeper fires `onLost` exactly once and stops its own timer.
 */
export function keepLeaseAlive(
  manager: LeaseManager,
  clock: Clock,
  lease: LeaseToken,
  options: LeaseKeeperOptions,
): LeaseKeeper {
  const ttlMs = options.ttlMs ?? LEASE_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
  let stopped = false;
  let lost = false;
  const controller = new AbortController();

  const declareLost = (): void => {
    // `stopped` guards the TERMINAL path, not just `schedule()`: a renewal already travelling to the store when the
    // caller stops the keeper answers (or rejects) afterwards, and on an ordinary shutdown — release the lease, stop
    // the keeper — that answer is `false` BECAUSE we released it. `onLost` is what stops every further effect with
    // `conflict/lease-lost`, so firing it here would report a clean shutdown as a lost lease.
    if (lost || stopped) return;
    lost = true;
    stop();
    options.onLost(lease);
  };

  const tick = (): void => {
    if (stopped) return;
    manager
      .renew(lease, ttlMs)
      .then((held) => {
        if (!held) declareLost();
        else schedule();
      })
      .catch(() => declareLost());
  };

  function schedule(): void {
    if (stopped) return;
    clock
      .sleep(renewIntervalMs, controller.signal)
      .then(tick)
      .catch(() => {
        /* aborted by stop(): nothing to do */
      });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    controller.abort();
  }

  schedule();

  return {
    stop,
    lost: () => lost,
  };
}
