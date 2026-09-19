// DESIGN 4.2 E1 — drain the command inbox: verify the MAC BEFORE anything else touches the command, normalise the
// actor, then apply the command x state matrix (`pipeline/command-matrix.ts`, frozen, `U0.09`) or, for `start`
// (outside that matrix's scope — DESIGN 2.5.1's table does not carry run creation), resolve `IDLE -> ... , 'start'`
// directly.
//
// Shape (DESIGN 4.2 E1 verbatim): "per command ONE tx { claimCommand ; command.accepted ; events of the command ;
// finishCommand ; command.completed|rejected } (commands with external effects — cancel, shutdown — use two tx)".
// So every command is PLANNED first — reads only, no write — and then applied in a single transaction; only `pause`
// and `cancel`, whose effects (`park-agents`, `cancel-agents`, `release-locks`) must run between the durable flag and
// the final state (DESIGN 4.6), take the two-transaction path, with `command.external.after-accepted` (DESIGN 4.3
// #19) as the crash point in between and `drainInbox`'s own recovery closing that window.
import type { ApprovalId, CommandId, EventId, IsoInstant, RunId, Sha256 } from '@cohorte/base';
import type {
  ApprovalRecord,
  ApprovalStatus,
  CommandRecord,
  LeaseToken,
  RunRecord,
} from '@cohorte/persistence/contract';
import {
  ACTIVE_PIPELINE_STATES,
  type ActivePipelineState,
  type Actor,
  type CommandEnvelope,
  type CommandType,
  canonicalCommandBody,
  type GuardOutcome,
  type PipelineState,
  type RunPlan,
  type StopRecord,
} from '@cohorte/protocol';
import type { EventDraftInput, HostContext, RunState, TransitionDef, TransitionTable } from '../contract/types.ts';
import { crashpoint } from '../durability/crashpoints.ts';
import { commandMatrixCell, MATRIX_COMMANDS, type MatrixCommand, skipDefIdFor } from '../pipeline/command-matrix.ts';
import { transitionIdempotencyKey } from '../pipeline/idempotency-key.ts';
import { nextStep } from '../pipeline/next-step.ts';
import { resolveTransition } from '../pipeline/resolve-transition.ts';
import { normalizeActor } from './actor.ts';
import { writeCheckpoint } from './checkpoint.ts';
import {
  type ExternalCommandType,
  findClaimedExternalCommands,
  isExternalCommandType,
  STOP_OF_EXTERNAL_COMMAND,
} from './commands.ts';
import type { RunEngineDeps } from './deps.ts';
import { CommandClaimLost, errorInfoForCode } from './errors.ts';
import {
  commitTransition,
  evaluateGuards,
  makePhaseRunId,
  nextPhaseIteration,
  type OpenPhase,
  phaseRef,
  resolveLandingState,
  resumeToFor,
  runEffects,
} from './transitions.ts';

const ACTIVE_STATE_SET: ReadonlySet<string> = new Set(ACTIVE_PIPELINE_STATES);

export interface InboxEnv {
  deps: RunEngineDeps;
  runId: RunId;
  host: HostContext;
  lease: LeaseToken;
  table: TransitionTable;
}

function isMatrixCommand(type: CommandType): type is MatrixCommand {
  return (MATRIX_COMMANDS as readonly string[]).includes(type);
}

function acceptedDraft(envelope: CommandEnvelope, actor: Actor): EventDraftInput {
  return {
    type: 'command.accepted',
    payload: {
      commandId: envelope.commandId,
      type: envelope.type,
      actor,
      authVerified: true,
      scheme: envelope.auth?.scheme ?? 'hmac-sha256',
    },
    summary: `command ${envelope.type} accepted`,
  };
}

function rejectedDraft(
  envelope: Pick<CommandEnvelope, 'commandId' | 'type'>,
  info: ReturnType<typeof errorInfoForCode>,
): EventDraftInput {
  // `ErrorInfo` is a (self-referential) `interface`, so it does not itself satisfy `T extends JsonValue`'s implicit
  // index signature (the same limitation `packages/core/src/events/index.ts` documents) — the value is genuine JSON,
  // only the STATIC type needs the cast; nothing here mints a `Sealed<T>` (check-layers rule f is unaffected).
  const payload = {
    commandId: envelope.commandId,
    type: envelope.type,
    error: info,
  } as unknown as EventDraftInput['payload'];
  return {
    type: 'command.rejected',
    payload,
    summary: `command ${envelope.type} rejected: ${info.code}`,
    severity: 'warning',
  };
}

