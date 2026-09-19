// @cohorte/core/resume — PLAN U1.10: DESIGN 4.4's 11-step recovery procedure, replay-class reconciliation (4.1),
// the reconciliation note (4.4 step 10 / ADR-0025 item 6), over PORTS only. Wave-0 seam (PLAN U0.08) replaced: this
// file is now the implementation (see `../events/index.ts` for the convention this follows).
//
// `ResumeDeps` is WIDENED beyond `contract/factories.ts`'s frozen stub (owned by U0.08, not this unit's to edit —
// PLAN §3 rule 7: "a unit that believes a contract is wrong ... continues against a local adapter"). The five
// original fields (`store`, `clock`, `sweeper`, `effectVerifiers`, `worktrees`) are unchanged; four are ADDED, each
// an EXISTING frozen port (no new contract, no new package edge — `events`/`toolHostReplay` already live in
// `contract/internal.ts`, `installInspector` in `contract/ports.ts`, `redactor` is re-exported from `@cohorte/base`
// by `contract/ports.ts` already): `events` (write `run.resumed`, `lock.stolen`, `agent.state.changed`,
// `approval.resolved`, `repo.change.detected` — none of DESIGN 4.4's writes are optional), `redactor` (seal the
// synthetic reconciliation result `completeEffect` needs, DESIGN 0.2 I7), `toolHostReplay` (DESIGN 4.5's host-side
// replay of an approved call whose requester died), `installInspector` (DESIGN 4.4 step 4's immutability check) and
// `ids` (the `ApprovalId` of the `blocked-ack` approvals steps 6 and 11 open).
// Reasoning, and the ports this genuinely could not be built from, are in `docs/v3/requests/U1.10.md`.
import {
  type ApprovalId,
  CohorteError,
  type CommandId,
  type EffectId,
  errorOf,
  type JsonValue,
  type RunId,
} from '@cohorte/base';
import type {
  ApprovalRecord,
  EffectRecord,
  LeaseToken,
  LockRecord,
  LockRequest,
  RunRecord,
  StateStore,
} from '@cohorte/persistence/contract';
import { ACTIVE_PIPELINE_STATES, type ArtifactRef, type ResumeReport } from '@cohorte/protocol';
import type { RuntimeToolCall } from '@cohorte/runtime-contract';
import { reincarnate } from '../agents/lifecycle.ts';
import type { ResumeDeps } from '../contract/factories.ts';
import type { Resumer } from '../contract/internal.ts';
import type { EffectVerifierRegistry } from '../contract/ports.ts';
import type { HostContext } from '../contract/types.ts';
import { evolve } from '../state/evolve.ts';
import { initialRunState } from '../state/initial-run-state.ts';
import { checkImmutability } from './immutability.ts';
import { buildReconciliationNoteText, type NoteItem } from './note.ts';
import type { ReExecutionLog } from './verifiers.ts';

export { checkImmutability } from './immutability.ts';
export { buildReconciliationNoteText, type NoteItem, type ReconciliationNoteInput } from './note.ts';
export {
  type BuiltinEffectVerifiers,
  type BuiltinVerifierDeps,
  createBuiltinEffectVerifiers,
  type ReExecutionLog,
} from './verifiers.ts';

// The FROZEN contract of `contract/factories.ts`, re-exported — never a second interface of the same name (the
// convention `packages/core/src/events/index.ts` set for `EventsDeps`). The five fields this area needed on top of
// the original five were WIDENED where the type lives, at gate G1; until then they were declared here and the
// barrel published a `createResumer` whose parameter no exported type described. `ids` mints the `ApprovalId` of the
// `blocked-ack` approvals DESIGN 4.4 steps 6 and 11 open (`ApprovalService` is deliberately not in this port set: it
// would drag the whole approval area in for one `putApproval`).
export type { ResumeDeps };

const LEASE_TTL_MS = 15_000;

/** DESIGN 2.5.4: the FOUR legal reincarnation sources — `spawning | running | waiting | paused -> spawning`. After a
 * host death no child of this run survives, so every agent in one of these states must continue in a new
 * incarnation of the SAME attempt, whether or not an `incarnations` row recorded a pid we could sweep (a `waiting`
 * agent parked on an approval is the canonical case: its brain is gone and its approved call has to be replayed).
 * `declared` / `planned` have no runtime session yet and `failed` / `retrying` / `escalated` already counted their
 * attempt — `reincarnate()` refuses all five — and `completed` / `cancelled` are terminal (4.4 step 11). */
const RECOVERABLE_AGENT_STATES: ReadonlySet<string> = new Set(['spawning', 'running', 'waiting', 'paused']);

/** `IncarnationRecord.state` is open (owned by the supervisor): everything that is not one of these three may still
 * have a live OS process behind it, so the sweep looks at all of them (DESIGN 4.4 step 5). */
const TERMINAL_INCARNATION_STATES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);

/** A pending command that must win over the rest of recovery (DESIGN 4.4 step 9: "a `cancel` recorded while the
 * host was dead wins here"): nothing is reincarnated and no approved call is replayed under one. */
const HALTING_COMMAND_TYPES: ReadonlySet<string> = new Set(['cancel', 'shutdown']);

