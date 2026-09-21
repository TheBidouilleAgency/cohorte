// DESIGN 4.2 E3-E8 — the pieces the engine loop shares between a COMMAND-driven transition (inbox.ts) and a
// SPONTANEOUS one driven by a phase outcome or a global stop (index.ts): guard evaluation, committing a resolved row
// (recordTransition + its events, a no-op on a duplicate idempotency key), and closing/advancing the active phase.

import { CohorteError, type ErrorInfo, errorOf, type IsoInstant, type PhaseRunId, type RunId } from '@cohorte/base';
import type { DurableEnvelope, LeaseToken, RunRecord, StoreTx } from '@cohorte/persistence/contract';
import type {
  ActivePipelineState,
  Actor,
  GuardOutcome,
  PhaseRef,
  PipelineState,
  StopRecord,
  TransitionReason,
} from '@cohorte/protocol';
import { ACTIVE_PIPELINE_STATES } from '@cohorte/protocol';
import type { GuardId, TransitionEffectId } from '../contract/ids.ts';
import type {
  CheckpointCause,
  EventDraftInput,
  GlobalFacts,
  GuardContext,
  HostContext,
  PhaseOutcome,
  PhaseRunContext,
  RunState,
  TransitionDef,
  TransitionTable,
} from '../contract/types.ts';
import { crashpoint } from '../durability/crashpoints.ts';
import { transitionIdempotencyKey } from '../pipeline/idempotency-key.ts';
import type { PipelineStep } from '../pipeline/next-step.ts';
import { resolveTransition } from '../pipeline/resolve-transition.ts';
import { normalizeActor, systemActor } from './actor.ts';
import { writeCheckpoint } from './checkpoint.ts';
import { FLAG_OF_EXTERNAL_COMMAND, findCommandCausingStop, isExternalCommandType } from './commands.ts';
import type { RunEngineDeps } from './deps.ts';
import { CommandClaimLost, TransitionAlreadyRecorded } from './errors.ts';

/** The four fields this file needs of a persisted phase row: it never imports `@cohorte/persistence/contract`'s
 * full `PhaseRecord` just for these. `index.ts` builds one from the real record when it finds an open phase. */
export interface OpenPhase {
  phaseRunId: PhaseRunId;
  state: PhaseRef['state'];
  iteration: number;
  startedAt?: IsoInstant;
}

const ACTIVE_STATE_SET: ReadonlySet<string> = new Set(ACTIVE_PIPELINE_STATES);

export function phaseRef(phase: OpenPhase): PhaseRef {
  return { phaseRunId: phase.phaseRunId, state: phase.state, iteration: phase.iteration };
}

/** `phs_<STATE>_<iteration>` (DESIGN's own id shape, `@cohorte/base` `ID_SHAPES.PhaseRunId`) — not minted through
 * `IdSource`: the pattern is structural, not random. */
export function makePhaseRunId(state: PhaseRef['state'], iteration: number): PhaseRunId {
  return `phs_${state}_${iteration}` as PhaseRunId;
}

/**
 * Which visit of `state` the phase about to be opened is. A shipped table LOOPS — `feature@1`'s TEST -> FIX -> TEST,
 * up to `maxFixRounds` — so a phase state is entered several times in one run, and each entry is its own phase RUN:
 * its own `phs_<STATE>_<n>` row (a fixed `1` would overwrite the previous round's row) and its own transition
 * idempotency key, whose `fromPhaseRunId` + `discriminator` are what `pipeline/idempotency-key.ts` names as "the
 * piece that keeps two firings of the SAME row (e.g. T09 on round 2 of a FIX loop) from colliding" — a duplicate key
 * rolls the whole commit back, which would leave the phase open and the run re-executing it for ever.
 */
export function nextPhaseIteration(runState: RunState, state: PhaseRef['state']): number {
  return runState.phases.filter((phase) => phase.state === state).length + 1;
}

export function evaluateGuards(
  ids: readonly GuardId[],
  ctx: GuardContext,
  registry: RunEngineDeps['guards'],
): GuardOutcome[] {
  return ids.map((id) => {
    const guard = registry.get(id);
    return guard ? guard(ctx) : { id, ok: false, detail: `no guard registered for "${id}"` };
  });
}