function completedDraft(envelope: Pick<CommandEnvelope, 'commandId' | 'type'>, result: unknown): EventDraftInput {
  return {
    type: 'command.completed',
    payload: { commandId: envelope.commandId, type: envelope.type, result: result as EventDraftInput['payload'] },
    summary: `command ${envelope.type} completed`,
  };
}

function verifyAuth(deps: RunEngineDeps, envelope: CommandEnvelope): boolean {
  const auth = envelope.auth;
  // An unknown `auth.scheme` is rejected like a bad value (deliverable text): only the ONE scheme this engine's
  // `CommandAuthenticator` speaks is ever accepted.
  if (!auth || auth.scheme !== deps.authenticator.scheme) return false;
  const body = canonicalCommandBody(envelope);
  return deps.authenticator.verify(body, auth.value, deps.projectKey);
}

// ── planning: reads only; nothing below writes until `applyPlan` ────────────────────────────────────────────────

/** What the matrix (or `start`) decided this command does, computed before ANY transaction opens so the whole
 * outcome can then be written at once. */
type CommandPlan =
  | { kind: 'simple'; outcome: 'completed' | 'rejected'; draft: EventDraftInput }
  | {
      kind: 'transition';
      def: TransitionDef;
      to: string;
      runState: RunState;
      guardOutcomes: GuardOutcome[];
      extraPatch?: Partial<RunRecord>;
    }
  | {
      kind: 'external';
      type: ExternalCommandType;
      def: TransitionDef;
      to: string;
      runState: RunState;
      guardOutcomes: GuardOutcome[];
    }
  | {
      kind: 'approval';
      approval: ApprovalRecord;
      decision: Exclude<ApprovalStatus, 'pending'>;
      note?: string;
      mayTransition?: string;
      pendingBefore: ApprovalRecord[];
    };

function rejectPlan(envelope: CommandEnvelope, code: string, message: string): CommandPlan {
  return { kind: 'simple', outcome: 'rejected', draft: rejectedDraft(envelope, errorInfoForCode(code, message)) };
}

function completePlan(envelope: CommandEnvelope, result: unknown): CommandPlan {
  return { kind: 'simple', outcome: 'completed', draft: completedDraft(envelope, result) };
}

/** Reads the run tree and evaluates the guards of `ids` against freshly collected facts. */
async function guardsFor(
  deps: RunEngineDeps,
  runId: RunId,
  ids: readonly Parameters<RunEngineDeps['factCollector']['collect']>[0][number][],
): Promise<{ runState: RunState; guardOutcomes: GuardOutcome[] }> {
  const runState = await deps.store.readRunTree(runId);
  const now = deps.clock.now();
  const facts = await deps.factCollector.collect(ids);
  return { runState, guardOutcomes: evaluateGuards(ids, { run: runState, facts, now }, deps.guards) };
}

async function planStart(env: InboxEnv, envelope: CommandEnvelope, run: RunRecord): Promise<CommandPlan> {
  const { deps, runId, table } = env;
  if (run.state !== 'IDLE') {
    return rejectPlan(envelope, 'conflict/run-active', `start: run ${runId} is not IDLE (currently ${run.state})`);
  }
  const probe = await deps.store.readRunTree(runId);
  const step = nextStep(probe, table);
  const { runState, guardOutcomes } = await guardsFor(deps, runId, step.guards);
  const resolved = resolveTransition(table, 'IDLE', 'start', guardOutcomes);
  if (!resolved.ok) {
    const detail =
      resolved.reason === 'guard-failed'
        ? `${resolved.def.id}: guard "${resolved.failedGuard}" failed`
        : 'no row of this table starts from IDLE';
    return rejectPlan(envelope, 'configuration/policy-invalid', `start: ${detail}`);
  }
  return {
    kind: 'transition',
    def: resolved.def,
    to: resolved.to,
    runState,
    guardOutcomes,
    extraPatch: deps.startColumns ? await deps.startColumns(run) : hostComputedColumnsForStart(),
  };
}