/** The run states under which step 10 may CONTINUE the work (reincarnate an agent, replay its approved calls): the
 * table's own active phases, plus `IDLE` (a run whose host died between `putRun` and the first transition — crash
 * point #1 — has no agent to continue anyway). Everything else is handled by `haltingRunState` below. */
const CONTINUABLE_RUN_STATES: ReadonlySet<string> = new Set<string>([...ACTIVE_PIPELINE_STATES, 'IDLE']);

/** DESIGN 4.4 step 11: "`PAUSED`, `WAITING_APPROVAL`, `AUTH_REQUIRED`, `QUOTA_EXCEEDED` stay what they are:
 * recovery never silently un-suspends." Reincarnating a parked agent and replaying its approved call (4.5) IS
 * continuing the work — a `paused` agent that comes back `spawning` and executes its approved `run_command` has
 * un-suspended the run in everything but the `runs.state` column — so step 10 reads the RUN's state, not only the
 * agent's. The four suspended states, the two halted ones (`FAILED`, `BLOCKED`: only a human `retry` / `resume
 * --ack` moves them, T31 / T32) and the two terminal ones therefore stop step 10; steps 1-9 still run, so the
 * journal, the locks and the worktrees are reconciled and the report says why the work was not continued.
 *
 * `WAITING_APPROVAL` is the one state with a condition: DESIGN 2.5.3 resumes it "by `approve` / `deny`", and
 * ADR-0025 item 6's parked path exists precisely to replay a call whose ask was answered while no host was alive.
 * So it continues once no BLOCKING approval is pending any more (`listPendingApprovals` after step 9's expiry
 * pass) — and an answered ask lets the 4.5 replay happen, which is the whole point of that path. */
function haltingRunState(state: string, pendingApprovals: number): string | undefined {
  if (state === 'WAITING_APPROVAL') {
    return pendingApprovals > 0
      ? `the run is WAITING_APPROVAL and ${pendingApprovals} approval(s) are still pending`
      : undefined;
  }
  if (CONTINUABLE_RUN_STATES.has(state)) return undefined;
  if (state === 'FAILED' || state === 'BLOCKED') {
    return `the run is ${state}: only a human command (\`retry\` / \`resume --ack\`) continues it`;
  }
  if (state === 'COMPLETED' || state === 'CANCELLED') return `the run is ${state}`;
  return `the run is ${state}: recovery never silently un-suspends (DESIGN 4.4 step 11)`;
}

/** DESIGN 4.4 step 8's second bullet — "unexplained, and the slot has a COMMAND effect that is `in-doubt` or
 * `failed(interrupted)`" (ADR-0025 item 2 repeats it word for word) — is the ONLY case in which recovery answers an
 * unexplained worktree change by quarantining and resetting the slot. Every other unexplained change falls into the
 * third bullet: `repo.change.detected` ⇒ stop `unexpected-repo-change` ⇒ BLOCKED. The distinction is load-bearing:
 * a reset discards the agent's uncommitted work, and ADR-0025 item 3's checkpoint cadence ("immediately before any
 * `at-most-once` command executes — so a reset after an in-doubt command loses nothing but that command's own
 * writes") only bounds that loss for a COMMAND.
 *
 * `tool.run_command` is DESIGN 4.1's only agent-command kind in V3.0. `check.command` (the TEST sequence, always in
 * `_integration`, which 2.5.2 resets after every sequence) and `provision.command` are deliberately NOT here: they
 * are not an agent's slot work, and widening this set is a DESIGN decision, filed as item D11 of
 * `docs/v3/requests/U1.10.md`. */
const COMMAND_EFFECT_KINDS: ReadonlySet<string> = new Set(['tool.run_command']);

/** DESIGN 4.4 step 2's second half: fold the event stream through `evolve` from the run's own creation-time fields
 * (immutable, so a valid `initialRunState` seed) and compare with the STORED projection. A mismatch anywhere the
 * store did not already refuse to open (`verifyChain`) is `corruption/projection-mismatch`: the two most likely
 * causes are a hand-edited `runs` row or a bug in a caller's transaction, and DESIGN says "nothing is modified"
 * either way. */
export async function verifyProjectionAgainstEvents(store: StateStore, run: RunRecord): Promise<void> {
  let folded = initialRunState({
    runId: run.runId,
    profile: run.profile,
    tableVersion: run.tableVersion,
    specId: run.specId,
    specSha256: run.specSha256,
    title: run.title,
    pinnedInstallDir: run.pinnedInstallDir,
    baseBranch: run.baseBranch,
    cohorteVersion: run.cohorteVersion,
    schemaVersion: run.schemaVersion,
    startedAt: run.startedAt,
  });
  const PAGE = 500;
  let after = 0;
  for (;;) {
    const page = await store.readEvents(run.runId, { afterSequence: after, limit: PAGE });
    if (page.length === 0) break;
    for (const envelope of page) folded = evolve(folded, envelope);
    after = (page.at(-1) as (typeof page)[number]).sequence;
    if (page.length < PAGE) break;
  }
  // `run.version` is NOT compared: it counts store TRANSACTIONS (`StoreTx.appendEvents` bumps it once per CALL,
  // `packages/persistence/src/memory/state-store.ts`), not events, and `evolve()` deliberately never touches it
  // (`packages/core/src/state/evolve.ts`'s own `base` object) — two events written in one transaction and two
  // written across two both replay to the same STATE but a different transaction count, so it is not a projection
  // fold could ever reconstruct. `lastSequence` and `state` are what DESIGN 4.4 step 2 means by "compare with the
  // runs projection".
  const same = folded.run.lastSequence === run.lastSequence && folded.run.state === run.state;
  if (!same) {
    throw new CohorteError(
      errorOf(
        'corruption/projection-mismatch',
        `run ${run.runId}: replaying events yields ${folded.run.state}@seq${folded.run.lastSequence}, the stored projection is ${run.state}@seq${run.lastSequence}`,
      ),
    );
  }
}