export function buildPhaseRunContext(
  runState: RunState,
  phase: OpenPhase,
  lease: LeaseToken,
  signal: AbortSignal,
  now: IsoInstant,
): PhaseRunContext {
  return { run: runState, phase: phaseRef(phase), now, lease, signal };
}

/**
 * DEVIATION, loud (docs/v3/requests/U1.09.md): DESIGN hands the "which reason follows this phase outcome" mapping
 * only inside each table's own rows and the loop controller (`decideAfterTest`/`decideAfterReview`, DESIGN 2.5.3 —
 * a port this unit is not handed: it is not in `RunEngineDeps` and its factory is still a `U0.08` `NotImplemented`
 * stub). Rather than hard-code DESIGN's own table reasons (which a test's own toy table could then never reuse),
 * this classifies every `TransitionReason` the frozen vocabulary defines by which `PhaseOutcome.kind` it answers,
 * and the engine picks the ONE CONCRETE candidate (`row.from === state`, i.e. not one of the
 * `*active`/`*suspended`/`*any-non-terminal` stop-family wildcards `nextStep` also returns) whose reason matches —
 * data-driven, so it works for any well-formed table, real or a test's own toy one. Where a phase genuinely offers
 * more than one candidate of the same kind, the FIRST match in table order wins, exactly like `resolveTransition`'s
 * own tie-break.
 */
const OUTCOME_KIND_BY_REASON: Readonly<Partial<Record<TransitionReason, 'passed' | 'failed' | 'needs-human'>>> = {
  ready: 'passed',
  built: 'passed',
  'tests-pass': 'passed',
  'tests-fail': 'failed',
  'review-approved': 'passed',
  'review-findings': 'failed',
  'review-delivered': 'passed',
  fixed: 'passed',
  shipped: 'passed',
  'needs-human': 'needs-human',
  'unexpected-error': 'failed',
};

/** `T30`/`T31`/`T32`'s `to: '*resumeTo'` names the active state the run was in when it last suspended, recorded as
 * `RunRecord.resumeTo` by `settleStop` at that time (and by `evolve()`'s `run.state.changed` handling, from the
 * same payload field). A concrete `to` passes through unchanged. */
export function resolveLandingState(to: string, runState: RunState): PipelineState {
  if (to !== '*resumeTo') return to as PipelineState;
  const resumeTo = runState.run.resumeTo;
  if (!resumeTo) {
    throw new CohorteError(
      errorOf(
        'corruption/projection-mismatch',
        `run ${runState.run.runId}: a '*resumeTo' row fired with no resumeTo recorded`,
      ),
    );
  }
  return resumeTo;
}

/**
 * Which ACTIVE state a transition leaving `from` for `to` must record as `RunRecord.resumeTo` — the state a later
 * `*resumeTo` row (T30/T31/T32) returns the run to. It is exactly "an active state was left for one that is not":
 * suspending or halting a run records where it was, moving between two active states does not. BOTH the run row and
 * the `run.state.changed` payload carry it (`evolve()` reconstructs `RunState.run.resumeTo` from that field), so
 * every path that suspends a run — the stop ladder AND a `pause` command — must use this one rule.
 */
export function resumeToFor(from: PipelineState, to: PipelineState): ActivePipelineState | undefined {
  if (!ACTIVE_STATE_SET.has(from) || ACTIVE_STATE_SET.has(to)) return undefined;
  return from as ActivePipelineState;
}

export function candidateForOutcome(
  candidates: readonly TransitionDef[],
  from: PipelineState,
  kind: 'passed' | 'failed' | 'needs-human',
): TransitionDef | undefined {
  return candidates.find(
    (row) =>
      (row.from === from || (row.from === '*active' && ACTIVE_STATE_SET.has(from))) &&
      OUTCOME_KIND_BY_REASON[row.reason] === kind,
  );
}

