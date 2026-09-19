// @cohorte/core/engine — DESIGN 4.2's loop E0-E8: `createEngine` on the Wave-0 kernel (`nextStep`,
// `resolveTransition`, `evolve`, U0.09), inbox drain with MAC verification (E1, inbox.ts), global stops and
// checkpoints (E2, E8, checkpoint.ts / transitions.ts), phase advancement (E3-E7, transitions.ts), the fatal
// handler (DESIGN 2.8: "unknown throwable => FAILED + checkpoint.created{cause:'fatal'}").
//
// PLAN U1.09. Wave-0 seam (PLAN U0.08) replaced: this file is now the implementation. `createEngine`'s SIGNATURE
// diverges from the frozen stub's `EngineDeps` — see `./deps.ts`'s header comment (docs/v3/requests/U1.09.md) for
// why, and why that is the smallest reading available inside this unit's own `ownedPaths`.
import { CohorteError, errorOf, type RunId, toErrorInfo } from '@cohorte/base';
import type { LeaseToken } from '@cohorte/persistence/contract';
import type { PipelineProfile, StopReason, StopRecord } from '@cohorte/protocol';
import { HALTED_STATES, SUSPENDED_STATES, TERMINAL_STATES } from '@cohorte/protocol';
import type { RunEngine } from '../contract/internal.ts';
import type { EventDraftInput, HostContext, RunState, TransitionTable } from '../contract/types.ts';
import { crashpoint, SimulatedCrash } from '../durability/crashpoints.ts';
import { transitionIdempotencyKey } from '../pipeline/idempotency-key.ts';
import { nextStep } from '../pipeline/next-step.ts';
import { systemActor } from './actor.ts';
import { writeCheckpoint } from './checkpoint.ts';
import { DEFAULT_LEASE_TTL_MS, type RunEngineDeps } from './deps.ts';
import { drainInbox } from './inbox.ts';
import { buildPhaseRunContext, closePhaseAndAdvance, type OpenPhase, settleStop } from './transitions.ts';

export type { RunEngineDeps } from './deps.ts';
export { DEFAULT_LEASE_TTL_MS } from './deps.ts';

/** DESIGN 4.7: "the host polls every 250 ms". Overridable per engine instance (tests use a short one). */
export const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * The states in which this host's loop schedules NOTHING new (DESIGN 4.6 for a pause: "the engine schedules nothing
 * new"; DESIGN 2.5.3's stop table for the others): the two terminal states, the two halted ones, and the four
 * suspended ones. Every one of them is left by a COMMAND — `resume`, `retry`, `approve` — which a controller sends
 * to a freshly spawned host (DESIGN 4.7), never by this loop continuing to run phases. IDLE is deliberately NOT one
 * of them: a run waiting for its own `start` command has work coming and keeps polling.
 */
const NO_SCHEDULING_STATES: ReadonlySet<string> = new Set([...TERMINAL_STATES, ...HALTED_STATES, ...SUSPENDED_STATES]);

/** The `StopReason` that each end state stands for when the run row carries no `stop` of its own — every state of
 * `NO_SCHEDULING_STATES`, mapped through DESIGN 2.5.3's "StopReason / State after" table, read backwards. */
const STOP_OF_END_STATE = {
  COMPLETED: { reason: 'review-clean', resumable: false },
  CANCELLED: { reason: 'cancelled', resumable: false },
  FAILED: { reason: 'internal-error', resumable: true },
  BLOCKED: { reason: 'policy-violation', resumable: true },
  PAUSED: { reason: 'paused', resumable: true },
  WAITING_APPROVAL: { reason: 'approval-required', resumable: true },
  AUTH_REQUIRED: { reason: 'auth-required', resumable: true },
  QUOTA_EXCEEDED: { reason: 'quota-exceeded', resumable: true },
} as const satisfies Readonly<Record<string, { reason: StopReason; resumable: boolean }>>;

async function resolveTableFor(deps: RunEngineDeps, runId: RunId): Promise<TransitionTable | undefined> {
  const run = await deps.store.getRun(runId);
  if (!run) return undefined;
  const looked = deps.resolveTable(run.profile, run.tableVersion);
  return looked.ok ? looked.table : undefined;
}