/**
 * `StateStore.transact` refuses a run leaving `IDLE` (or `CANCELLED`/`FAILED`) without its six host-computed
 * columns set (persistence's own invariant, `HOST_COMPUTED_RUN_KEYS` / `STATES_WITHOUT_HOST_COLUMNS`) — DESIGN's
 * real `T04` (`create-integration-branch` on `IDLE -> PREFLIGHT`) sets them from a captured `RunSnapshotManifest`
 * (`RunSnapshotter`, a different port this unit is not handed). A toy table's own `start` row leaves IDLE the same
 * way, so it needs SOMETHING in each column; these are honest, clearly-fake placeholders, never read as real
 * snapshot/runtime data by anything this unit owns (deviation, docs/v3/requests/U1.09.md).
 */
export function hostComputedColumnsForStart(): Partial<RunRecord> {
  return {
    snapshotDigest: '0'.repeat(64) as Sha256,
    runtimePin: {},
    plan: {
      profile: 'feature',
      runtime: { id: 'fake', version: '0.0.0' },
      trust: { policySha256: '0'.repeat(64) as never, loosenedKeys: [], grantedBy: 'none-needed' },
      models: [],
      apiBillingEnabled: false,
      meteredProviders: [],
      sandbox: { level: 'L0-process', backend: 'none', filesystem: 'advisory', network: 'unenforced' },
      sandboxRequire: 'best-effort',
      brainIsolation: 'process',
      budgets: { run: {}, perPhase: {}, perAgent: {}, perProvider: {}, perTool: {} },
      network: { provisioning: false },
      promptOverrides: [],
      unattended: true,
    } as RunPlan,
    baseSha: '0'.repeat(40),
    integrationBranch: 'cohorte/toy-integration',
    zones: [],
  };
}

/** A resolved row, or the rejection that explains why it could not be resolved. */
function transitionPlan(
  envelope: CommandEnvelope,
  type: string,
  def: TransitionDef,
  from: PipelineState,
  table: TransitionTable,
  runState: RunState,
  guardOutcomes: GuardOutcome[],
): CommandPlan {
  const resolved = resolveTransition(table, from, def.reason, guardOutcomes);
  if (!resolved.ok || resolved.def.id !== def.id) {
    const detail = resolved.ok
      ? `resolved to ${resolved.def.id} instead of ${def.id}`
      : resolved.reason === 'guard-failed'
        ? `guard "${resolved.failedGuard}" failed`
        : 'no matching row';
    return rejectPlan(envelope, 'configuration/policy-invalid', `${type}: ${detail}`);
  }
  if (isExternalCommandType(envelope.type)) {
    return { kind: 'external', type: envelope.type, def: resolved.def, to: resolved.to, runState, guardOutcomes };
  }
  return { kind: 'transition', def: resolved.def, to: resolved.to, runState, guardOutcomes };
}

async function planMatrixCommand(env: InboxEnv, envelope: CommandEnvelope, run: RunRecord): Promise<CommandPlan> {
  const { deps, runId, table } = env;
  const type = envelope.type as MatrixCommand;
  const cell = commandMatrixCell(type, run.state);

  switch (cell.kind) {
    case 'reject':
      return rejectPlan(envelope, cell.code, cell.message);
    case 'noop':
      return completePlan(envelope, { noop: true });
    case 'spawns-host':
      // DESIGN: "wakes a detached host to drain it" — this engine IS already the host draining the inbox, so
      // waking one is moot; complete as a no-op (deviation, docs/v3/requests/U1.09.md).
      return completePlan(envelope, { noop: true });
    case 'transition-per-phase': {
      // `skip`'s row is minted per phase (`skipDefIdFor`, U0.09): resolve it at the effective phase — `run.state`
      // if active, else `run.resumeTo` (DESIGN 2.5.1's "T33 if policy (on `resumeTo`)") — never a literal id.
      const effectivePhase = ACTIVE_STATE_SET.has(run.state) ? (run.state as ActivePipelineState) : run.resumeTo;
      if (!effectivePhase) {
        return rejectPlan(envelope, 'configuration/policy-invalid', `${type}: no phase to skip from ${run.state}`);
      }
      const def = table.rows.find((row) => row.id === skipDefIdFor(effectivePhase));
      if (!def) {
        return rejectPlan(
          envelope,
          'configuration/policy-invalid',
          `${type}: ${effectivePhase} is not skippable in ${table.profile}@${table.version}`,
        );
      }
      // NOT `nextStep(runState, table)`: that narrows by `run.state` (e.g. `PAUSED`), and a skip fired "on
      // resumeTo" resolves a row whose `from` is the DIFFERENT effective phase — `def.preconditions` directly is
      // the right (and only) guard set to gather facts for and evaluate here.
      const { runState, guardOutcomes } = await guardsFor(deps, runId, def.preconditions);
      return transitionPlan(envelope, type, def, effectivePhase, table, runState, guardOutcomes);
    }
    case 'transition': {
      const def = table.rows.find((row) => row.id === cell.defId);
      if (!def) {
        return rejectPlan(
          envelope,
          'configuration/policy-invalid',
          `${type}: table ${table.profile}@${table.version} has no row "${cell.defId}"`,
        );
      }
      const probe = await deps.store.readRunTree(runId);
      const step = nextStep(probe, table);
      const { runState, guardOutcomes } = await guardsFor(deps, runId, step.guards);
      return transitionPlan(envelope, type, def, run.state, table, runState, guardOutcomes);
    }
    case 'applies':
      return planApprovalDecision(env, envelope, cell.mayTransition);
  }
}