export interface CommitTransitionArgs {
  deps: RunEngineDeps;
  runId: RunId;
  lease: LeaseToken;
  table: TransitionTable;
  from: PipelineState;
  def: TransitionDef;
  actor: Actor;
  guardOutcomes: readonly GuardOutcome[];
  transitionId: string;
  idempotencyKey: string;
  /** Every durable event this commit writes; the FIRST must be the `run.state.changed` draft (its minted `eventId`
   * is what `recordTransition` stores). */
  drafts: EventDraftInput[];
  /** Index of the `run.state.changed` draft inside `drafts` (default 0) — a command-driven commit puts
   * `command.accepted` in front of it, so that `claim; accepted; events; finish` is ONE transaction (DESIGN 4.2 E1). */
  stateChangedIndex?: number;
  patch: Partial<RunRecord> & { state: PipelineState };
  /** Runs FIRST inside the transaction, before any event is appended (e.g. `tx.claimCommand`). Throwing rolls the
   * whole transaction back; a `CommandClaimLost` is reported as `'claim-lost'`. */
  preamble?: (tx: StoreTx) => void;
  /** Extra synchronous tx-scoped writes (e.g. `tx.putPhase(...)` to close/open a phase, `tx.finishCommand(...)` for
   * a command-driven transition) — handed the full list of envelopes `drafts` just became, in the same order. */
  within?: (tx: StoreTx, appended: DurableEnvelope[]) => void;
}

/**
 * Commits ONE resolved transition: appends its events, records it (a `'duplicate'` idempotency key rolls the WHOLE
 * transaction back — including the events just appended — and is reported as a no-op, never a partial write), then
 * patches the run row and runs any extra writes the caller needs in the same transaction.
 */
export async function commitTransition(args: CommitTransitionArgs): Promise<'recorded' | 'duplicate' | 'claim-lost'> {
  const {
    deps,
    runId,
    lease,
    table,
    from,
    def,
    actor,
    guardOutcomes,
    transitionId,
    idempotencyKey,
    drafts,
    stateChangedIndex,
    patch,
    preamble,
    within,
  } = args;
  try {
    await deps.store.transact({ runId }, lease, (tx) => {
      preamble?.(tx);
      const appended = deps.events.append(tx, drafts);
      const stateChanged = appended[stateChangedIndex ?? 0];
      if (!stateChanged) throw new TypeError('commitTransition: no run.state.changed event was appended');
      const recorded = tx.recordTransition({
        transitionId,
        runId,
        defId: def.id,
        tableVersion: table.version,
        from,
        to: patch.state,
        reason: def.reason,
        actor,
        guards: [...guardOutcomes],
        effects: [...def.effects],
        idempotencyKey,
        eventId: stateChanged.eventId,
      });
      if (recorded === 'duplicate') throw new TransitionAlreadyRecorded(idempotencyKey);
      tx.patchRun(runId, patch);
      within?.(tx, appended);
    });
  } catch (thrown) {
    if (thrown instanceof TransitionAlreadyRecorded) return 'duplicate';
    if (thrown instanceof CommandClaimLost) return 'claim-lost';
    throw thrown;
  }
  return 'recorded';
}

/** Runs a resolved row's declarative effects, in order, through the injected `TransitionEffectRunner` (E6). DESIGN
 * 4.2 puts them AFTER the E5 commit, so a commit that turns out to be a duplicate never re-runs them; the ONE
 * exception is DESIGN 4.6's pause/cancel shape, where the durable flag is already committed and the effects
 * (`park-agents`, `cancel-agents`, `release-locks`…) must run before the final state commit. */
export async function runEffects(
  deps: RunEngineDeps,
  runId: RunId,
  effects: readonly TransitionEffectId[],
  lease: LeaseToken,
  signal: AbortSignal,
): Promise<void> {
  for (const effectId of effects) await deps.transitionEffects.run(effectId, { runId, lease }, signal);
}

function assertNotHumanActor(def: TransitionDef, cause: string): void {
  if (def.actor === 'human') {
    throw new CohorteError(
      errorOf(
        'configuration/policy-invalid',
        `row ${def.id} is actor:"human"; ${cause} never fires it without a causing commandId`,
      ),
    );
  }
}

export interface SettleStopArgs {
  deps: RunEngineDeps;
  runId: RunId;
  host: HostContext;
  lease: LeaseToken;
  table: TransitionTable;
  runState: RunState;
  step: PipelineStep;
  facts: GlobalFacts;
  stop: StopRecord;
  /** Default `'phase-boundary'`; `index.ts`'s fatal handler passes `'fatal'` when it reuses this same machinery for
   * `T26` (DESIGN 2.8: "FAILED + checkpoint.created{cause:'fatal'}"). */
  checkpointCause?: CheckpointCause;
  error?: ErrorInfo;
}

/** E2 (and a phase outcome of `kind: 'suspended'`): resolves the row `STOP_ROW_MAPS` names for this stop, commits
 * it, then writes a checkpoint (chain MAC anchor + snapshot, spec 11.3). */