/** DESIGN 4.4 step 3. Live owner (fresh heartbeat AND the process is actually alive) ⇒ refuse. Dead owner ⇒ steal
 * with `fencingToken + 1`. No existing lock ⇒ this is the first host: acquire fresh (`takeover: false`). */
async function acquireOrStealRunLease(
  deps: ResumeDeps,
  runId: RunId,
  host: HostContext,
): Promise<{ lease: LeaseToken; takeover: boolean }> {
  const owner = { runId, hostId: host.hostId, pid: host.pid, startToken: host.startToken };
  const runLocks = await deps.store.listLocks({ scope: 'run' });
  const existing: LockRecord | undefined = runLocks.find((lock) => lock.key === runId);
  if (existing) {
    if (deps.sweeper.isAlive(existing.ownerPid, existing.ownerStartToken)) {
      throw new CohorteError(
        errorOf(
          'conflict/run-host-alive',
          `run ${runId} is already driven by host ${existing.ownerHostId} (pid ${existing.ownerPid})`,
        ),
      );
    }
    const req: LockRequest = { scope: 'run', key: runId, mode: 'exclusive', owner, ttlMs: LEASE_TTL_MS };
    const lease = await deps.store.stealLock(req, existing);
    return { lease, takeover: true };
  }
  const req: LockRequest = { scope: 'run', key: runId, mode: 'exclusive', owner, ttlMs: LEASE_TTL_MS };
  const acquired = await deps.store.acquireLock(req);
  if (!acquired.ok) {
    throw new CohorteError(errorOf('conflict/run-host-alive', `run ${runId}: the run lock is held by another host`));
  }
  return { lease: acquired.lease, takeover: false };
}

/** The `ApprovalRequest`-shaped JSON an `ApprovalRecord.request` carries (DESIGN 2.3.3): only the two fields this
 * module reads back out of it. `toolCallId`/`ordinal` (`tc_<incarnation>_<ordinal>`, `RuntimeToolCall`'s own
 * comment, `@cohorte/runtime-contract`) is parsed from the id itself: neither `ApprovalRecord` nor the stored
 * request repeats the ordinal as its own field. */