/** `approve` / `deny`: resolves the stored approval directly through `StoreTx` (DESIGN 2.5's `ApprovalService` is a
 * separate port this unit is not handed; the record-level resolution `StoreTx.resolveApproval` already gives is
 * enough for a skeleton — deviation, docs/v3/requests/U1.09.md). */
async function planApprovalDecision(
  env: InboxEnv,
  envelope: CommandEnvelope,
  mayTransition: string | undefined,
): Promise<CommandPlan> {
  const { deps, runId } = env;
  const payload = envelope.payload as { approvalId: ApprovalId; scope?: 'once' | 'run'; note?: string };
  const decision: Exclude<ApprovalStatus, 'pending'> =
    envelope.type === 'approve' ? (payload.scope === 'run' ? 'allow-for-run' : 'allow-once') : 'deny';

  const before = await deps.store.readRunTree(runId);
  const target = before.approvals.find((a) => a.approvalId === payload.approvalId);
  if (target?.status !== 'pending') {
    return rejectPlan(
      envelope,
      'conflict/unexpected',
      `${envelope.type}: approval ${payload.approvalId} is not pending`,
    );
  }
  const plan: CommandPlan = {
    kind: 'approval',
    approval: target,
    decision,
    pendingBefore: before.approvals.filter((a) => a.status === 'pending'),
  };
  if (payload.note !== undefined) plan.note = payload.note;
  if (mayTransition !== undefined) plan.mayTransition = mayTransition;
  return plan;
}

// ── applying: one transaction, except for `pause`/`cancel` ─────────────────────────────────────────────────────

function claimPreamble(commandId: CommandId, hostId: string) {
  return (tx: { claimCommand(id: CommandId, hostId: string): boolean }): void => {
    if (!tx.claimCommand(commandId, hostId)) throw new CommandClaimLost(commandId);
  };
}

/** The ONE transaction of DESIGN 4.2 E1 for a command that neither transitions nor has an external effect:
 * `{ claimCommand ; command.accepted ; command.completed|rejected ; finishCommand }`. */
async function applySimple(
  env: InboxEnv,
  envelope: CommandEnvelope,
  actor: Actor,
  outcome: 'completed' | 'rejected',
  draft: EventDraftInput,
): Promise<void> {
  const { deps, runId, host, lease } = env;
  await deps.store.transact({ runId }, lease, (tx) => {
    if (!tx.claimCommand(envelope.commandId, host.hostId)) return;
    const appended = deps.events.append(tx, [acceptedDraft(envelope, actor), draft]);
    const result = appended[1];
    tx.finishCommand(envelope.commandId, outcome, result ? result.eventId : ('' as EventId));
  });
}

interface TransitionCommit {
  transitionId: string;
  idempotencyKey: string;
  toState: PipelineState;
  patch: Partial<RunRecord> & { state: PipelineState };
  stateChangedDraft: EventDraftInput;
  nextPhase?: OpenPhase;
  phaseStartedDraft?: EventDraftInput;
  startedAt: IsoInstant;
}

/** The shared arithmetic of a COMMAND-driven transition: its idempotency key, landing state, `resumeTo`, the
 * `run.state.changed` draft, and the `phase.started` that opens the next phase when the landing state is active. */