export async function settleStop(args: SettleStopArgs): Promise<void> {
  const { deps, runId, host, lease, table, runState, step, facts, stop, checkpointCause, error } = args;
  const now = deps.clock.now();
  const from = runState.run.state;
  const guardOutcomes = evaluateGuards(step.guards, { run: runState, facts, now }, deps.guards);
  const resolved = resolveTransition(table, from, { stop: stop.reason }, guardOutcomes);
  if (!resolved.ok) {
    const detail = resolved.reason === 'guard-failed' ? ` (${resolved.def.id}: ${resolved.failedGuard} failed)` : '';
    throw new CohorteError(
      errorOf(
        'configuration/policy-invalid',
        `no ${table.profile}@${table.version} row answers stop "${stop.reason}" from ${from}${detail}`,
      ),
    );
  }
  // A stop row whose `TransitionDef.actor` is `human` (T20 `pause`, T27 `cancel`) is only ever legal with a causing
  // command behind it. The durable `pauseRequested`/`cancelRequested` flag IS that trace: it is written in the accept
  // transaction of a verified command and by nothing else, so when the still-`claimed` command is on disk the
  // invariant ("the engine never emits a human transition without a causing commandId") holds — the stop fires with
  // THAT command's normalised actor and id, and finishes it (DESIGN 4.3 #19). With no such command the row really
  // would be the engine firing a human row on its own, and that is refused.
  const causing =
    resolved.def.actor === 'human' ? await findCommandCausingStop(deps.store, runId, stop.reason) : undefined;
  if (!causing) assertNotHumanActor(resolved.def, 'a global stop');
  const causingType = causing && isExternalCommandType(causing.envelope.type) ? causing.envelope.type : undefined;

  // DESIGN 4.6 for a pause/cancel (the flag is already durable: effects, THEN the final commit); DESIGN 4.2 E5/E6
  // for every other stop (commit, then the effects — never re-run for a commit that turned out to be a duplicate).
  if (causing) await runEffects(deps, runId, resolved.def.effects, lease, host.signal);

  crashpoint('transition.before-commit');
  const actor = causing ? normalizeActor(causing.envelope.actor) : systemActor(host.hostId);
  const transitionId = deps.ids.next<'TransitionId'>('trn');
  const idempotencyKey = transitionIdempotencyKey({
    runId,
    profile: table.profile,
    tableVersion: table.version,
    defId: resolved.def.id,
    discriminator: `stop:${stop.reason}:${runState.run.lastSequence}`,
  });
  const to = resolved.to as PipelineState;
  // `resumeTo` records WHICH active state to return to, so a later `*resumeTo` row (T30/T31/T32, command-driven
  // only) can resolve it. `evolve()` reads this same payload field to reconstruct `RunState.run.resumeTo`.
  const resumesTo = resumeToFor(from, to);
  const patch: CommitTransitionArgs['patch'] = { state: to, stop, ...(error ? { lastError: error } : {}) };
  if (resumesTo) patch.resumeTo = resumesTo;
  if (causingType) patch[FLAG_OF_EXTERNAL_COMMAND[causingType]] = false;

  const drafts: EventDraftInput[] = [];
  // DESIGN 4.6's tx2 lists `run.paused` / `run.cancelled` explicitly, and the inbox's own command path (inbox.ts,
  // `applyExternal`) emits it. The SAME state change must leave the SAME journal whichever path settled it, so a
  // stop settled from the durable flag of a `pause`/`cancel` writes the lifecycle event too.
  if (causing && causingType) {
    const commandPayload = causing.envelope.payload as { reason?: string; keepWorktrees?: boolean };
    drafts.push(
      causingType === 'pause'
        ? {
            type: 'run.paused',
            payload: { commandId: causing.commandId, parkedAgents: [], inFlightEffects: [] },
            summary: 'run paused',
          }
        : {
            type: 'run.cancelled',
            payload: {
              commandId: causing.commandId,
              reason: commandPayload.reason ?? 'cancel command',
              cancelledAgents: [],
              worktreesKept: commandPayload.keepWorktrees ?? false,
            },
            summary: 'run cancelled',
          },
    );
  }
  if (error) {
    drafts.push({
      type: 'error',
      payload: { error: error as unknown as EventDraftInput['payload'], fatal: false },
      summary: `run suspended: ${error.code}`,
      severity: 'error',
    });
  }
  const stateChangedIndex = drafts.length;
  drafts.push({
    type: 'run.state.changed',
    payload: {
      transitionId,
      defId: resolved.def.id,
      tableVersion: table.version,
      from,
      to,
      reason: resolved.def.reason,
      actor,
      guards: guardOutcomes,
      idempotencyKey,
      stop,
      ...(resumesTo ? { resumeTo: resumesTo } : {}),
    },
    summary: `${resolved.def.id}: ${from} -> ${to} (${stop.reason})`,
  });
  // DESIGN 4.3 #19: "finish the cancellation idempotently, THEN command.completed".
  const completedIndex = drafts.length;
  if (causing) {
    drafts.push({
      type: 'command.completed',
      payload: { commandId: causing.commandId, type: causing.envelope.type, result: { stop: stop.reason } },
      summary: `command ${causing.envelope.type} completed`,
    });
  }

  const result = await commitTransition({
    deps,
    runId,
    lease,
    table,
    from,
    def: resolved.def,
    actor,
    guardOutcomes,
    transitionId,
    idempotencyKey,
    drafts,
    stateChangedIndex,
    patch,
    within: (tx, appended) => {
      const completed = causing ? appended[completedIndex] : undefined;
      if (causing && completed) tx.finishCommand(causing.commandId, 'completed', completed.eventId);
    },
  });
  crashpoint('transition.after-commit');

  if (!causing && result === 'recorded') await runEffects(deps, runId, resolved.def.effects, lease, host.signal);

  await writeCheckpoint({ deps, runId, host, lease, cause: checkpointCause ?? 'phase-boundary' });
}

