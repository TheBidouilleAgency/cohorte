// MemoryStateStore (DESIGN 2.4, ADR-0002): the second implementation that keeps the contract honest, and the store
// every W1-W3 core unit tests against. DUMB on purpose: no reducer, no projection logic. A transaction runs its body
// on a structural clone of the whole state and swaps it in on success, so a rollback is "drop the clone".
import { writeFile } from 'node:fs/promises';
import {
  type AgentId,
  type ApprovalId,
  type ArtifactId,
  type Clock,
  CohorteError,
  type CommandId,
  createUuidV7IdSource,
  type EffectId,
  type ErrorInfo,
  type EventId,
  errorOf,
  type IdSource,
  type RunId,
  type SealedJson,
  sha256Hex,
  systemClock,
  toIsoInstant,
} from '@cohorte/base';
import { type CommandEnvelope, canonicalCommandBody, type PipelineState } from '@cohorte/protocol';
import {
  type AgentRecord,
  type ApprovalDecisionRecord,
  type ApprovalRecord,
  type ArtifactRecord,
  type BudgetRecord,
  type CommandRecord,
  type DurableEnvelope,
  type DurableEventType,
  type EffectIntent,
  type EffectRecord,
  type EffectState,
  type EventRecord,
  type FindingRecord,
  HOST_COMPUTED_RUN_KEYS,
  type IncarnationRecord,
  type LeaseToken,
  type LedgerEntry,
  type LockRecord,
  type LockRequest,
  type LockScope,
  locksConflict,
  type MigrationReport,
  NO_RUN_ID,
  type PhaseRecord,
  type RunRecord,
  type RunTreeRows,
  type SealedEventDraft,
  STATES_WITHOUT_HOST_COLUMNS,
  type StateStore,
  type StoredSnapshot,
  type StoreInfo,
  type StoreTx,
  StoreUsageError,
  type TransitionRecord,
  type VerifyChainResult,
  type WorktreeRecord,
} from '../contract.ts';
import { envelopeOf, toEventRecord, verifyEventRecords } from './chain.ts';

export const MEMORY_SCHEMA_VERSION = 1;
const KEPT_SNAPSHOTS = 3;

/** Composite keys: a NUL can appear in no id, path or slot. */
const k = (...parts: (string | number)[]): string => parts.join('\x00');

interface State {
  runs: Map<RunId, RunRecord>;
  events: Map<RunId, EventRecord[]>;
  eventIds: Set<EventId>;
  transitions: Map<string, TransitionRecord>;
  phases: Map<string, PhaseRecord>;
  agents: Map<string, AgentRecord>;
  incarnations: Map<string, IncarnationRecord>;
  worktrees: Map<string, WorktreeRecord>;
  ledger: Map<string, LedgerEntry>;
  effects: Map<EffectId, EffectRecord>;
  effectKeys: Map<string, EffectId>;
  approvals: Map<ApprovalId, ApprovalRecord>;
  approvalKeys: Map<string, ApprovalId>;
  budgets: Map<string, BudgetRecord>;
  artifacts: Map<string, ArtifactRecord>;
  findings: Map<string, FindingRecord>;
  commands: Map<CommandId, CommandRecord>;
  locks: Map<string, LockRecord>;
  /** highest fencing token ever issued per (scope, key): a lock taken again after a release still moves forward */
  fencing: Map<string, number>;
  snapshots: Map<RunId, StoredSnapshot[]>;
}

const emptyState = (): State => ({
  runs: new Map(),
  events: new Map(),
  eventIds: new Set(),
  transitions: new Map(),
  phases: new Map(),
  agents: new Map(),
  incarnations: new Map(),
  worktrees: new Map(),
  ledger: new Map(),
  effects: new Map(),
  effectKeys: new Map(),
  approvals: new Map(),
  approvalKeys: new Map(),
  budgets: new Map(),
  artifacts: new Map(),
  findings: new Map(),
  commands: new Map(),
  locks: new Map(),
  fencing: new Map(),
  snapshots: new Map(),
});

const usage = (message: string): StoreUsageError => new StoreUsageError(message);
const copy = <T>(value: T): T => structuredClone(value);
const isThenable = (value: unknown): boolean =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