function prepareTransition(
  env: InboxEnv,
  envelope: CommandEnvelope,
  actor: Actor,
  def: TransitionDef,
  to: string,
  runState: RunState,
  guardOutcomes: GuardOutcome[],
  extraPatch: Partial<RunRecord>,
  /** Set by a command that SUSPENDS or halts the run (`pause`, `cancel`): the run row and the `run.state.changed`
   * payload both carry it, exactly as the stop ladder's own `settleStop` writes it, so `RunState.run.stop` says the
   * same thing whether it is read from the row or replayed through `evolve()`. */
  stop?: StopRecord,
): TransitionCommit {
  const { deps, runId, table } = env;
  const transitionId = deps.ids.next<'TransitionId'>('trn');
  const idempotencyKey = transitionIdempotencyKey({
    runId,
    profile: table.profile,
    tableVersion: table.version,
    defId: def.id,
    discriminator: envelope.commandId,
  });
  const from = runState.run.state;
  const toState = resolveLandingState(to, runState);
  const patch: Partial<RunRecord> & { state: PipelineState } = { ...extraPatch, state: toState };
  if (stop) patch.stop = stop;
  // DESIGN 2.5.1: a `*resumeTo` row can only resolve what the transition that suspended the run recorded. A `pause`
  // command is the ONLY way a run is ever PAUSED, so this path — not just the stop ladder — must record it.
  const resumesTo = resumeToFor(from, toState);
  if (resumesTo) patch.resumeTo = resumesTo;

  const startedAt = deps.clock.now();
  const commit: TransitionCommit = {
    transitionId,
    idempotencyKey,
    toState,
    patch,
    startedAt,
    stateChangedDraft: {
      type: 'run.state.changed',
      payload: {
        transitionId,
        defId: def.id,
        tableVersion: table.version,
        from,
        to: toState,
        reason: def.reason,
        actor,
        guards: guardOutcomes,
        idempotencyKey,
        ...(resumesTo ? { resumeTo: resumesTo } : {}),
        ...(stop ? { stop } : {}),
      },
      summary: `${def.id}: ${from} -> ${toState} (${def.reason})`,
    },
  };

  // A command-driven transition (e.g. `start`, T04-like) can land on an active state exactly like a phase-outcome
  // one does (transitions.ts's `closePhaseAndAdvance`): open its phase here too, so the engine's next pass finds it.
  if (ACTIVE_STATE_SET.has(toState)) {
    const activeState = toState as ActivePipelineState;
    const iteration = nextPhaseIteration(runState, activeState);
    const phase: OpenPhase = {
      phaseRunId: makePhaseRunId(activeState, iteration),
      state: activeState,
      iteration,
      startedAt,
    };
    commit.nextPhase = phase;
    commit.phaseStartedDraft = {
      type: 'phase.started',
      payload: { phase: phaseRef(phase), contractId: toState, contractVersion: 1, planned: [], budget: {} },
      phase: phaseRef(phase),
      summary: `${toState} started`,
    };
  }
  return commit;
}

/** ONE transaction: `{ claimCommand ; command.accepted ; run.state.changed (+ phase.started) ; recordTransition ;
 * patchRun ; command.completed ; finishCommand }`. The row's declarative effects run AFTER it (DESIGN 4.2 E5 then
 * E6) and never at all for a commit the idempotency key rejected as a duplicate. */
async function applyTransition(
  env: InboxEnv,
  envelope: CommandEnvelope,
  actor: Actor,
  plan: Extract<CommandPlan, { kind: 'transition' }>,
): Promise<void> {
  const { deps, runId, host, lease, table } = env;
  const commit = prepareTransition(
    env,
    envelope,
    actor,
    plan.def,
    plan.to,
    plan.runState,
    plan.guardOutcomes,
    plan.extraPatch ?? {},
  );

  const drafts: EventDraftInput[] = [acceptedDraft(envelope, actor), commit.stateChangedDraft];
  if (commit.phaseStartedDraft) drafts.push(commit.phaseStartedDraft);
  const completedIndex = drafts.length;
  drafts.push(completedDraft(envelope, { runId }));

  const result = await commitTransition({
    deps,
    runId,
    lease,
    table,
    from: plan.runState.run.state,
    def: plan.def,
    actor,
    guardOutcomes: plan.guardOutcomes,
    transitionId: commit.transitionId,
    idempotencyKey: commit.idempotencyKey,
    drafts,
    stateChangedIndex: 1,
    patch: commit.patch,
    preamble: claimPreamble(envelope.commandId, host.hostId),
    within: (tx, appended) => {
      const phase = commit.nextPhase;
      if (phase) {
        tx.putPhase({
          runId,
          phaseRunId: phase.phaseRunId,
          state: phase.state,
          iteration: phase.iteration,
          status: 'running',
          checks: [],
          startedAt: commit.startedAt,
        });
      }
      const completed = appended[completedIndex];
      if (completed) tx.finishCommand(envelope.commandId, 'completed', completed.eventId);
    },
  });

  if (result === 'claim-lost') return;
  if (result === 'duplicate') {
    // The row was already recorded under this command's own key: the command's effect is on disk, so the command is
    // complete. Finishing it here is what stops the drain from re-reading it for ever.
    await applySimple(env, envelope, actor, 'completed', completedDraft(envelope, { noop: true }));
    return;
  }
  await runEffects(deps, runId, plan.def.effects, lease, host.signal);
}