/** The most recently opened phase that has not yet closed (`status: 'running'`), if any. A well-formed run has at
 * most one open phase at a time. */
function findOpenPhase(runState: RunState): OpenPhase | undefined {
  const phase = [...runState.phases].reverse().find((p) => p.status === 'running');
  if (!phase) return undefined;
  return {
    phaseRunId: phase.phaseRunId,
    state: phase.state,
    iteration: phase.iteration,
    ...(phase.startedAt !== undefined ? { startedAt: phase.startedAt } : {}),
  };
}

/** What `run()` returns once the run reached a state this host schedules nothing from: the `StopRecord` the settling
 * transition recorded on the row, or — for a run that reached the state before this engine existed, or through a
 * path that recorded none — the stop that state stands for. */
function finalStopRecord(runState: RunState): StopRecord {
  if (runState.run.stop) return runState.run.stop;
  const state: string = runState.run.state;
  const known = state in STOP_OF_END_STATE ? STOP_OF_END_STATE[state as keyof typeof STOP_OF_END_STATE] : undefined;
  if (!known) return { reason: 'internal-error', detail: `run is ${state}`, resumable: true };
  return { reason: known.reason, detail: `run is ${state}`, resumable: known.resumable };
}

/**
 * DESIGN 2.8: "Unknown throwables → <nearest class>/unexpected → FAILED + checkpoint.created" — the run host's own
 * `unhandledRejection`/`uncaughtException` handling is apps/cli's (out of this unit's `ownedPaths`); this is the
 * engine's OWN top-level catch around the loop body. Reuses `T26` (`*active -> FAILED`, reason `unexpected-error`,
 * `stop: 'internal-error'`) through the SAME machinery as a global stop when the run is in an active state that row
 * can fire from; falls back to a direct `patchRun` + checkpoint when it cannot (e.g. the throw happened while the
 * run was still IDLE, before any table row could apply). A `conflict/lease-lost` throw is NEVER handled here: this
 * host no longer holds the lease, so any further write would itself be refused (DESIGN 4.2 E0) — it is rethrown
 * unchanged, "exits at once".
 */