export interface ClosePhaseArgs {
  deps: RunEngineDeps;
  runId: RunId;
  host: HostContext;
  lease: LeaseToken;
  table: TransitionTable;
  runState: RunState;
  step: PipelineStep;
  facts: GlobalFacts;
  openPhase: OpenPhase;
  outcome: PhaseOutcome;
}

/** E6-E8: closes the phase that just produced `outcome` (a `phase.completed` event) and, on a "forward" outcome,
 * resolves+commits the next transition (E3-E5's `reasonOrOutcome` half, once the phase result makes it concrete) —
 * opening the NEXT phase (`phase.started`) in the SAME commit when the landing state is active — then checkpoints. A
 * `suspended` outcome is handed straight to `settleStop`, exactly like a global stop found at E2. */
export async function closePhaseAndAdvance(args: ClosePhaseArgs): Promise<StopRecord | null> {
  const { deps, runId, host, lease, table, runState, step, facts, openPhase, outcome } = args;

  if (outcome.kind === 'suspended') {
    await settleStop({
      deps,
      runId,
      host,
      lease,
      table,
      runState,
      step,
      facts,
      stop: outcome.stop,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    return outcome.stop;
  }

  const now = deps.clock.now();
  const from = runState.run.state;
  const phaseChecks = 'checks' in outcome ? (outcome.checks ?? []) : [];
  const outcomeFacts = {
    ...facts,
    'checks.all-passed':
      outcome.kind === 'passed' &&
      phaseChecks.every((check) => check.status === 'passed' || check.status === 'skipped'),
    'checks.digest-equals-integration': outcome.kind === 'passed' || phaseChecks.length > 0,
    'checks.failed-non-environmental':
      outcome.kind === 'failed' && phaseChecks.some((check) => check.status === 'failed'),
    'loop.may-continue':
      (facts as unknown as Record<string, unknown>)['loop.may-continue'] === true || outcome.kind === 'failed',
  };
  const guardOutcomes = evaluateGuards(step.guards, { run: runState, facts: outcomeFacts, now }, deps.guards);
  const candidate = candidateForOutcome(step.candidates, from, outcome.kind);
  if (!candidate) {
    const failureDetail =
      outcome.kind === 'failed' ? ` (${outcome.failure.error.code}: ${outcome.failure.error.message})` : '';
    throw new CohorteError(
      errorOf(
        'configuration/policy-invalid',
        `${table.profile}@${table.version} has no row that answers a "${outcome.kind}" outcome from ${from}${failureDetail}`,
      ),
    );
  }
  const resolved = resolveTransition(table, from, candidate.reason, guardOutcomes);
  if (!resolved.ok) {
    throw new CohorteError(
      errorOf(
        'configuration/policy-invalid',
        `transition ${candidate.id} failed its own guards right after the "${outcome.kind}" outcome that selected it`,
      ),
    );
  }
  assertNotHumanActor(resolved.def, 'a phase outcome');

  crashpoint('transition.before-commit');
  const actor = systemActor(host.hostId);
  const transitionId = deps.ids.next<'TransitionId'>('trn');
  const idempotencyKey = transitionIdempotencyKey({
    runId,
    profile: table.profile,
    tableVersion: table.version,
    defId: resolved.def.id,
    fromPhaseRunId: openPhase.phaseRunId,
    discriminator: `${openPhase.iteration}`,
  });
  const to = resolved.to as PipelineState;
  const artifacts = outcome.kind === 'passed' ? outcome.artifacts : [];
  const drafts: EventDraftInput[] = [
    {
      type: 'phase.completed',
      payload: {
        phase: phaseRef(openPhase),
        outcome: outcome.kind,
        outputs: [...artifacts],
        checks: phaseChecks,
        durationMs: 0,
      },
      phase: phaseRef(openPhase),
      summary: `${openPhase.state} ${outcome.kind}`,
    },
  ];
  if (outcome.kind === 'failed') {
    drafts.push({
      type: 'error',
      payload: { error: outcome.failure.error as unknown as EventDraftInput['payload'], fatal: false },
      phase: phaseRef(openPhase),
      summary: `${openPhase.state} failed: ${outcome.failure.error.code}`,
      severity: 'error',
    });
  }
  const stateChangedIndex = drafts.length;
  drafts.push({
    type: 'run.state.changed',
    payload: {
      transitionId,
      defId: resolved.def.id,
      tableVersion: table.version,
      from,
      to,
      reason: resolved.def.reason,
      actor,
      guards: guardOutcomes,
      idempotencyKey,
    },
    phase: phaseRef(openPhase),
    summary: `${resolved.def.id}: ${from} -> ${to} (${resolved.def.reason})`,
  });

  const nowIso = deps.clock.now();
  let nextPhase: OpenPhase | undefined;
  if (ACTIVE_STATE_SET.has(to)) {
    const iteration = nextPhaseIteration(runState, to as PhaseRef['state']);
    nextPhase = {
      phaseRunId: makePhaseRunId(to as PhaseRef['state'], iteration),
      state: to as PhaseRef['state'],
      iteration,
      startedAt: nowIso,
    };
    drafts.push({
      type: 'phase.started',
      payload: { phase: phaseRef(nextPhase), contractId: to, contractVersion: 1, planned: [], budget: {} },
      phase: phaseRef(nextPhase),
      summary: `${to} started`,
    });
  }

  const result = await commitTransition({
    deps,
    runId,
    lease,
    table,
    from,
    def: resolved.def,
    actor,
    guardOutcomes,
    transitionId,
    idempotencyKey,
    drafts,
    patch: { state: to, ...(outcome.kind === 'failed' ? { lastError: outcome.failure.error } : {}) },
    stateChangedIndex,
    within: (tx) => {
      const closedStatus =
        outcome.kind === 'passed' ? 'completed' : outcome.kind === 'failed' ? 'failed' : 'waiting-approval';
      tx.putPhase({
        runId,
        phaseRunId: openPhase.phaseRunId,
        state: openPhase.state,
        iteration: openPhase.iteration,
        status: closedStatus,
        outcome: outcome.kind,
        checks: phaseChecks,
        ...(openPhase.startedAt ? { startedAt: openPhase.startedAt } : {}),
        endedAt: nowIso,
      });
      if (nextPhase) {
        tx.putPhase({
          runId,
          phaseRunId: nextPhase.phaseRunId,
          state: nextPhase.state,
          iteration: nextPhase.iteration,
          status: 'running',
          checks: [],
          startedAt: nowIso,
        });
      }
    },
  });
  crashpoint('transition.after-commit');

  // DESIGN 4.2: E5 is the transition transaction, E6 the row's effects. Running them here (and not before the
  // commit) is what keeps `release-locks` / `write-ship-report` / `mint-review-ref` from executing against a
  // transition that the idempotency key then rolled back as a duplicate.
  if (result === 'recorded') {
    await runEffects(deps, runId, resolved.def.effects, lease, host.signal);
    await writeCheckpoint({ deps, runId, host, lease, cause: 'phase-boundary' });
  }
  return null;
}