/**
 * DESIGN 4.6 / 4.2 E1 "commands with external effects use two tx": tx1 `{ claimCommand ; command.accepted ; the
 * durable flag }`, then the row's effects, then tx2 `{ run.paused|run.cancelled ; run.state.changed ; the flag
 * cleared ; command.completed ; finishCommand }` and the checkpoint. `alreadyAccepted` re-enters at the effects for
 * a command whose host died at `command.external.after-accepted` (DESIGN 4.3 #19).
 */
async function applyExternal(
  env: InboxEnv,
  envelope: CommandEnvelope,
  actor: Actor,
  plan: Extract<CommandPlan, { kind: 'external' }>,
  alreadyAccepted: boolean,
): Promise<void> {
  const { deps, runId, host, lease, table } = env;

  if (!alreadyAccepted) {
    const accepted = await deps.store.transact({ runId }, lease, (tx) => {
      if (!tx.claimCommand(envelope.commandId, host.hostId)) return null;
      tx.patchRun(runId, plan.type === 'pause' ? { pauseRequested: true } : { cancelRequested: true });
      return deps.events.append(tx, [acceptedDraft(envelope, actor)])[0] ?? null;
    });
    if (!accepted) return; // raced with another host's claim on this command
    // DESIGN 4.3 #19: the durable flag is committed BEFORE this point; a crash here leaves it set, and the next
    // drain (`drainInbox`'s own recovery) finishes the command from exactly here.
    crashpoint('command.external.after-accepted');
  }

  await runEffects(deps, runId, plan.def.effects, lease, host.signal);

  crashpoint('transition.before-commit');
  const cancelPayload = envelope.payload as { reason?: string; keepWorktrees?: boolean };
  // DESIGN 2.5.3's stop table read backwards: PAUSED is what `paused` leaves behind, CANCELLED what `cancelled`
  // does. Recording it is what lets `run()` answer with the real `StopRecord` when it finds the run suspended, and
  // what keeps the row's `stop` and the journal's agreeing.
  const stop: StopRecord = {
    reason: STOP_OF_EXTERNAL_COMMAND[plan.type],
    detail: cancelPayload.reason ?? `${plan.type} command`,
    resumable: plan.type === 'pause',
  };
  const commit = prepareTransition(
    env,
    envelope,
    actor,
    plan.def,
    plan.to,
    plan.runState,
    plan.guardOutcomes,
    {},
    stop,
  );
  commit.patch[plan.type === 'pause' ? 'pauseRequested' : 'cancelRequested'] = false;
  const lifecycleDraft: EventDraftInput =
    plan.type === 'pause'
      ? {
          type: 'run.paused',
          payload: { commandId: envelope.commandId, parkedAgents: [], inFlightEffects: [] },
          summary: 'run paused',
        }
      : {
          type: 'run.cancelled',
          payload: {
            commandId: envelope.commandId,
            reason: cancelPayload.reason ?? 'cancel command',
            cancelledAgents: [],
            worktreesKept: cancelPayload.keepWorktrees ?? false,
          },
          summary: 'run cancelled',
        };

  const drafts: EventDraftInput[] = [lifecycleDraft, commit.stateChangedDraft, completedDraft(envelope, { runId })];

  const result = await commitTransition({
    deps,
    runId,
    lease,
    table,
    from: plan.runState.run.state,
    def: plan.def,
    actor,
    guardOutcomes: plan.guardOutcomes,
    transitionId: commit.transitionId,
    idempotencyKey: commit.idempotencyKey,
    drafts,
    stateChangedIndex: 1,
    patch: commit.patch,
    within: (tx, appended) => {
      const completed = appended[2];
      if (completed) tx.finishCommand(envelope.commandId, 'completed', completed.eventId);
    },
  });
  crashpoint('transition.after-commit');
  if (result !== 'recorded') return;

  // `CheckpointCause` (frozen, U0.08) has no `'cancel'`: a cancel takes the same `'phase-boundary'` cause the stop
  // ladder already uses for a cancelled run (deviation, docs/v3/requests/U1.09.md).
  await writeCheckpoint({ deps, runId, host, lease, cause: plan.type === 'pause' ? 'pause' : 'phase-boundary' });
}