async function commitFatal(
  deps: RunEngineDeps,
  runId: RunId,
  host: HostContext,
  lease: LeaseToken,
  thrown: unknown,
): Promise<StopRecord> {
  const info = toErrorInfo(thrown, { code: 'validation/unexpected', class: 'validation' });
  if (info.code === 'conflict/lease-lost') throw thrown;

  const stop: StopRecord = { reason: 'internal-error', detail: info.message, resumable: true };

  try {
    const table = await resolveTableFor(deps, runId);
    if (table) {
      const runState = await deps.store.readRunTree(runId);
      if (runState.run.state !== 'FAILED') {
        const step = nextStep(runState, table);
        const facts = await deps.factCollector.collect(step.guards);
        await settleStop({ deps, runId, host, lease, table, runState, step, facts, stop, checkpointCause: 'fatal' });
        // `settleStop`'s own patch carries `{state, stop, resumeTo?}` (it is reused by every stop, not just a
        // fatal one); this loop's own contribution is `lastError`, recorded right after.
        await deps.store.transact({ runId }, lease, (tx) => tx.patchRun(runId, { lastError: info }));
        return stop;
      }
    }
  } catch {
    // The table has no row for `internal-error` from the current state (or resolving it failed for its own
    // reasons): fall through to the unconditional patch below rather than compound the original failure.
  }

  // No table row could fire (e.g. the run is still IDLE, which no `*active -> FAILED` row covers). The run row still
  // has to say FAILED — but a row that says FAILED over a journal whose last state event says otherwise is a
  // projection every pure reader (DESIGN 4.7, `evolve()`) would get wrong, so the two events DESIGN requires of any
  // failure are written in the SAME transaction: `error` (DESIGN 2.8: "every error has … an `error` event") and
  // `run.state.changed` (DESIGN 4.2: the event of every state change). Nothing is recorded in `transitions`: no row
  // fired, and `recordTransition` is the register of rows that did.
  await deps.store.transact({ runId }, lease, (tx) => {
    const before = tx.run();
    const from = before.state;
    const drafts: EventDraftInput[] = [
      {
        type: 'error',
        // `ErrorInfo` is a (self-referential) `interface`, so it does not satisfy `JsonValue`'s implicit index
        // signature even though the VALUE is genuine JSON — the same static-only limitation `inbox.ts`'s
        // `rejectedDraft` and `packages/core/src/events/index.ts` document. Nothing here mints a `Sealed<T>`.
        payload: { error: info as unknown as EventDraftInput['payload'], fatal: true },
        summary: `fatal: ${info.code}`,
        severity: 'error',
      },
    ];
    if (from !== 'FAILED') {
      const transitionId = deps.ids.next<'TransitionId'>('trn');
      drafts.push({
        type: 'run.state.changed',
        payload: {
          transitionId,
          // No row: the id names the handler that moved the run, and the idempotency key says the same, so neither
          // can ever be mistaken for one of the table's own rows (none of which is named `fatal`).
          defId: 'fatal',
          tableVersion: before.tableVersion,
          from,
          to: 'FAILED',
          reason: 'unexpected-error',
          actor: systemActor(host.hostId),
          guards: [],
          idempotencyKey: transitionIdempotencyKey({
            runId,
            // `RunRecord.profile` is deliberately open (`string`, ADR-0018: the known profiles are validated in
            // TypeScript, not by the store) while the key template types it closed; a stored run's profile is one
            // of them by construction, and this key is informational here — no row is recorded under it.
            profile: before.profile as PipelineProfile,
            tableVersion: before.tableVersion,
            defId: 'fatal',
            discriminator: `fatal:${before.lastSequence}`,
          }),
          stop,
        },
        summary: `fatal: ${from} -> FAILED (${info.code})`,
        severity: 'error',
      });
    }
    deps.events.append(tx, drafts);
    tx.patchRun(runId, { state: 'FAILED', lastError: info, stop });
  });
  await writeCheckpoint({ deps, runId, host, lease, cause: 'fatal' });
  return stop;
}

/** Hands the run lock back. A release that fails changes nothing the caller can act on — the lock row is advisory and
 * a later host takes it over (DESIGN 6.4) — and must never mask the outcome `run()` is about to return. */
async function releaseQuietly(deps: RunEngineDeps, lease: LeaseToken): Promise<void> {
  try {
    await deps.leases.release(lease);
  } catch {
    /* the lease is already gone, or was stolen: nothing to undo */
  }
}