function assertHostColumns(run: RunRecord): void {
  if (STATES_WITHOUT_HOST_COLUMNS.includes(run.state)) return;
  // `== null`, not `=== undefined`: the DDL's CHECK is `IS NOT NULL`, and `runtimePin?: JsonValue` makes
  // `runtimePin: null` well-typed — an absent column and a JSON `null` are the same missing column here.
  const missing = HOST_COMPUTED_RUN_KEYS.filter((key) => run[key] == null);
  if (missing.length > 0) {
    throw usage(`run ${run.runId} cannot be ${run.state} without its host-computed columns: ${missing.join(', ')}`);
  }
}

function enqueue(state: State, cmd: CommandEnvelope, clock: Clock): { status: EnqueueStatus; record: CommandRecord } {
  const bodySha256 = sha256Hex(canonicalCommandBody(cmd));
  const existing = state.commands.get(cmd.commandId);
  if (existing)
    return { status: existing.bodySha256 === bodySha256 ? 'duplicate' : 'id-reuse-conflict', record: existing };
  const now = clock.now();
  const record: CommandRecord = {
    commandId: cmd.commandId,
    ...(cmd.runId === undefined ? {} : { runId: cmd.runId }),
    type: cmd.type,
    bodySha256,
    envelope: copy(cmd),
    ...(cmd.auth ? { authScheme: cmd.auth.scheme, authValue: cmd.auth.value } : {}),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  state.commands.set(record.commandId, record);
  return { status: 'enqueued', record };
}
type EnqueueStatus = 'enqueued' | 'duplicate' | 'id-reuse-conflict';

class MemoryTx implements StoreTx {
  readonly #state: State;
  readonly #scope: RunId | 'project';
  readonly #lease: LeaseToken | null;
  readonly #clock: Clock;
  readonly #ids: IdSource;

  constructor(state: State, scope: RunId | 'project', lease: LeaseToken | null, clock: Clock, ids: IdSource) {
    this.#state = state;
    this.#scope = scope;
    this.#lease = lease;
    this.#clock = clock;
    this.#ids = ids;
  }

  /** The run of this transaction; refuses a project transaction and a write aimed at another run. */
  #own(id: RunId, what: string): RunRecord {
    if (this.#scope === 'project') throw usage(`${what} is run-scoped: not legal in a project transaction`);
    if (id !== this.#scope) throw usage(`${what} targets run ${id} inside a transaction scoped to ${this.#scope}`);
    const run = this.#state.runs.get(id);
    if (!run) throw usage(`${what}: run ${id} does not exist`);
    return run;
  }

  #scoped(what: string): RunRecord {
    if (this.#scope === 'project') throw usage(`${what} is run-scoped: not legal in a project transaction`);
    return this.#own(this.#scope, what);
  }

  appendEvents(drafts: readonly SealedEventDraft[]): DurableEnvelope[] {
    const run = this.#scoped('appendEvents');
    const rows = this.#state.events.get(run.runId) ?? [];
    this.#state.events.set(run.runId, rows);
    const appended: DurableEnvelope[] = [];
    for (const draft of drafts) {
      if (draft.runId !== run.runId) throw usage(`appendEvents: an event of run ${draft.runId} in run ${run.runId}`);
      if (this.#state.eventIds.has(draft.eventId)) throw usage(`appendEvents: eventId ${draft.eventId} exists`);
      const record = toEventRecord(draft, run.lastSequence + 1, run.lastHash);
      rows.push(record);
      this.#state.eventIds.add(record.eventId);
      run.lastSequence = record.sequence;
      run.lastHash = record.hash;
      appended.push(envelopeOf(record));
    }
    if (drafts.length > 0) run.version += 1;
    return appended;
  }

  recordTransition(t: TransitionRecord): 'recorded' | 'duplicate' {
    this.#own(t.runId, 'recordTransition');
    const key = k(t.runId, t.idempotencyKey);
    if (this.#state.transitions.has(key)) return 'duplicate';
    this.#state.transitions.set(key, copy(t));
    return 'recorded';
  }

  putRun(r: RunRecord): void {
    const existing = this.#state.runs.get(r.runId);
    if (this.#scope === 'project') {
      if (existing) throw usage(`putRun: run ${r.runId} exists; a project transaction may only CREATE a run`);
    } else {
      // Creation belongs to the project transaction alone (4.3 #1: run row + signed start command, one atomic write).
      // A run-scoped transaction may only REWRITE the run it is scoped to, so a run can never be born without its
      // start command just because its holder owns a run-scope lease.
      this.#own(r.runId, 'putRun');
    }
    const next = copy(r);
    // Store-assigned: only appendEvents moves them.
    next.lastSequence = existing?.lastSequence ?? 0;
    next.lastHash = existing?.lastHash ?? '';
    next.version = existing?.version ?? 0;
    assertHostColumns(next);
    this.#state.runs.set(next.runId, next);
  }

  patchRun(id: RunId, p: Partial<RunRecord>): void {
    const run = this.#own(id, 'patchRun');
    const { runId: _runId, lastSequence: _seq, lastHash: _hash, version: _version, ...patch } = copy(p);
    const next: RunRecord = { ...run, ...patch };
    assertHostColumns(next);
    this.#state.runs.set(id, next);
  }

  putPhase(p: PhaseRecord): void {
    this.#own(p.runId, 'putPhase');
    this.#state.phases.set(k(p.runId, p.phaseRunId), copy(p));
  }

  putAgent(a: AgentRecord): void {
    this.#own(a.runId, 'putAgent');
    this.#state.agents.set(k(a.runId, a.agentId), copy(a));
  }

  putIncarnation(i: IncarnationRecord): void {
    this.#own(i.runId, 'putIncarnation');
    if (!this.#state.agents.has(k(i.runId, i.agentId))) throw usage(`putIncarnation: unknown agent ${i.agentId}`);
    this.#state.incarnations.set(k(i.runId, i.agentId, i.incarnation), copy(i));
  }

  putWorktree(w: WorktreeRecord): void {
    this.#own(w.runId, 'putWorktree');
    this.#state.worktrees.set(k(w.runId, w.slot), copy(w));
  }

  putLedger(e: LedgerEntry): void {
    this.#own(e.runId, 'putLedger');
    this.#state.ledger.set(k(e.runId, e.slot, e.path), copy(e));
  }

  clearLedger(id: RunId, slot: string, upToEffectSeq: number): void {
    this.#own(id, 'clearLedger');
    for (const [key, entry] of this.#state.ledger) {
      if (entry.runId === id && entry.slot === slot && entry.effectSeq <= upToEffectSeq) this.#state.ledger.delete(key);
    }
  }

  putApproval(a: ApprovalRecord): 'created' | 'exists' {
    this.#own(a.runId, 'putApproval');
    const key = k(a.runId, a.idempotencyKey);
    if (this.#state.approvalKeys.has(key) || this.#state.approvals.has(a.approvalId)) return 'exists';
    this.#state.approvalKeys.set(key, a.approvalId);
    this.#state.approvals.set(a.approvalId, copy(a));
    return 'created';
  }

  resolveApproval(id: ApprovalId, d: ApprovalDecisionRecord): 'resolved' | 'already-resolved' {
    const row = this.#state.approvals.get(id);
    if (!row) throw usage(`resolveApproval: unknown approval ${id}`);
    this.#own(row.runId, 'resolveApproval');
    if (d.answer !== 'allow-once' && d.answer !== 'allow-for-run' && d.answer !== 'deny') {
      // The SYSTEM withdraws a grant nobody used (4.5: the binding changed, or it expired).
      const unused = row.status === 'allow-for-run' || (row.status === 'allow-once' && !row.consumedByEffect);
      if (row.status !== 'pending' && !unused) return 'already-resolved';
    } else if (row.status !== 'pending') {
      return 'already-resolved';
    }
    const { auth, resolvedSeq, ...decision } = copy(d);
    row.status = d.answer;
    row.decision = decision;
    if (auth) row.commandAuth = auth;
    row.resolvedSeq = resolvedSeq;
    row.resolvedAt = d.decidedAt;
    return 'resolved';
  }

  findGrant(id: RunId, grantKey: string): ApprovalRecord | undefined {
    this.#own(id, 'findGrant');
    const live = [...this.#state.approvals.values()].filter(
      (row) =>
        row.runId === id &&
        row.grantKey === grantKey &&
        (row.status === 'allow-for-run' || (row.status === 'allow-once' && !row.consumedByEffect)),
    );
    // A standing grant first: spending a one-shot while one exists would waste it.
    const found = live.find((row) => row.status === 'allow-for-run') ?? live[0];
    return found && copy(found);
  }

  setBudget(b: BudgetRecord): void {
    this.#own(b.runId, 'setBudget');
    this.#state.budgets.set(k(b.runId, b.level, b.scopeId), copy(b));
  }

  putArtifact(a: ArtifactRecord): void {
    this.#own(a.runId, 'putArtifact');
    this.#state.artifacts.set(k(a.runId, a.artifactId), copy(a));
  }

  putFinding(f: FindingRecord): void {
    this.#own(f.runId, 'putFinding');
    this.#state.findings.set(k(f.runId, f.findingId), copy(f));
  }

  #consumeGrant(run: RunRecord, grant: ApprovalId, by: EffectId): void {
    const row = this.#state.approvals.get(grant);
    const refuse = (why: string): CohorteError =>
      new CohorteError(errorOf('conflict/unexpected', `approval ${grant} cannot authorise effect ${by}: ${why}`));
    if (!row || row.runId !== run.runId) throw refuse('no such approval in this run');
    if (row.status === 'allow-for-run') return;
    if (row.status !== 'allow-once') throw refuse(`its status is ${row.status}`);
    if (row.consumedByEffect === by) return;
    if (row.consumedByEffect) throw refuse(`already consumed by ${row.consumedByEffect}`);
    row.consumedByEffect = by;
  }

  beginEffect(
    e: EffectIntent,
  ):
    | { status: 'started'; effectId: EffectId }
    | { status: 'already-done'; record: EffectRecord }
    | { status: 'open'; record: EffectRecord } {
    const run = this.#own(e.runId, 'beginEffect');
    const key = k(e.runId, e.idempotencyKey);
    const existingId = this.#state.effectKeys.get(key);
    const existing = existingId && this.#state.effects.get(existingId);
    if (existing && existing.state === 'done') return { status: 'already-done', record: copy(existing) };
    if (existing && (existing.state === 'intent' || existing.state === 'in-doubt')) {
      return { status: 'open', record: copy(existing) };
    }
    // Fresh, or a `failed` / `compensated` row begun again under its own key: the row goes back to `intent` as a NEW
    // attempt — it keeps its effectId and createdAt, and the outcome of the previous attempt (`result`, `error`,
    // `compensatedBy`) is dropped, because the row is rebuilt from the intent alone.
    const effectId = existing?.effectId ?? this.#ids.next<'EffectId'>('eff');
    if (e.consumesGrant) this.#consumeGrant(run, e.consumesGrant, effectId);
    const now = this.#clock.now();
    const { runId, idempotencyKey, kind, replayClass, request, verify, ...optional } = copy(e);
    this.#state.effects.set(effectId, {
      effectId,
      runId,
      idempotencyKey,
      kind,
      replayClass,
      state: 'intent',
      request,
      verify,
      ...optional,
      fencingToken: this.#lease?.fencingToken ?? 0,
      intentSeq: run.lastSequence,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.#state.effectKeys.set(key, effectId);
    return { status: 'started', effectId };
  }

  #openEffect(id: EffectId, what: string, from: readonly EffectState[]): { effect: EffectRecord; run: RunRecord } {
    const effect = this.#state.effects.get(id);
    if (!effect) throw usage(`${what}: unknown effect ${id}`);
    const run = this.#own(effect.runId, what);
    if (!from.includes(effect.state)) throw usage(`${what}: effect ${id} is ${effect.state}`);
    return { effect, run };
  }

  completeEffect(id: EffectId, result: SealedJson, post?: { treeDigest?: string; head?: string }): void {
    const { effect, run } = this.#openEffect(id, 'completeEffect', ['intent', 'in-doubt']);
    effect.state = 'done';
    effect.result = copy(result);
    delete effect.error;
    effect.doneSeq = run.lastSequence;
    effect.updatedAt = this.#clock.now();
    const worktree = effect.slot === undefined ? undefined : this.#state.worktrees.get(k(run.runId, effect.slot));
    if (worktree && post?.treeDigest !== undefined) worktree.lastTreeDigest = post.treeDigest;
  }

  failEffect(id: EffectId, error: ErrorInfo): void {
    const { effect, run } = this.#openEffect(id, 'failEffect', ['intent', 'in-doubt']);
    effect.state = 'failed';
    effect.error = copy(error);
    effect.doneSeq = run.lastSequence;
    effect.updatedAt = this.#clock.now();
  }

  markEffectInDoubt(id: EffectId, note: string): void {
    const { effect } = this.#openEffect(id, 'markEffectInDoubt', ['intent', 'in-doubt']);
    effect.state = 'in-doubt';
    effect.error = copy(errorOf('human-required/in-doubt-effect', note));
    effect.updatedAt = this.#clock.now();
  }

  compensateEffects(ids: EffectId[], byEffect: EffectId): void {
    if (!this.#state.effects.has(byEffect)) throw usage(`compensateEffects: unknown compensating effect ${byEffect}`);
    for (const id of ids) {
      const { effect } = this.#openEffect(id, 'compensateEffects', ['intent', 'done', 'failed', 'in-doubt']);
      effect.state = 'compensated';
      effect.compensatedBy = byEffect;
      effect.updatedAt = this.#clock.now();
    }
  }

  enqueueCommand(cmd: CommandEnvelope): EnqueueStatus {
    return enqueue(this.#state, cmd, this.#clock).status;
  }

  /** A command is handled where it belongs: a run's commands in that run's transaction, a project command in a project one. */
  #command(id: CommandId, what: string): CommandRecord | undefined {
    const row = this.#state.commands.get(id);
    if (!row) return undefined;
    const home = row.runId ?? 'project';
    if (home !== this.#scope) throw usage(`${what}: command ${id} belongs to ${home}, not to ${this.#scope}`);
    return row;
  }

  claimCommand(id: CommandId, hostId: string): boolean {
    const row = this.#command(id, 'claimCommand');
    if (row?.status !== 'pending') return false;
    row.status = 'claimed';
    row.claimedBy = hostId;
    row.updatedAt = this.#clock.now();
    return true;
  }

  finishCommand(id: CommandId, outcome: 'completed' | 'rejected', resultEventId: EventId): void {
    const row = this.#command(id, 'finishCommand');
    if (!row) throw usage(`finishCommand: unknown command ${id}`);
    if (row.status === 'completed' || row.status === 'rejected') {
      throw usage(`finishCommand: command ${id} is already ${row.status}`);
    }
    row.status = outcome;
    row.resultEventId = resultEventId;
    row.updatedAt = this.#clock.now();
  }

  writeSnapshot(s: StoredSnapshot): void {
    const run = this.#own(s.runId, 'writeSnapshot');
    if (s.atSequence > run.lastSequence) {
      throw usage(`writeSnapshot: at ${s.atSequence} but the journal of ${s.runId} ends at ${run.lastSequence}`);
    }
    const kept = (this.#state.snapshots.get(s.runId) ?? []).filter((one) => one.atSequence !== s.atSequence);
    kept.push(copy(s));
    kept.sort((a, b) => a.atSequence - b.atSequence);
    this.#state.snapshots.set(s.runId, kept.slice(-KEPT_SNAPSHOTS));
  }

  run(): RunRecord {
    return copy(this.#scoped('run'));
  }

  #read<T>(what: string, table: Map<string, T>, ...key: (string | number)[]): T | undefined {
    const run = this.#scoped(what);
    const row = table.get(k(run.runId, ...key));
    return row && copy(row);
  }

  agent(id: AgentId): AgentRecord | undefined {
    return this.#read('agent', this.#state.agents, id);
  }

  incarnation(id: AgentId, n: number): IncarnationRecord | undefined {
    return this.#read('incarnation', this.#state.incarnations, id, n);
  }

  worktree(slot: string): WorktreeRecord | undefined {
    return this.#read('worktree', this.#state.worktrees, slot);
  }

  approval(id: ApprovalId): ApprovalRecord | undefined {
    const run = this.#scoped('approval');
    const row = this.#state.approvals.get(id);
    return row && row.runId === run.runId ? copy(row) : undefined;
  }

  effectByKey(key: string): EffectRecord | undefined {
    const run = this.#scoped('effectByKey');
    const id = this.#state.effectKeys.get(k(run.runId, key));
    const row = id && this.#state.effects.get(id);
    return row ? copy(row) : undefined;
  }

  budget(level: string, scopeId: string): BudgetRecord | undefined {
    return this.#read('budget', this.#state.budgets, level, scopeId);
  }
}

export interface MemoryStateStoreOptions {
  clock?: Clock;
  ids?: IdSource;
}

export class MemoryStateStore implements StateStore {
  readonly kind = 'memory';
  #state = emptyState();
  #open = false;
  readonly #clock: Clock;
  readonly #ids: IdSource;

  constructor(options: MemoryStateStoreOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? createUuidV7IdSource();
  }

  #live(): State {
    if (!this.#open) throw usage('the store is not open');
    return this.#state;
  }

  async open(): Promise<StoreInfo> {
    this.#open = true;
    return { kind: this.kind, schemaVersion: MEMORY_SCHEMA_VERSION, location: ':memory:' };
  }

  async close(): Promise<void> {
    this.#open = false;
  }

  async migrate(mode: 'check' | 'apply'): Promise<MigrationReport> {
    return { mode, current: MEMORY_SCHEMA_VERSION, target: MEMORY_SCHEMA_VERSION, pending: [], applied: [] };
  }

  /** A JSON dump, one array per table: enough to look at a failed test, not a restore format. */
  async backup(toPath: string): Promise<void> {
    const tables = Object.fromEntries(
      Object.entries(this.#live()).map(([name, table]) => [
        name,
        table instanceof Map ? [...table.values()] : [...(table as Set<string>)],
      ]),
    );
    await writeFile(toPath, `${JSON.stringify(tables, null, 2)}\n`, { mode: 0o600 });
  }

  async transact<T>(
    scope: { runId: RunId } | 'project',
    lease: LeaseToken | null,
    body: (tx: StoreTx) => T,
    opts?: { expectedSequence?: number },
  ): Promise<T> {
    const state = this.#live();
    const target = scope === 'project' ? scope : scope.runId;
    if (target !== 'project') {
      if (!lease) throw usage(`a transaction on run ${target} needs the run lease`);
      if (lease.runId !== target) throw usage(`the lease of run ${lease.runId || '(none)'} cannot write run ${target}`);
    }
    if (lease) {
      // I6: the first statement of every write transaction. A run-scoped write must carry the RUN's OWN lock
      // (`scope:'run'`, `key: runId`): a lease on any other lock that merely names the run — a zone lock, which the
      // supervisor routinely takes with `owner.runId` set — would let a host fenced out of the run keep writing it,
      // and two writers for one run is exactly what I6 forbids.
      const lock = state.locks.get(lease.lockId);
      const held =
        lock !== undefined &&
        lock.fencingToken === lease.fencingToken &&
        lock.ownerHostId === lease.hostId &&
        (target === 'project' || (lock.scope === 'run' && lock.key === target));
      if (!held) {
        throw new CohorteError(
          errorOf(
            'conflict/lease-lost',
            `lock ${lease.lockId} is not the lock held with fencing token ${lease.fencingToken} for ${target}`,
          ),
        );
      }
    }
    if (opts?.expectedSequence !== undefined) {
      if (target === 'project') throw usage('expectedSequence needs a run-scoped transaction');
      const at = state.runs.get(target)?.lastSequence;
      if (at !== opts.expectedSequence) {
        throw new CohorteError(
          errorOf('conflict/unexpected', `run ${target} is at sequence ${at}, expected ${opts.expectedSequence}`),
        );
      }
    }
    const working = copy(state);
    const result = body(new MemoryTx(working, target, lease, this.#clock, this.#ids));
    if (isThenable(result)) throw usage('a transaction body must be synchronous: it returned a thenable');
    this.#state = working;
    return result;
  }

  async getRun(id: RunId): Promise<RunRecord | undefined> {
    const run = this.#live().runs.get(id);
    return run && copy(run);
  }

  async listRuns(q: { states?: PipelineState[]; limit: number; offset: number }): Promise<RunRecord[]> {
    const wanted = q.states;
    return [...this.#live().runs.values()]
      .filter((run) => !wanted || wanted.includes(run.state))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId))
      .slice(q.offset, q.offset + q.limit)
      .map(copy);
  }

  async readEvents(
    id: RunId,
    q: { afterSequence: number; limit: number; types?: DurableEventType[] },
  ): Promise<DurableEnvelope[]> {
    const types: readonly string[] | undefined = q.types;
    return (this.#live().events.get(id) ?? [])
      .filter((row) => row.sequence > q.afterSequence && (!types || types.includes(row.type)))
      .slice(0, q.limit)
      .map(envelopeOf);
  }

  async loadSnapshot(id: RunId): Promise<StoredSnapshot | undefined> {
    const latest = this.#live().snapshots.get(id)?.at(-1);
    return latest && copy(latest);
  }

  async readRunTree(id: RunId): Promise<RunTreeRows> {
    const state = this.#live();
    const run = state.runs.get(id);
    if (!run) throw usage(`readRunTree: run ${id} does not exist`);
    const of = <T extends { runId: RunId }>(table: Map<string, T>): T[] =>
      [...table.values()].filter((row) => row.runId === id).map(copy);
    return {
      run: copy(run),
      phases: of(state.phases),
      agents: of(state.agents),
      incarnations: of(state.incarnations),
      worktrees: of(state.worktrees),
      approvals: of(state.approvals),
      budgets: of(state.budgets),
      locks: [...state.locks.values()].filter((lock) => lock.ownerRunId === id).map(copy),
    };
  }

  async listPendingApprovals(id?: RunId): Promise<ApprovalRecord[]> {
    return [...this.#live().approvals.values()]
      .filter((row) => row.status === 'pending' && (id === undefined || row.runId === id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.approvalId.localeCompare(b.approvalId))
      .map(copy);
  }

  async listEffects(id: RunId, q: { states: EffectState[] }): Promise<EffectRecord[]> {
    return [...this.#live().effects.values()]
      .filter((row) => row.runId === id && q.states.includes(row.state))
      .map(copy);
  }

  async readLedger(id: RunId, slot: string): Promise<LedgerEntry[]> {
    return [...this.#live().ledger.values()]
      .filter((row) => row.runId === id && row.slot === slot)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(copy);
  }

  async getArtifact(id: RunId, artifact: ArtifactId): Promise<ArtifactRecord | undefined> {
    const row = this.#live().artifacts.get(k(id, artifact));
    return row && copy(row);
  }

  async verifyChain(id: RunId, key?: Uint8Array): Promise<VerifyChainResult> {
    const state = this.#live();
    const run = state.runs.get(id);
    // A purgeable run's journal may legitimately be gone: its row is no witness of a missing tail.
    const tail = run && !run.purgeable ? { lastSequence: run.lastSequence, lastHash: run.lastHash } : undefined;
    return verifyEventRecords(id, state.events.get(id) ?? [], key, tail);
  }

  async enqueueCommand(cmd: CommandEnvelope): Promise<{ status: EnqueueStatus; record: CommandRecord }> {
    const { status, record } = enqueue(this.#live(), cmd, this.#clock);
    return { status, record: copy(record) };
  }

  async pendingCommands(id: RunId): Promise<CommandRecord[]> {
    return [...this.#live().commands.values()]
      .filter((row) => row.runId === id && row.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commandId.localeCompare(b.commandId))
      .map(copy);
  }

  async getCommand(id: CommandId): Promise<CommandRecord | undefined> {
    const row = this.#live().commands.get(id);
    return row && copy(row);
  }

  #grant(state: State, req: LockRequest, fencingToken: number): LeaseToken {
    const now = Date.parse(this.#clock.now());
    const lock: LockRecord = {
      lockId: this.#ids.next<'LockId'>('lck'),
      scope: req.scope,
      key: req.key,
      mode: req.mode,
      ...(req.owner.runId === undefined ? {} : { ownerRunId: req.owner.runId }),
      ownerHostId: req.owner.hostId,
      ownerPid: req.owner.pid,
      ownerStartToken: req.owner.startToken,
      fencingToken,
      ...(req.zones ? { zones: [...req.zones] } : {}),
      leaseExpiresAt: toIsoInstant(now + req.ttlMs),
      acquiredAt: toIsoInstant(now),
    };
    state.locks.set(lock.lockId, lock);
    const counter = k(req.scope, req.key);
    state.fencing.set(counter, Math.max(state.fencing.get(counter) ?? 0, fencingToken));
    return {
      lockId: lock.lockId,
      runId: req.owner.runId ?? NO_RUN_ID,
      hostId: req.owner.hostId,
      fencingToken,
    };
  }

  async acquireLock(req: LockRequest): Promise<{ ok: true; lease: LeaseToken } | { ok: false; heldBy: LockRecord[] }> {
    const state = this.#live();
    const heldBy = [...state.locks.values()].filter((lock) => locksConflict(lock, req));
    if (heldBy.length > 0) return { ok: false, heldBy: heldBy.map(copy) };
    return { ok: true, lease: this.#grant(state, req, (state.fencing.get(k(req.scope, req.key)) ?? 0) + 1) };
  }

  async stealLock(req: LockRequest, expected: LockRecord): Promise<LeaseToken> {
    const state = this.#live();
    const current = state.locks.get(expected.lockId);
    if (!current || current.fencingToken !== expected.fencingToken) {
      throw new CohorteError(
        errorOf('conflict/lease-lost', `lock ${expected.lockId} changed since it was read: nothing to steal`),
      );
    }
    const others = [...state.locks.values()].filter(
      (lock) => lock.lockId !== current.lockId && locksConflict(lock, req),
    );
    if (others.length > 0) {
      throw new CohorteError(
        errorOf('conflict/unexpected', `stealing ${current.lockId} would still conflict with ${others.length} lock(s)`),
      );
    }
    state.locks.delete(current.lockId);
    return this.#grant(state, req, current.fencingToken + 1);
  }

  async renewLock(lockId: string, ttlMs: number): Promise<boolean> {
    const lock = this.#live().locks.get(lockId);
    if (!lock) return false;
    lock.leaseExpiresAt = toIsoInstant(Date.parse(this.#clock.now()) + ttlMs);
    return true;
  }

  async releaseLock(lockId: string): Promise<void> {
    this.#live().locks.delete(lockId);
  }

  async listLocks(q?: { scope?: LockScope }): Promise<LockRecord[]> {
    return [...this.#live().locks.values()].filter((lock) => !q?.scope || lock.scope === q.scope).map(copy);
  }

  // ── behind the contract: what the conformance hooks of a memory store call (never product code) ───────────────
  /** Damages the journal the way somebody with write access to the storage would. */
  damageJournal(id: RunId, damage: { kind: 'rewrite' | 'remove' | 'duplicate'; sequence: number }): boolean {
    const rows = this.#live().events.get(id) ?? [];
    const index = rows.findIndex((row) => row.sequence === damage.sequence);
    const row = rows[index];
    if (!row) return false;
    if (damage.kind === 'remove') rows.splice(index, 1);
    else if (damage.kind === 'duplicate') rows.splice(index + 1, 0, copy(row));
    else row.envelope = row.envelope.replace('"summary":"', '"summary":"rewritten ');
    return true;
  }

  /** The store's own protections, as the SQLite triggers state them. */
  rawRewriteEvent(_id: RunId, _sequence: number): never {
    throw new Error('events are append-only');
  }

  rawPurgeEvents(id: RunId): void {
    const state = this.#live();
    if (!state.runs.get(id)?.purgeable) throw new Error('events are append-only');
    for (const row of state.events.get(id) ?? []) state.eventIds.delete(row.eventId);
    state.events.delete(id);
  }

  /** Retention-only administrative operation; mirrors the SQLite store's
   * purgeEvents capability while keeping it outside the StateStore contract. */
  async purgeEvents(id: RunId): Promise<number> {
    const before = this.#live().events.get(id)?.length ?? 0;
    this.rawPurgeEvents(id);
    return before;
  }

  snapshotCount(id: RunId): number {
    return this.#live().snapshots.get(id)?.length ?? 0;
  }
}

export function createMemoryStateStore(options: MemoryStateStoreOptions = {}): MemoryStateStore {
  return new MemoryStateStore(options);
}