/** ONE transaction: `{ claimCommand ; command.accepted ; approval.resolved ; resolveApproval ; command.completed ;
 * finishCommand }`. When this resolved the LAST pending blocking approval and the matrix cell names a
 * `mayTransition` row (T30), that row fires after it, in the same spirit as DESIGN's "applies; may trigger T30". */
async function applyApprovalDecision(
  env: InboxEnv,
  envelope: CommandEnvelope,
  actor: Actor,
  plan: Extract<CommandPlan, { kind: 'approval' }>,
): Promise<void> {
  const { deps, runId, host, lease, table } = env;
  const { approval, decision } = plan;

  await deps.store.transact({ runId }, lease, (tx) => {
    if (!tx.claimCommand(envelope.commandId, host.hostId)) return;
    const appended = deps.events.append(tx, [
      acceptedDraft(envelope, actor),
      {
        type: 'approval.resolved',
        payload: {
          approvalId: approval.approvalId,
          decision,
          actor,
          commandId: envelope.commandId,
          ...(plan.note !== undefined ? { note: plan.note } : {}),
        },
        summary: `approval ${approval.approvalId} ${decision}`,
      },
      completedDraft(envelope, { approvalId: approval.approvalId, decision }),
    ]);
    const resolvedEnvelope = appended[1];
    const completedEnvelope = appended[2];
    // `ApprovalDecisionRecord.resolvedSeq` is "the sequence of `approval.resolved`" (persistence/records.ts): the
    // real one, read back from the envelope the same transaction just minted.
    tx.resolveApproval(approval.approvalId, {
      actor,
      commandId: envelope.commandId,
      answer: decision,
      ...(plan.note !== undefined ? { note: plan.note } : {}),
      decidedAt: deps.clock.now(),
      resolvedSeq: resolvedEnvelope ? resolvedEnvelope.sequence : 0,
    });
    if (completedEnvelope) tx.finishCommand(envelope.commandId, 'completed', completedEnvelope.eventId);
  });

  if (!plan.mayTransition) return;
  const stillBlocking = plan.pendingBefore.filter((a) => a.approvalId !== approval.approvalId).length;
  if (stillBlocking > 0) return;
  const def = table.rows.find((row) => row.id === plan.mayTransition);
  if (!def) return;

  const probe = await deps.store.readRunTree(runId);
  const step = nextStep(probe, table);
  const { runState, guardOutcomes } = await guardsFor(deps, runId, step.guards);
  const resolved = resolveTransition(table, runState.run.state, def.reason, guardOutcomes);
  if (!resolved.ok || resolved.def.id !== def.id) return; // not ready yet; a later loop iteration's E2/E3-E5 catches it

  const transitionId = deps.ids.next<'TransitionId'>('trn');
  const idempotencyKey = transitionIdempotencyKey({
    runId,
    profile: table.profile,
    tableVersion: table.version,
    defId: resolved.def.id,
    discriminator: `approval:${approval.approvalId}`,
  });
  const from = runState.run.state;
  const to = resolveLandingState(resolved.to, runState);
  const resumesTo = resumeToFor(from, to);
  const patch: Partial<RunRecord> & { state: PipelineState } = { state: to };
  if (resumesTo) patch.resumeTo = resumesTo;

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
    drafts: [
      {
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
          ...(resumesTo ? { resumeTo: resumesTo } : {}),
        },
        summary: `${resolved.def.id}: ${from} -> ${to} (${resolved.def.reason})`,
      },
    ],
    patch,
  });
  if (result === 'recorded') await runEffects(deps, runId, resolved.def.effects, lease, host.signal);
}

async function applyPlan(
  env: InboxEnv,
  envelope: CommandEnvelope,
  actor: Actor,
  plan: CommandPlan,
  alreadyAccepted = false,
): Promise<void> {
  switch (plan.kind) {
    case 'simple':
      await applySimple(env, envelope, actor, plan.outcome, plan.draft);
      return;
    case 'transition':
      await applyTransition(env, envelope, actor, plan);
      return;
    case 'external':
      await applyExternal(env, envelope, actor, plan, alreadyAccepted);
      return;
    case 'approval':
      await applyApprovalDecision(env, envelope, actor, plan);
      return;
  }
}