export function createEngine(deps: RunEngineDeps): RunEngine {
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  return {
    async run(runId: RunId, host: HostContext): Promise<StopRecord> {
      // DESIGN 4.4: crash/orphan reconciliation BEFORE this host owns the run. `Resumer` takes the run lease itself
      // (step 3, acquire-or-steal after a liveness check) and step 4 refuses a pin mismatch "BEFORE taking the lease
      // over ... so a pin mismatch must never let this host start acting as the run's owner" — both are meaningless
      // if the loop has already taken the lease. Reversed, the two collided head-on, and the G1 walking skeleton
      // reproduced both halves: on a first run, recovery found the lock its own caller had just taken and refused it
      // as `conflict/run-host-alive`; after a crash it stole the lease out from under the loop that had just taken
      // it, so the next renewal answered `conflict/lease-lost`. `LeaseManager.acquire` then ADOPTS the lock this
      // very host already owns (same hostId/pid/startToken, same fencing token), which is what makes the two calls
      // one ownership. Recovery runs outside the try on purpose: a refusal here means another host is driving the
      // run, and marking it FAILED would be this host's last legitimate act on a run it does not own.
      // Recorded in docs/v3/gates/G1.md (G1-D1); closes docs/v3/requests/U1.09.md R7.
      await deps.resume.recover(runId, host);
      const lease = await deps.leases.acquire({ runId }, runId, 'exclusive', leaseTtlMs);
      deps.onLease?.(lease);
      // "The outer `finally` below has nothing left to do about the lease" — either because this host already handed
      // it back, or because it must never hand it back (a crash).
      let releaseHandled = false;

      try {
        for (;;) {
          if (host.signal.aborted) {
            throw host.signal.reason instanceof Error ? host.signal.reason : new Error('RunEngine.run: aborted');
          }

          // E0
          crashpoint('host.after-lease');
          const renewed = await deps.leases.renew(lease, leaseTtlMs);
          if (!renewed) {
            throw new CohorteError(
              errorOf('conflict/lease-lost', `run ${runId}: lease renewal failed; this host no longer owns it`),
            );
          }

          const table = await resolveTableFor(deps, runId);
          if (!table) {
            throw new CohorteError(
              errorOf(
                'configuration/incompatible-state-schema',
                `run ${runId}: no table for its (profile, tableVersion)`,
              ),
            );
          }

          // E1
          await drainInbox({ deps, runId, host, lease, table });

          const runState = await deps.store.readRunTree(runId);
          // The run reached an end state for this host — terminal, halted or suspended (a `pause` the drain above
          // just applied lands here). Nothing new is scheduled from one: a still-open phase row is NOT re-executed
          // (that is what a `resume` re-enters, with fresh incarnations, DESIGN 4.6), and no phase outcome is
          // resolved against a state no row of the table fires from.
          if (NO_SCHEDULING_STATES.has(runState.run.state)) return finalStopRecord(runState);

          // E3 (narrows the table; also supplies the guard union E2 and E4 both read facts for) + E4
          const step = nextStep(runState, table);
          const facts = await deps.factCollector.collect(step.guards);

          // E2
          const globalStop = deps.checkGlobalStops(runState, facts, deps.loopPolicy);
          if (globalStop) {
            await settleStop({ deps, runId, host, lease, table, runState, step, facts, stop: globalStop });
            return globalStop;
          }

          // Ordinary ("spontaneous") progress: E7 runs the open phase, E3-E5/E6/E8 (transitions.ts) advance past it.
          const openPhase = findOpenPhase(runState);
          if (openPhase) {
            const now = deps.clock.now();
            const ctx = buildPhaseRunContext(runState, openPhase, lease, host.signal, now);
            const outcome = await deps.phases.execute(ctx);
            const stop = await closePhaseAndAdvance({
              deps,
              runId,
              host,
              lease,
              table,
              runState,
              step,
              facts,
              openPhase,
              outcome,
            });
            if (stop) return stop;
            continue;
          }

          // Nothing to do this pass (e.g. IDLE, waiting for a `start` command no host has enqueued yet). A real
          // host polls (DESIGN 4.7: "every 250 ms"); this loop does the same rather than spin.
          await deps.clock.sleep(deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, host.signal);
        }
      } catch (thrown) {
        // Past this line the outer `finally` must NOT hand the lock back, on either branch: a `SimulatedCrash` (or a
        // real `SIGKILL`, which never reaches a catch at all) stands for the process dying RIGHT THERE, so no code
        // after the crash point may run — the fatal commit below, and the release, least of all (DESIGN 4.3); and
        // the ordinary-error branch releases inside its own `finally`, after `commitFatal`.
        //
        // Rethrowing is not enough for the crash: a `finally` runs even when the `catch` around it rethrows, so the
        // outer one below released the lease of a host that is supposed to be gone. The next host then found a FREE
        // run lock and DESIGN 4.3 crash point #2 — "lease held by a dead (pid, startToken)" ⇒ "lease stolen with
        // fencingToken + 1 after a liveness check" — was never exercised by any crash test. Raised by the U1.INT
        // reviewer, recorded in docs/v3/gates/G1.md §4.
        releaseHandled = true;
        if (thrown instanceof SimulatedCrash) throw thrown;
        try {
          if (host.signal.aborted) throw thrown;
          return await commitFatal(deps, runId, host, lease, thrown);
        } finally {
          await releaseQuietly(deps, lease);
        }
      } finally {
        // A normal exit (COMPLETED, CANCELLED, a settled stop) hands the run lock back instead of leaving a row
        // that only a takeover can clear (DESIGN 6.4).
        if (!releaseHandled) await releaseQuietly(deps, lease);
        deps.onLease?.(undefined);
      }
    },
  };
}
