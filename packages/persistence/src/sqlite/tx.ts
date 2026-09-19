// `StoreTx` over `node:sqlite` (DESIGN 2.4): every method issues real SQL inside the enclosing `BEGIN IMMEDIATE` (the
// caller — `SqliteStateStore.transact` — owns that transaction). Reads use plain `SELECT`s rather than a JS-side
// cache: a connection sees its own uncommitted writes, so "read after write, inside one transaction" falls out of
// SQLite for free and needs no bookkeeping here. Mirrors `memory/state-store.ts`'s `MemoryTx` method for method: the
// two stores must pass the identical conformance suite (ADR-0002).
import {
  type AgentId,
  type ApprovalId,
  type Clock,
  CohorteError,
  type CommandId,
  type EffectId,
  type ErrorInfo,
  type EventId,
  errorOf,
  type IdSource,
  type RunId,
  type SealedJson,
} from '@cohorte/base';
import type { CommandEnvelope } from '@cohorte/protocol';
import {
  type AgentRecord,
  type ApprovalDecisionRecord,
  type ApprovalRecord,
  type ArtifactRecord,
  type BudgetRecord,
  type CommandRecord,
  type DurableEnvelope,
  type EffectIntent,
  type EffectRecord,
  type EffectState,
  type FindingRecord,
  HOST_COMPUTED_RUN_KEYS,
  type IncarnationRecord,
  type LeaseToken,
  type LedgerEntry,
  type PhaseRecord,
  type RunRecord,
  type SealedEventDraft,
  type SqlDriver,
  STATES_WITHOUT_HOST_COLUMNS,
  type StoredSnapshot,
  type StoreTx,
  StoreUsageError,
  type TransitionRecord,
  type WorktreeRecord,
} from '../contract.ts';
import { envelopeOf, toEventRecord } from '../memory/chain.ts';
import { type EnqueueStatus, enqueueCommandRow } from './commands.ts';
import { columnNamesOf, fromRow, getRow, insertRow, type Row, toRow, upsertRow } from './marshal.ts';

const usage = (message: string): StoreUsageError => new StoreUsageError(message);

/** `SQLITE_CONSTRAINT_PRIMARYKEY` / `SQLITE_CONSTRAINT_UNIQUE`, the two extended result codes of a uniqueness clash. */
const UNIQUENESS_ERRCODES = [1555, 2067];

/**
 * `node:sqlite` reports EVERY constraint failure under the single code `ERR_SQLITE_ERROR` — NOT NULL, CHECK (including
 * `json_valid(…)`), foreign keys and the `events_no_update`/`events_no_delete` triggers' `RAISE(ABORT)` alike. Reading
 * that one code as "this row already exists" would turn a genuine corruption into a benign-looking no-op in the one
 * layer whose job is to refuse rather than guess, so narrow it to the uniqueness case and rethrow everything else.
 */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ERR_SQLITE_ERROR') return false;
  const { errcode } = error as Error & { errcode?: number };
  if (typeof errcode === 'number') return UNIQUENESS_ERRCODES.includes(errcode);
  return /UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(error.message);
}

/** Same rule as `memory/state-store.ts`, duplicated here rather than imported: it is 4 lines over 2 exported constants, and `sqlite/**` may not depend on `memory/**` for behaviour (only for the shared, store-agnostic chain math of `chain.ts`). */
function assertHostColumns(run: RunRecord): void {
  if (STATES_WITHOUT_HOST_COLUMNS.includes(run.state)) return;
  // "Set" means non-null (the DDL's CHECK is `IS NOT NULL`): an explicit JSON `null` is well-typed for
  // `runtimePin?: JsonValue` but still leaves the column unset.
  const missing = HOST_COMPUTED_RUN_KEYS.filter((key) => run[key] === undefined || run[key] === null);
  if (missing.length > 0) {
    throw usage(`run ${run.runId} cannot be ${run.state} without its host-computed columns: ${missing.join(', ')}`);
  }
}