async function planCommand(env: InboxEnv, envelope: CommandEnvelope, run: RunRecord): Promise<CommandPlan> {
  if (envelope.type === 'start') return planStart(env, envelope, run);
  if (isMatrixCommand(envelope.type)) return planMatrixCommand(env, envelope, run);
  return rejectPlan(
    envelope,
    'configuration/phase-not-available',
    `${envelope.type}: not handled by this engine skeleton (deviation, docs/v3/requests/U1.09.md)`,
  );
}

async function processCommand(env: InboxEnv, record: CommandRecord): Promise<void> {
  const { deps, runId, host, lease } = env;
  const envelope = record.envelope;

  if (!verifyAuth(deps, envelope)) {
    await deps.store.transact({ runId }, lease, (tx) => {
      if (!tx.claimCommand(record.commandId, host.hostId)) return;
      const info = errorInfoForCode(
        'security/command-auth-invalid',
        `command ${record.commandId} (${envelope.type}): missing or invalid authenticator`,
      );
      const appended = deps.events.append(tx, [rejectedDraft(envelope, info)]);
      const out = appended[0];
      tx.finishCommand(record.commandId, 'rejected', out ? out.eventId : ('' as EventId));
    });
    return;
  }

  const actor = normalizeActor(envelope.actor);
  const run = await deps.store.getRun(runId);
  if (!run) return;

  // DESIGN 2.3.4: "optimistic guard: reject if the run moved past this sequence". `run.lastSequence` here is the
  // sequence BEFORE this command's own `command.accepted` — nothing has been written yet — so a client that sends
  // the sequence it last observed is accepted, and only a run that really moved is refused.
  if (envelope.expectedSequence !== undefined && run.lastSequence > envelope.expectedSequence) {
    await applyPlan(
      env,
      envelope,
      actor,
      rejectPlan(
        envelope,
        'conflict/unexpected',
        `${envelope.type}: expectedSequence ${envelope.expectedSequence} is behind the run's current sequence ${run.lastSequence}`,
      ),
    );
    return;
  }

  await applyPlan(env, envelope, actor, await planCommand(env, envelope, run));
}

/**
 * DESIGN 4.3 #19: a host that died at `command.external.after-accepted` left the durable flag set and its command
 * `claimed` but unfinished. Before any new command is drained, finish those — idempotently, from exactly where the
 * dead host stopped — so the flag never outlives the command that set it (and `checkGlobalStops` never raises a stop
 * for a command nobody will ever complete).
 */
async function recoverAcceptedExternalCommands(env: InboxEnv): Promise<void> {
  const { deps, runId } = env;
  const run = await deps.store.getRun(runId);
  if (!run || (!run.pauseRequested && !run.cancelRequested)) return;

  for (const record of await findClaimedExternalCommands(deps.store, runId)) {
    const current = await deps.store.getRun(runId);
    if (!current) return;
    const plan = await planCommand(env, record.envelope, current);
    if (plan.kind !== 'external') {
      // The run moved on while the flag stayed behind (e.g. it is already CANCELLED, so the matrix answers `{noop}`
      // rather than T27): close the command against the CURRENT state, and clear ITS flag in the same transaction —
      // a flag that outlived its command is exactly what would later raise a stop nobody can settle.
      const isPause = record.envelope.type === 'pause';
      await deps.store.transact({ runId }, env.lease, (tx) => {
        tx.patchRun(runId, isPause ? { pauseRequested: false } : { cancelRequested: false });
        const appended = deps.events.append(tx, [completedDraft(record.envelope, { noop: true })]);
        const out = appended[0];
        tx.finishCommand(record.commandId, 'completed', out ? out.eventId : ('' as EventId));
      });
      continue;
    }
    await applyExternal(env, record.envelope, normalizeActor(record.envelope.actor), plan, true);
  }
}

/** E1: drains every currently-pending command for the run, in order, one at a time — after finishing whatever an
 * earlier host accepted but never completed. */
export async function drainInbox(env: InboxEnv): Promise<void> {
  await recoverAcceptedExternalCommands(env);
  const pending = await env.deps.store.pendingCommands(env.runId);
  for (const record of pending) await processCommand(env, record);
}