function ordinalFromToolCallId(id: string): number {
  const last = id.split('_').at(-1);
  const parsed = last === undefined ? Number.NaN : Number(last);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function approvedCallOf(runId: RunId, approval: ApprovalRecord): RuntimeToolCall | undefined {
  if (!approval.agentId || approval.incarnation === undefined || !approval.toolCallId) return undefined;
  const request = approval.request as unknown as { tool?: string; args?: JsonValue };
  if (typeof request.tool !== 'string') return undefined;
  return {
    runId,
    agentId: approval.agentId,
    incarnation: approval.incarnation,
    toolCallId: approval.toolCallId,
    ordinal: ordinalFromToolCallId(approval.toolCallId),
    tool: request.tool,
    input: request.args ?? {},
  };
}

interface EffectDecision {
  effect: EffectRecord;
  action: 'done' | 'fail' | 'in-doubt';
}

/** A registry MAY also report which effects its own probe re-executed (`createBuiltinEffectVerifiers` does, for
 * `provision.command`, whose probe IS `Provisioner.ensure`). The frozen `EffectVerifierRegistry` has no such member,
 * so it is read by narrowing; a registry without it simply yields `'done'` verdicts, never `'re-executed'`. */
function reExecutionLogOf(registry: EffectVerifierRegistry): ReExecutionLog | undefined {
  const candidate = registry as Partial<ReExecutionLog>;
  return typeof candidate.reExecuted === 'function' ? (candidate as ReExecutionLog) : undefined;
}

/** DESIGN 4.4 steps 6 and 11 both need a human acknowledgement before the run may go on, and this port set has no
 * `ApprovalService`: the record and its `approval.requested` event are written directly, in ONE transaction, with
 * the event's own sequence as `requestedSeq`. `idempotencyKey` is derived from the run and the situation, so a
 * second recovery that finds the same situation reuses the approval instead of opening a duplicate. */
interface BlockedAckDraft {
  idempotencyKey: string;
  ruleId: string;
  reason: string;
  previewText: string;
  affectedPaths: readonly string[];
}

async function openBlockedAckApproval(
  deps: ResumeDeps,
  runId: RunId,
  lease: LeaseToken,
  draft: BlockedAckDraft,
): Promise<ApprovalId> {
  const approvalId = deps.ids.next<'ApprovalId'>('apr');
  const request = {
    approvalId,
    kind: 'blocked-ack' as const,
    affectedPaths: [...draft.affectedPaths],
    preview: { kind: 'text' as const, text: draft.previewText },
    ruleId: draft.ruleId,
    reason: draft.reason,
    asks: [{ stage: 'resume', ruleId: draft.ruleId, reason: draft.reason }],
    allowedDecisions: ['allow-once' as const, 'deny' as const],
    unattended: 'wait' as const,
    cli: `cohorte approve ${approvalId}`,
  };
  await deps.store.transact({ runId }, lease, (tx) => {
    const appended = deps.events.append(tx, [
      {
        type: 'approval.requested',
        payload: request as unknown as JsonValue,
        summary: draft.reason,
        severity: 'warning',
      },
    ]);
    const event = appended.at(0);
    if (!event) throw new TypeError('resume: approval.requested produced no envelope');
    tx.putApproval({
      approvalId,
      runId,
      idempotencyKey: draft.idempotencyKey,
      kind: 'blocked-ack',
      status: 'pending',
      request: deps.redactor.sealJson(request as unknown as JsonValue).value,
      grantKey: draft.idempotencyKey,
      requestedSeq: event.sequence,
      createdAt: deps.clock.now(),
    });
  });
  return approvalId;
}

/** DESIGN 4.1 / 4.4 step 7: decide every open (`intent` | `in-doubt`) effect by replay class, calling each kind's
 * verifier (never a blind re-execution). `at-most-once` skips the verifier entirely (DESIGN 4.1's own table: "never
 * re-executed" — there is nothing to probe for, only to surface). */
async function decideOpenEffects(deps: ResumeDeps, runId: RunId, signal: AbortSignal): Promise<EffectDecision[]> {
  const intents = await deps.store.listEffects(runId, { states: ['intent'] });
  const inDoubtAlready = await deps.store.listEffects(runId, { states: ['in-doubt'] });
  const open = [...intents, ...inDoubtAlready];
  const decisions: EffectDecision[] = [];
  for (const effect of open) {
    if (effect.replayClass === 'at-most-once') {
      decisions.push({ effect, action: 'in-doubt' });
      continue;
    }
    const verifier = deps.effectVerifiers.get(effect.kind);
    if (!verifier) {
      decisions.push({ effect, action: 'in-doubt' });
      continue;
    }
    const verdict = await verifier.verify(effect, signal);
    if (verdict === 'done') decisions.push({ effect, action: 'done' });
    else if (verdict === 'not-done') decisions.push({ effect, action: 'fail' });
    else decisions.push({ effect, action: 'in-doubt' });
  }
  return decisions;
}

export function createResumer(deps: ResumeDeps): Resumer {
  return {
    async recover(runId: RunId, host: HostContext): Promise<ResumeReport> {
      // Step 1 — migration CHECK only, never automatic.
      const migration = await deps.store.migrate('check');
      if (migration.pending.length > 0) {
        throw new CohorteError(
          errorOf(
            'configuration/incompatible-state-schema',
            `run ${runId}: the state database is at schema ${migration.current}, this build expects ${migration.target}; run \`cohorte migrate --apply\``,
          ),
        );
      }

      // Step 2 — verifyChain, then replay-vs-projection.
      const chain = await deps.store.verifyChain(runId);
      if (!chain.ok) {
        if (chain.reason === 'gap' || chain.reason === 'duplicate') {
          throw new CohorteError(
            errorOf(
              'corruption/event-gap',
              `run ${runId}: event sequence has a ${chain.reason} at ${chain.firstBadSequence}`,
            ),
          );
        }
        throw new CohorteError(
          errorOf(
            'security/event-chain-broken',
            `run ${runId}: event chain fails its ${chain.reason} check at ${chain.firstBadSequence}`,
          ),
        );
      }
      const run = await deps.store.getRun(runId);
      if (!run) throw new CohorteError(errorOf('validation/invalid-id', `resume: run ${runId} does not exist`));
      await verifyProjectionAgainstEvents(deps.store, run);

      // Step 4 — immutability, BEFORE taking the lease over: ADR-0023 "no adopt flag", so a pin mismatch must never
      // let this host start acting as the run's owner.
      const immutability = checkImmutability(run, deps.installInspector);
      if (!immutability.ok) {
        const why =
          immutability.reason === 'install-dir-mismatch'
            ? `pinned install ${run.pinnedInstallDir} is not this host's install (${deps.installInspector.installDir()})`
            : `table version ${run.tableVersion} of profile ${run.profile} is not shipped by this build`;
        throw new CohorteError(
          errorOf('security/runtime-pin-mismatch', `run ${runId}: ${why}`, {
            details: { resumeRequires: 'reinstall-pinned-version' },
          }),
        );
      }

      // Step 3 — lease.
      const { lease, takeover } = await acquireOrStealRunLease(deps, runId, host);
      const fencingToken = lease.fencingToken;
      if (takeover) {
        await deps.store.transact({ runId }, lease, (tx) => {
          deps.events.append(tx, [
            {
              type: 'lock.stolen',
              payload: { scope: 'run', key: runId, mode: 'exclusive', owner: host.hostId, fencingToken },
              summary: `host ${host.hostId} took over run ${runId} (fencing token ${fencingToken})`,
              severity: 'warning',
            },
          ]);
        });
      }

      const tree = await deps.store.readRunTree(runId);

      // Step 5 — orphan sweep. Agent incarnations by (pid, startToken) — see docs/v3/requests/U1.10.md item D7 for
      // the executor process-group half (runs/<id>/pids/*.json) this port set cannot reach.
      const orphans: ResumeReport['orphans'] = [];
      for (const incarnation of tree.incarnations) {
        if (incarnation.pid === undefined || incarnation.startToken === undefined) continue;
        if (TERMINAL_INCARNATION_STATES.has(incarnation.state)) continue;
        if (deps.sweeper.isAlive(incarnation.pid, incarnation.startToken)) continue;
        // `killed` is a FACT the report states about a stray brain: a rejected `kill` (permission, race with the
        // process's own exit, a sweeper that cannot signal) must not be reported as a successful kill.
        const killed = await deps.sweeper.kill(incarnation.pid, incarnation.startToken).then(
          () => true,
          () => false,
        );
        orphans.push({
          agentId: incarnation.agentId,
          incarnation: incarnation.incarnation,
          pid: incarnation.pid,
          kind: 'brain',
          killed,
        });
      }

      // Step 6 — rebuild locks: project (shared) + declared zones + integration + slots. "Rebuild" is not "acquire
      // if free": a lock row still held by THIS run's own dead host is exactly what recovery is here to take back,
      // and `acquireLock` refuses it however stale the lease is (the store never evicts — `StateStore.acquireLock`).
      // So a refusal whose holders are all this run's, all dead, is taken over with `stealLock` (fencing+1), the
      // same way step 3 takes the run lease. Only a holder that is ANOTHER run — or one that is alive — is a
      // conflict, which is DESIGN 4.4 step 6's own wording ("a zone now held by another run").
      const rebuilt: string[] = [`run:${runId}`];
      const conflicts: string[] = [];
      const owner = { runId, hostId: host.hostId, pid: host.pid, startToken: host.startToken };
      const rebuildLock = async (label: string, req: LockRequest): Promise<void> => {
        const acquired = await deps.store.acquireLock(req);
        if (acquired.ok) {
          rebuilt.push(label);
          return;
        }
        const reclaimable =
          acquired.heldBy.length === 1 &&
          acquired.heldBy.every(
            (held) => held.ownerRunId === runId && !deps.sweeper.isAlive(held.ownerPid, held.ownerStartToken),
          );
        const stale = acquired.heldBy.at(0);
        if (reclaimable && stale) {
          await deps.store.stealLock(req, stale);
          rebuilt.push(label);
          return;
        }
        conflicts.push(label);
      };
      await rebuildLock('project', { scope: 'project', key: 'project', mode: 'shared', owner, ttlMs: LEASE_TTL_MS });
      for (const zone of run.zones ?? []) {
        await rebuildLock(`zone:${zone}`, {
          scope: 'zone',
          key: zone,
          mode: 'exclusive',
          owner,
          ttlMs: LEASE_TTL_MS,
          zones: [zone],
        });
      }
      await rebuildLock(`integration:${runId}`, {
        scope: 'integration',
        key: runId,
        mode: 'exclusive',
        owner,
        ttlMs: LEASE_TTL_MS,
      });
      for (const worktree of tree.worktrees) {
        await rebuildLock(`slot:${worktree.slot}`, {
          scope: 'slot',
          key: `${runId}:${worktree.slot}`,
          mode: 'exclusive',
          owner,
          ttlMs: LEASE_TTL_MS,
        });
      }

      // Step 7 — reconcile intent effects FIRST, by replay class, before any worktree comparison (DESIGN 4.4).
      const decisions = await decideOpenEffects(deps, runId, host.signal);
      const reExecutionLog = reExecutionLogOf(deps.effectVerifiers);
      const effectReports: ResumeReport['effects'] = [];
      const inDoubtIds: EffectId[] = [];
      await deps.store.transact({ runId }, lease, (tx) => {
        for (const { effect, action } of decisions) {
          if (action === 'done') {
            tx.completeEffect(
              effect.effectId,
              deps.redactor.sealJson({ reconciledBy: 'resume', at: deps.clock.now() }).value,
            );
            // `'re-executed'` is reported only when the VERIFIER itself redid the work while probing (DESIGN 4.1's
            // `provision.command` row: `Provisioner.ensure` re-provisions when the marker is missing). Everything
            // else that verified `done` was found already applied in the world.
            const verdict: (typeof effectReports)[number]['verdict'] = reExecutionLog?.reExecuted(effect.effectId)
              ? 're-executed'
              : 'done';
            effectReports.push({
              effectId: effect.effectId,
              kind: effect.kind,
              replayClass: effect.replayClass,
              verdict,
            });
          } else if (action === 'fail') {
            tx.failEffect(
              effect.effectId,
              errorOf(
                'tool-transient/interrupted',
                `effect ${effect.idempotencyKey} (${effect.kind}) was interrupted by a host restart`,
              ),
            );
            effectReports.push({
              effectId: effect.effectId,
              kind: effect.kind,
              replayClass: effect.replayClass,
              verdict: 'failed',
            });
          } else {
            tx.markEffectInDoubt(
              effect.effectId,
              `resume: ${effect.kind} could not be proven done or not-done after a host restart`,
            );
            effectReports.push({
              effectId: effect.effectId,
              kind: effect.kind,
              replayClass: effect.replayClass,
              verdict: 'in-doubt',
            });
            inDoubtIds.push(effect.effectId);
          }
        }
      });

      // Step 8 — git verification via the ledger audit (DESIGN 5.2/5.8, spec 11.3): `WorktreeService.audit` already
      // computes the exact verdict enum DESIGN 4.4 step 8 and `ResumeReport.worktrees[].verdict` share.
      const worktreeReports: ResumeReport['worktrees'] = [];
      const unexplained: string[] = [];
      /** per quarantined slot: the effect that explained the change and the patch artifact the reset saved — the
       * `compensated` line of the reconciliation note (DESIGN 4.4 step 10) is built from it. */
      const compensatedSlots = new Map<string, { because: EffectId; patch: ArtifactRef; checkpointSha: string }>();
      for (const worktree of tree.worktrees) {
        const audit = await deps.worktrees.audit(worktree.slot);
        let verdict = audit.verdict;
        if (verdict === 'unexplained-change') {
          // `COMMAND_EFFECT_KINDS` + `action !== 'done'` IS DESIGN 4.4 step 8's second bullet, literally: "a command
          // effect that is `in-doubt` or `failed(interrupted)`". An open `git.*` / `agent.spawn` / `provision.*`
          // effect explains nothing about bytes in the worktree and must NOT buy a reset of the agent's work.
          const explaining = decisions.find(
            (d) => d.effect.slot === worktree.slot && COMMAND_EFFECT_KINDS.has(d.effect.kind) && d.action !== 'done',
          );
          if (explaining) {
            // `WorktreeService.quarantineAndReset` performs the journaled reset AND compensates the slot's effects
            // in its own transaction (DESIGN 4.4 step 8 / ADR-0025 item 2) — this caller only reports the outcome.
            const patch = await deps.worktrees.quarantineAndReset(worktree.slot, explaining.effect.effectId);
            verdict = 'quarantined-reset';
            compensatedSlots.set(worktree.slot, {
              because: explaining.effect.effectId,
              patch,
              checkpointSha: worktree.checkpointSha,
            });
          } else {
            unexplained.push(worktree.slot);
          }
        }
        worktreeReports.push({ slot: worktree.slot, path: worktree.path, verdict });
      }
      // ADR-0025 item 2 / DESIGN 4.4 step 8: the quarantine transaction marks every effect of the slot after the
      // checkpoint `compensated`. The report says so too — step 7 had only just given those effects their
      // `in-doubt` / `failed` verdict, and a quarantined worktree with no compensated effect anywhere would be a
      // report that contradicts the journal it describes.
      if (compensatedSlots.size > 0) {
        const slotOf = new Map(decisions.map((d) => [d.effect.effectId, d.effect.slot]));
        for (const [index, entry] of effectReports.entries()) {
          const slot = slotOf.get(entry.effectId);
          if (slot !== undefined && compensatedSlots.has(slot)) {
            effectReports[index] = { ...entry, verdict: 'compensated' };
          }
        }
      }
      if (unexplained.length > 0) {
        await deps.store.transact({ runId }, lease, (tx) => {
          deps.events.append(
            tx,
            unexplained.map((slot) => ({
              type: 'repo.change.detected' as const,
              payload: { slot, expected: '(checkpoint)', actual: '(unexplained change)', files: [] },
              summary: `unexplained change in worktree ${slot}: no effect explains it`,
              severity: 'error' as const,
            })),
          );
        });
        throw new CohorteError(
          errorOf(
            'security/write-outside-ownership',
            `run ${runId}: worktree(s) ${unexplained.join(', ')} changed with no explaining effect`,
          ),
        );
      }

      // Step 9 — inbox + approvals expiry.
      //
      // DEVIATION (docs/v3/requests/U1.10.md item D6): `ResumeDeps` has no `CommandAuthenticator` and no `KeyStore`,
      // so the MAC of a pending command cannot be verified here, and APPLYING a command means running it through
      // the transition table and its guards — the engine's job (U1.09), which reads the same inbox after
      // `recover()` returns. `commandsApplied` is therefore EMPTY: the field names commands this procedure applied,
      // and it applied none. What recovery does honour is DESIGN 4.4 step 9's own sentence, "a `cancel` recorded
      // while the host was dead wins here": a pending `cancel` / `shutdown` stops step 10 from reincarnating
      // anything and from replaying any approved call, so the engine finds the run exactly as the dead host left
      // it, plus the reconciliation of steps 5-8, and cancels it.
      const pending = await deps.store.pendingCommands(runId);
      const halting = pending.find((command) => HALTING_COMMAND_TYPES.has(command.type));
      const commandsApplied: CommandId[] = [];
      const openApprovals = await deps.store.listPendingApprovals(runId);
      const now = deps.clock.now();
      const due = openApprovals.filter((a) => a.expiresAt !== undefined && a.expiresAt <= now);
      if (due.length > 0) {
        await deps.store.transact({ runId }, lease, (tx) => {
          const appended = deps.events.append(
            tx,
            due.map((a) => ({
              type: 'approval.resolved' as const,
              payload: {
                approvalId: a.approvalId,
                decision: 'expired' as const,
                actor: { kind: 'system' as const, id: host.hostId, transport: 'cli' as const },
              },
              summary: `approval ${a.approvalId} expired`,
              severity: 'info' as const,
            })),
          );
          due.forEach((a, index) => {
            const event = appended.at(index);
            if (!event) throw new TypeError('resume: approval.resolved event count mismatch');
            tx.resolveApproval(a.approvalId, {
              actor: { kind: 'system', id: host.hostId, transport: 'cli' },
              answer: 'expired',
              decidedAt: now,
              resolvedSeq: event.sequence,
            });
          });
        });
      }
      const dueIds = new Set(due.map((a) => a.approvalId));
      const stillPending = openApprovals.filter((a) => !dueIds.has(a.approvalId));
      const approvalsCarried: ApprovalId[] = stillPending.map((a) => a.approvalId);

      // Step 10 — EVERY agent that is still one of the four reincarnation sources of DESIGN 2.5.4 continues in a new
      // incarnation of the same attempt: after a host death none of this run's children survives, whether the agent
      // was `running`, mid-`spawning`, `waiting` on an approval (the 4.5 parked case `ToolHostReplay` exists for) or
      // `paused`. Its approved-but-unconsumed calls are replayed FIRST (4.5), then the reconciliation note is built
      // from what steps 7-8 actually did, then `reincarnate` (incarnation+1, attempt unchanged). A
      // `budget/incarnations` exhaustion fails THAT agent, never the whole recovery.
      const approvedReplays: ResumeReport['approvedReplays'] = [];
      /** `{ agentId, text }` per continued agent — the note DESIGN 4.4 step 10 describes. D5: turning it into the
       * `Continuation.note` `TaskInput` needs RunFiles/BlobStore (AgentSupervisor's, a later wave); what recovery
       * itself can do with the text is put it in front of the human, which is the `blocked-ack` preview of step 11. */
      const notes: { agentId: string; text: string }[] = [];
      // Recovery reconciles (steps 5-8) but does NOT continue the work when the run must not go on: DESIGN 4.4
      // step 11's "recovery never silently un-suspends" (the run's OWN state, `haltingRunState` above), step 9's
      // "a `cancel` recorded while the host was dead wins here", and step 6's zone held by another run.
      const suspendedBy = haltingRunState(run.state, stillPending.length);
      const haltedBy = halting
        ? `a pending \`${halting.type}\` command (${halting.commandId})`
        : conflicts.length > 0
          ? `lock(s) ${conflicts.join(', ')} held by another run`
          : suspendedBy;
      for (const agent of haltedBy ? [] : tree.agents) {
        if (!RECOVERABLE_AGENT_STATES.has(agent.state)) continue;

        // The approved calls are REPLAYED before the note is built (4.5 / ADR-0025 item 6), so every line below
        // states a fact about the post-recovery tree.
        const replayed: NoteItem[] = [];
        const unconsumed = tree.approvals.filter(
          (a) =>
            a.agentId === agent.agentId &&
            (a.status === 'allow-once' || a.status === 'allow-for-run') &&
            a.consumedByEffect === undefined,
        );
        for (const approval of unconsumed) {
          const call = approvedCallOf(runId, approval);
          if (!call) continue;
          const replay = await deps.toolHostReplay.replayApproved(
            lease,
            { approvalId: approval.approvalId, call, grantKey: approval.grantKey },
            host.signal,
          );
          approvedReplays.push({
            approvalId: approval.approvalId,
            toolCallId: call.toolCallId,
            outcome: replay.outcome,
          });
          replayed.push({
            situation: 'approved',
            approvalId: approval.approvalId,
            toolCallId: call.toolCallId,
            tool: call.tool,
            outcome: replay.outcome,
          });
        }

        // DESIGN 4.4 step 10's own order: calls not executed; calls completed with their recorded result; work
        // compensated by a reset; calls in doubt; approvals decided meanwhile.
        const compensated = agent.slot === undefined ? undefined : compensatedSlots.get(agent.slot);
        const noteItems: NoteItem[] = [];
        for (const { effect, action } of decisions) {
          if (effect.agentId !== agent.agentId || effect.toolCallId === undefined) continue;
          // a slot that was quarantined and reset has ONE line (below): saying "completed" about work the reset
          // discarded would be the lie the compensation exists to prevent.
          if (effect.slot !== undefined && compensatedSlots.has(effect.slot)) continue;
          const tool = effect.kind.startsWith('tool.') ? effect.kind.slice('tool.'.length) : effect.kind;
          if (action === 'fail') noteItems.push({ situation: 'not-executed', toolCallId: effect.toolCallId, tool });
          else if (action === 'done') {
            noteItems.push({
              situation: 'completed',
              toolCallId: effect.toolCallId,
              tool,
              resultSummary: `verified done after the restart (effect ${effect.idempotencyKey})`,
            });
          }
        }
        if (compensated) {
          noteItems.push({
            situation: 'compensated',
            effectId: compensated.because,
            checkpointSha: compensated.checkpointSha,
            patch: compensated.patch,
          });
        }
        for (const { effect, action } of decisions) {
          if (action !== 'in-doubt' || effect.agentId !== agent.agentId) continue;
          noteItems.push({
            situation: 'in-doubt',
            effectId: effect.effectId,
            kind: effect.kind,
            replayClass: effect.replayClass,
          });
        }
        noteItems.push(...replayed);
        notes.push({
          agentId: agent.agentId,
          text: buildReconciliationNoteText({
            agentId: agent.agentId,
            fromIncarnation: agent.incarnation,
            items: noteItems,
          }),
        });

        try {
          const reincarnated = reincarnate(agent, 'recovery');
          await deps.store.transact({ runId }, lease, (tx) => {
            tx.putAgent(reincarnated);
            deps.events.append(tx, [
              {
                type: 'agent.state.changed',
                payload: {
                  agent: {
                    agentId: agent.agentId,
                    role: agent.role,
                    ...(agent.surface ? { surface: agent.surface } : {}),
                    incarnation: reincarnated.incarnation,
                    attempt: reincarnated.attempt,
                  },
                  from: agent.state,
                  to: 'spawning',
                  reason: 'recovery',
                  attemptConsumed: false,
                },
                summary: `agent ${agent.agentId} reincarnated by resume (host restart)`,
                severity: 'info',
              },
            ]);
          });
        } catch (thrown) {
          if (thrown instanceof CohorteError && thrown.info.code === 'budget/incarnations') {
            await deps.store.transact({ runId }, lease, (tx) => {
              tx.putAgent({ ...agent, state: 'failed', lastError: thrown.info, updatedAt: deps.clock.now() });
            });
          } else {
            throw thrown;
          }
        }
      }

      // Step 11 — the acknowledgements that must exist BEFORE the run goes on, then `run.resumed`.
      //
      // (a) DESIGN 4.4 step 6: "a zone now held by another run => WAITING_APPROVAL(`conflict/zone-reserved`)". A
      //     lock this host could not rebuild is exactly that, and the way a run reaches WAITING_APPROVAL here is a
      //     pending BLOCKING approval: the engine's `checkGlobalStops` turns one into `approval-required` (T21).
      // (b) DESIGN 4.4 step 11's last sentence: "an `in-doubt` effect with `policy.inDoubt: 'ask'` (default) opens a
      //     `blocked-ack`-style approval before the agent continues". DEVIATION: the in-doubt POLICY is not
      //     reachable from this port set (it lives in the project config, which `ResumeDeps` cannot read), so the
      //     DEFAULT — `ask` — is what recovery applies, unconditionally. `docs/v3/requests/U1.10.md` item D8 asks
      //     for the policy to be carried on the run row or handed to `createResumer`.
      // Both are idempotent: a second recovery finding the same situation reuses the approval by its
      // `idempotencyKey` instead of opening a duplicate.
      const carriedByKey = new Map(
        openApprovals.filter((a) => !dueIds.has(a.approvalId)).map((a) => [a.idempotencyKey, a.approvalId]),
      );
      const ensureBlockedAck = async (draft: BlockedAckDraft): Promise<void> => {
        const existing = carriedByKey.get(draft.idempotencyKey);
        if (existing !== undefined) return;
        const approvalId = await openBlockedAckApproval(deps, runId, lease, draft);
        carriedByKey.set(draft.idempotencyKey, approvalId);
        approvalsCarried.push(approvalId);
      };
      if (conflicts.length > 0) {
        await ensureBlockedAck({
          idempotencyKey: `apr:${runId}:blocked-ack:lock-conflict`,
          ruleId: 'conflict/zone-reserved',
          reason: `run ${runId}: lock(s) ${conflicts.join(', ')} could not be rebuilt — they are held by another run`,
          previewText: `These locks belong to another run and recovery could not take them back:\n${conflicts
            .map((c) => `- ${c}`)
            .join('\n')}\n\nNothing was reincarnated. Release the other run (or cancel this one) before resuming.`,
          affectedPaths: [],
        });
      }
      if (inDoubtIds.length > 0) {
        await ensureBlockedAck({
          idempotencyKey: `apr:${runId}:blocked-ack:in-doubt`,
          ruleId: 'human-required/in-doubt-effect',
          reason: `run ${runId}: ${inDoubtIds.length} effect(s) are in doubt after the host restart and must be acknowledged before the agents continue`,
          previewText:
            notes.length > 0
              ? notes.map((n) => n.text).join('\n\n')
              : `In doubt after the restart:\n${inDoubtIds.map((id) => `- ${id}`).join('\n')}`,
          affectedPaths: [],
        });
      }

      const report: ResumeReport = {
        takeover,
        hostId: host.hostId,
        fencingToken,
        locks: { rebuilt, conflicts },
        orphans,
        worktrees: worktreeReports,
        effects: effectReports,
        approvalsCarried,
        commandsApplied,
        inDoubt: inDoubtIds,
        approvedReplays,
      };

      // Commit run.resumed; recovery never silently un-suspends (this event's `evolve` case is a no-op,
      // `packages/core/src/state/evolve.ts`, so nothing here moves `run.state`).
      await deps.store.transact({ runId }, lease, (tx) => {
        deps.events.append(tx, [
          {
            type: 'run.resumed',
            payload: { mode: 'recovery', report },
            summary: haltedBy
              ? `run ${runId} recovered but not continued: ${haltedBy}`
              : `run ${runId} resumed (recovery, host ${host.hostId})`,
            severity: 'success',
          },
        ]);
      });

      return report;
    },
  };
}