const RUN_UPDATE_COLUMNS = columnNamesOf('runs').filter(
  (column) => !['run_id', 'last_sequence', 'last_hash', 'version'].includes(column),
);

export class SqliteTx implements StoreTx {
  readonly #driver: SqlDriver;
  readonly #scope: RunId | 'project';
  readonly #lease: LeaseToken | null;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  #closed = false;

  constructor(driver: SqlDriver, scope: RunId | 'project', lease: LeaseToken | null, clock: Clock, ids: IdSource) {
    this.#driver = driver;
    this.#scope = scope;
    this.#lease = lease;
    this.#clock = clock;
    this.#ids = ids;
  }

  /**
   * Called by `SqliteStateStore.transact` in a `finally`, on commit, on rollback and on a thenable body alike. A
   * `StoreTx` writes straight to the connection, so one that outlives its `BEGIN IMMEDIATE` — the continuation of an
   * async body keeps a live reference to it — would write in autocommit, unfenced and irrevocably (I6). Not part of
   * `StoreTx`: the contract hands bodies a tx, never the right to end one.
   */
  close(): void {
    this.#closed = true;
  }

  /** At the top of every method: a dead tx refuses, it does not half-apply. */
  #alive(): void {
    if (this.#closed) throw usage('this StoreTx is no longer valid: its transaction has ended');
  }

  #readRun(id: RunId): RunRecord | undefined {
    return getRow<RunRecord>(this.#driver, 'runs', ['run_id'], [id]);
  }

  /** The run of this transaction; refuses a project transaction and a write aimed at another run. */
  #own(id: RunId, what: string): RunRecord {
    if (this.#scope === 'project') throw usage(`${what} is run-scoped: not legal in a project transaction`);
    if (id !== this.#scope) throw usage(`${what} targets run ${id} inside a transaction scoped to ${this.#scope}`);
    const run = this.#readRun(id);
    if (!run) throw usage(`${what}: run ${id} does not exist`);
    return run;
  }

  #scoped(what: string): RunRecord {
    if (this.#scope === 'project') throw usage(`${what} is run-scoped: not legal in a project transaction`);
    return this.#own(this.#scope, what);
  }

  appendEvents(drafts: readonly SealedEventDraft[]): DurableEnvelope[] {
    this.#alive();
    const run = this.#scoped('appendEvents');
    let lastSequence = run.lastSequence;
    let lastHash = run.lastHash;
    const appended: DurableEnvelope[] = [];
    for (const draft of drafts) {
      if (draft.runId !== run.runId) throw usage(`appendEvents: an event of run ${draft.runId} in run ${run.runId}`);
      const sequence = lastSequence + 1;
      const record = toEventRecord(draft, sequence, lastHash);
      try {
        insertRow(this.#driver, 'events', record as unknown as Row);
      } catch (error) {
        if (isUniqueViolation(error)) throw usage(`appendEvents: eventId ${draft.eventId} exists`);
        throw error;
      }
      lastSequence = sequence;
      lastHash = record.hash;
      appended.push(envelopeOf(record));
    }
    if (drafts.length > 0) {
      this.#driver
        .prepare('UPDATE runs SET last_sequence=?, last_hash=?, version=version+1 WHERE run_id=?')
        .run(lastSequence, lastHash, run.runId);
    }
    return appended;
  }

  recordTransition(t: TransitionRecord): 'recorded' | 'duplicate' {
    this.#alive();
    this.#own(t.runId, 'recordTransition');
    try {
      insertRow(this.#driver, 'transitions', t as unknown as Row);
      return 'recorded';
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  putRun(r: RunRecord): void {
    this.#alive();
    const existing = this.#readRun(r.runId);
    if (this.#scope === 'project') {
      if (existing) throw usage(`putRun: run ${r.runId} exists; a project transaction may only CREATE a run`);
    } else if (r.runId !== this.#scope) {
      throw usage(`putRun targets run ${r.runId} inside a transaction scoped to ${this.#scope}`);
    } else if (!existing) {
      // `start` = { IDLE run row + signed start command } in ONE project transaction (4.3 #1): a run-scoped
      // transaction may REWRITE its run, never mint one out of thin air.
      throw usage(`putRun: run ${r.runId} does not exist; a run-scoped transaction may only rewrite an existing run`);
    }
    const next: RunRecord = {
      ...r,
      lastSequence: existing?.lastSequence ?? 0,
      lastHash: existing?.lastHash ?? '',
      version: existing?.version ?? 0,
    };
    assertHostColumns(next);
    upsertRow(this.#driver, 'runs', ['run_id'], next as unknown as Row);
  }

  patchRun(id: RunId, p: Partial<RunRecord>): void {
    this.#alive();
    const run = this.#own(id, 'patchRun');
    const { runId: _runId, lastSequence: _seq, lastHash: _hash, version: _version, ...patch } = p;
    const next: RunRecord = { ...run, ...patch };
    assertHostColumns(next);
    const row = toRow('runs', next as unknown as Row);
    const sql = `UPDATE runs SET ${RUN_UPDATE_COLUMNS.map((column) => `${column}=?`).join(',')} WHERE run_id=?`;
    this.#driver.prepare(sql).run(...RUN_UPDATE_COLUMNS.map((column) => row[column]), id);
  }

  putPhase(p: PhaseRecord): void {
    this.#alive();
    this.#own(p.runId, 'putPhase');
    upsertRow(this.#driver, 'phases', ['run_id', 'phase_run_id'], p as unknown as Row);
  }

  putAgent(a: AgentRecord): void {
    this.#alive();
    this.#own(a.runId, 'putAgent');
    upsertRow(this.#driver, 'agents', ['run_id', 'agent_id'], a as unknown as Row);
  }

  putIncarnation(i: IncarnationRecord): void {
    this.#alive();
    this.#own(i.runId, 'putIncarnation');
    if (!getRow(this.#driver, 'agents', ['run_id', 'agent_id'], [i.runId, i.agentId])) {
      throw usage(`putIncarnation: unknown agent ${i.agentId}`);
    }
    upsertRow(this.#driver, 'agent_incarnations', ['run_id', 'agent_id', 'incarnation'], i as unknown as Row);
  }

  putWorktree(w: WorktreeRecord): void {
    this.#alive();
    this.#own(w.runId, 'putWorktree');
    upsertRow(this.#driver, 'worktrees', ['run_id', 'slot'], w as unknown as Row);
  }

  putLedger(e: LedgerEntry): void {
    this.#alive();
    this.#own(e.runId, 'putLedger');
    upsertRow(this.#driver, 'worktree_ledger', ['run_id', 'slot', 'path'], e as unknown as Row);
  }

  clearLedger(id: RunId, slot: string, upToEffectSeq: number): void {
    this.#alive();
    this.#own(id, 'clearLedger');
    this.#driver
      .prepare('DELETE FROM worktree_ledger WHERE run_id=? AND slot=? AND effect_seq<=?')
      .run(id, slot, upToEffectSeq);
  }

  putApproval(a: ApprovalRecord): 'created' | 'exists' {
    this.#alive();
    this.#own(a.runId, 'putApproval');
    const byKey = this.#driver
      .prepare('SELECT approval_id FROM approvals WHERE run_id=? AND idempotency_key=?')
      .get(a.runId, a.idempotencyKey);
    const byId = getRow(this.#driver, 'approvals', ['approval_id'], [a.approvalId]);
    if (byKey !== undefined || byId !== undefined) return 'exists';
    insertRow(this.#driver, 'approvals', a as unknown as Row);
    return 'created';
  }

  resolveApproval(id: ApprovalId, d: ApprovalDecisionRecord): 'resolved' | 'already-resolved' {
    this.#alive();
    const row = getRow<ApprovalRecord>(this.#driver, 'approvals', ['approval_id'], [id]);
    if (!row) throw usage(`resolveApproval: unknown approval ${id}`);
    this.#own(row.runId, 'resolveApproval');
    const isGrantAnswer = d.answer === 'allow-once' || d.answer === 'allow-for-run' || d.answer === 'deny';
    if (!isGrantAnswer) {
      const unused =
        row.status === 'allow-for-run' || (row.status === 'allow-once' && row.consumedByEffect === undefined);
      if (row.status !== 'pending' && !unused) return 'already-resolved';
    } else if (row.status !== 'pending') {
      return 'already-resolved';
    }
    const { auth, resolvedSeq, ...decision } = d;
    this.#driver
      .prepare(
        `UPDATE approvals SET status=?, decision_json=?, command_auth_json=COALESCE(?, command_auth_json),
         resolved_seq=?, resolved_at=? WHERE approval_id=?`,
      )
      .run(d.answer, JSON.stringify(decision), auth ? JSON.stringify(auth) : null, resolvedSeq, d.decidedAt, id);
    return 'resolved';
  }

  findGrant(id: RunId, grantKey: string): ApprovalRecord | undefined {
    this.#alive();
    this.#own(id, 'findGrant');
    const rows = (
      this.#driver
        .prepare(
          `SELECT * FROM approvals WHERE run_id=? AND grant_key=?
           AND (status='allow-for-run' OR (status='allow-once' AND consumed_by_effect IS NULL))
           ORDER BY requested_seq, approval_id`,
        )
        .all(id, grantKey) as Row[]
    ).map((row) => fromRow<ApprovalRecord>('approvals', row));
    return rows.find((row) => row.status === 'allow-for-run') ?? rows[0];
  }

  setBudget(b: BudgetRecord): void {
    this.#alive();
    this.#own(b.runId, 'setBudget');
    upsertRow(this.#driver, 'budgets', ['run_id', 'level', 'scope_id'], b as unknown as Row);
  }

  putArtifact(a: ArtifactRecord): void {
    this.#alive();
    this.#own(a.runId, 'putArtifact');
    upsertRow(this.#driver, 'artifacts', ['run_id', 'artifact_id'], a as unknown as Row);
  }

  putFinding(f: FindingRecord): void {
    this.#alive();
    this.#own(f.runId, 'putFinding');
    upsertRow(this.#driver, 'findings', ['run_id', 'finding_id'], f as unknown as Row);
  }

  #consumeGrant(run: RunRecord, grant: ApprovalId, by: EffectId): void {
    const row = getRow<ApprovalRecord>(this.#driver, 'approvals', ['approval_id'], [grant]);
    const refuse = (why: string): CohorteError =>
      new CohorteError(errorOf('conflict/unexpected', `approval ${grant} cannot authorise effect ${by}: ${why}`));
    if (!row || row.runId !== run.runId) throw refuse('no such approval in this run');
    if (row.status === 'allow-for-run') return;
    if (row.status !== 'allow-once') throw refuse(`its status is ${row.status}`);
    if (row.consumedByEffect === by) return;
    if (row.consumedByEffect !== undefined) throw refuse(`already consumed by ${row.consumedByEffect}`);
    this.#driver.prepare('UPDATE approvals SET consumed_by_effect=? WHERE approval_id=?').run(by, grant);
  }

  beginEffect(
    e: EffectIntent,
  ):
    | { status: 'started'; effectId: EffectId }
    | { status: 'already-done'; record: EffectRecord }
    | { status: 'open'; record: EffectRecord } {
    this.#alive();
    const run = this.#own(e.runId, 'beginEffect');
    const existingRow = this.#driver
      .prepare('SELECT * FROM effects WHERE run_id=? AND idempotency_key=?')
      .get(e.runId, e.idempotencyKey) as Row | undefined;
    const existing = existingRow && fromRow<EffectRecord>('effects', existingRow);
    if (existing && existing.state === 'done') return { status: 'already-done', record: existing };
    if (existing && (existing.state === 'intent' || existing.state === 'in-doubt')) {
      return { status: 'open', record: existing };
    }
    const effectId = existing?.effectId ?? this.#ids.next<'EffectId'>('eff');
    if (e.consumesGrant) this.#consumeGrant(run, e.consumesGrant, effectId);
    const now = this.#clock.now();
    const { runId, idempotencyKey, kind, replayClass, request, verify, ...optional } = e;
    const record: EffectRecord = {
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
    };
    upsertRow(this.#driver, 'effects', ['effect_id'], record as unknown as Row);
    return { status: 'started', effectId };
  }

  #openEffect(id: EffectId, what: string, from: readonly EffectState[]): { effect: EffectRecord; run: RunRecord } {
    const effect = getRow<EffectRecord>(this.#driver, 'effects', ['effect_id'], [id]);
    if (!effect) throw usage(`${what}: unknown effect ${id}`);
    const run = this.#own(effect.runId, what);
    if (!from.includes(effect.state)) throw usage(`${what}: effect ${id} is ${effect.state}`);
    return { effect, run };
  }

  completeEffect(id: EffectId, result: SealedJson, post?: { treeDigest?: string; head?: string }): void {
    this.#alive();
    const { effect, run } = this.#openEffect(id, 'completeEffect', ['intent', 'in-doubt']);
    this.#driver
      .prepare('UPDATE effects SET state=?, result_json=?, error_json=NULL, done_seq=?, updated_at=? WHERE effect_id=?')
      .run('done', JSON.stringify(result), run.lastSequence, this.#clock.now(), id);
    if (effect.slot !== undefined && post?.treeDigest !== undefined) {
      this.#driver
        .prepare('UPDATE worktrees SET last_tree_digest=? WHERE run_id=? AND slot=?')
        .run(post.treeDigest, run.runId, effect.slot);
    }
  }

  failEffect(id: EffectId, error: ErrorInfo): void {
    this.#alive();
    const { run } = this.#openEffect(id, 'failEffect', ['intent', 'in-doubt']);
    this.#driver
      .prepare('UPDATE effects SET state=?, error_json=?, done_seq=?, updated_at=? WHERE effect_id=?')
      .run('failed', JSON.stringify(error), run.lastSequence, this.#clock.now(), id);
  }

  markEffectInDoubt(id: EffectId, note: string): void {
    this.#alive();
    this.#openEffect(id, 'markEffectInDoubt', ['intent', 'in-doubt']);
    this.#driver
      .prepare('UPDATE effects SET state=?, error_json=?, updated_at=? WHERE effect_id=?')
      .run('in-doubt', JSON.stringify(errorOf('human-required/in-doubt-effect', note)), this.#clock.now(), id);
  }

  compensateEffects(ids: EffectId[], byEffect: EffectId): void {
    this.#alive();
    if (!getRow(this.#driver, 'effects', ['effect_id'], [byEffect])) {
      throw usage(`compensateEffects: unknown compensating effect ${byEffect}`);
    }
    for (const id of ids) {
      this.#openEffect(id, 'compensateEffects', ['intent', 'done', 'failed', 'in-doubt']);
      this.#driver
        .prepare('UPDATE effects SET state=?, compensated_by=?, updated_at=? WHERE effect_id=?')
        .run('compensated', byEffect, this.#clock.now(), id);
    }
  }

  enqueueCommand(cmd: CommandEnvelope): EnqueueStatus {
    this.#alive();
    return enqueueCommandRow(this.#driver, cmd, this.#clock).status;
  }

  #command(id: CommandId, what: string): CommandRecord | undefined {
    const row = getRow<CommandRecord>(this.#driver, 'commands', ['command_id'], [id]);
    if (!row) return undefined;
    const home = row.runId ?? 'project';
    if (home !== this.#scope) throw usage(`${what}: command ${id} belongs to ${home}, not to ${this.#scope}`);
    return row;
  }

  claimCommand(id: CommandId, hostId: string): boolean {
    this.#alive();
    const row = this.#command(id, 'claimCommand');
    if (row?.status !== 'pending') return false;
    this.#driver
      .prepare('UPDATE commands SET status=?, claimed_by=?, updated_at=? WHERE command_id=?')
      .run('claimed', hostId, this.#clock.now(), id);
    return true;
  }

  finishCommand(id: CommandId, outcome: 'completed' | 'rejected', resultEventId: EventId): void {
    this.#alive();
    const row = this.#command(id, 'finishCommand');
    if (!row) throw usage(`finishCommand: unknown command ${id}`);
    if (row.status === 'completed' || row.status === 'rejected') {
      throw usage(`finishCommand: command ${id} is already ${row.status}`);
    }
    this.#driver
      .prepare('UPDATE commands SET status=?, result_event_id=?, updated_at=? WHERE command_id=?')
      .run(outcome, resultEventId, this.#clock.now(), id);
  }

  writeSnapshot(s: StoredSnapshot): void {
    this.#alive();
    const run = this.#own(s.runId, 'writeSnapshot');
    if (s.atSequence > run.lastSequence) {
      throw usage(`writeSnapshot: at ${s.atSequence} but the journal of ${s.runId} ends at ${run.lastSequence}`);
    }
    upsertRow(this.#driver, 'snapshots', ['run_id', 'at_sequence'], s as unknown as Row);
    this.#driver
      .prepare(
        `DELETE FROM snapshots WHERE run_id=? AND at_sequence NOT IN
         (SELECT at_sequence FROM snapshots WHERE run_id=? ORDER BY at_sequence DESC LIMIT 3)`,
      )
      .run(s.runId, s.runId);
  }

  run(): RunRecord {
    this.#alive();
    return this.#scoped('run');
  }

  agent(id: AgentId): AgentRecord | undefined {
    this.#alive();
    const run = this.#scoped('agent');
    return getRow<AgentRecord>(this.#driver, 'agents', ['run_id', 'agent_id'], [run.runId, id]);
  }

  incarnation(id: AgentId, n: number): IncarnationRecord | undefined {
    this.#alive();
    const run = this.#scoped('incarnation');
    return getRow(this.#driver, 'agent_incarnations', ['run_id', 'agent_id', 'incarnation'], [run.runId, id, n]) as
      | IncarnationRecord
      | undefined;
  }

  worktree(slot: string): WorktreeRecord | undefined {
    this.#alive();
    const run = this.#scoped('worktree');
    return getRow<WorktreeRecord>(this.#driver, 'worktrees', ['run_id', 'slot'], [run.runId, slot]);
  }

  approval(id: ApprovalId): ApprovalRecord | undefined {
    this.#alive();
    const run = this.#scoped('approval');
    const row = getRow<ApprovalRecord>(this.#driver, 'approvals', ['approval_id'], [id]);
    return row && row.runId === run.runId ? row : undefined;
  }

  effectByKey(key: string): EffectRecord | undefined {
    this.#alive();
    const run = this.#scoped('effectByKey');
    const row = this.#driver
      .prepare('SELECT * FROM effects WHERE run_id=? AND idempotency_key=?')
      .get(run.runId, key) as Row | undefined;
    return row && fromRow<EffectRecord>('effects', row);
  }

  budget(level: string, scopeId: string): BudgetRecord | undefined {
    this.#alive();
    const run = this.#scoped('budget');
    return getRow(this.#driver, 'budgets', ['run_id', 'level', 'scope_id'], [run.runId, level, scopeId]) as
      | BudgetRecord
      | undefined;
  }
}
