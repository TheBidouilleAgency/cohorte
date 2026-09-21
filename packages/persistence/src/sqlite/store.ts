// `SqliteStateStore` (DESIGN 2.4, ADR-0002): `StateStore` over `node:sqlite`. Reads never open a transaction (I13
// "lock-free, safe to SIGKILL the reader at any instant" — SQLite's own MVCC/WAL readers never block a writer, or
// each other). Writes always `BEGIN IMMEDIATE` first (I6): `transact()` for the run/project path, and a private
// `BEGIN IMMEDIATE` of its own for `acquireLock`/`stealLock`/`enqueueCommand`, which are not routed through it.
import { existsSync } from 'node:fs';
import {
  type ArtifactId,
  type Clock,
  CohorteError,
  type CommandId,
  createUuidV7IdSource,
  errorOf,
  type IdSource,
  type RunId,
  systemClock,
  toIsoInstant,
} from '@cohorte/base';
import type { CommandEnvelope, PipelineState } from '@cohorte/protocol';
import {
  type ApprovalRecord,
  type ArtifactRecord,
  type CommandRecord,
  type DurableEnvelope,
  type DurableEventType,
  type EffectRecord,
  type EffectState,
  type EventRecord,
  type FindingRecord,
  type LeaseToken,
  type LedgerEntry,
  type LockRecord,
  type LockRequest,
  type LockScope,
  locksConflict,
  type MigrationReport,
  NO_RUN_ID,
  type RunRecord,
  type RunTreeRows,
  type SqlDriver,
  type StateStore,
  type StoredSnapshot,
  type StoreInfo,
  type StoreTx,
  StoreUsageError,
  type VerifyChainResult,
} from '../contract.ts';
import { envelopeOf, verifyEventRecords } from '../memory/chain.ts';
import { createMigrator } from '../migrate/index.ts';
import { type EnqueueStatus, enqueueCommandRow } from './commands.ts';
import { createNodeSqliteDriver, DEFAULT_MIGRATIONS_DIR } from './driver.ts';
import { fromRow, getRow, insertRow, type Row } from './marshal.ts';
import { SqliteTx } from './tx.ts';

export interface SqliteStoreOptions {
  /** `<main checkout>/.cohorte/state/cohorte.db`, or `:memory:` */
  path: string;
  /** where the numbered `*.sql` files live; defaults to the embedded `migrations/state` */
  migrationsDir?: string;
  /** `node:sqlite` by default; `better-sqlite3` is the documented fallback behind the same seam (ADR-0002) */
  driver?: (path: string) => SqlDriver;
  clock?: Clock;
  ids?: IdSource;
  /** stamped on every applied migration row; defaults to this package's understanding of the current 3.0 line */
  cohorteVersion?: string;
}

const DEFAULT_COHORTE_VERSION = '3.0.0';

const usage = (message: string): StoreUsageError => new StoreUsageError(message);
const isThenable = (value: unknown): boolean =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

function safeRollback(driver: SqlDriver): void {
  try {
    driver.exec('ROLLBACK');
  } catch {
    // a fatal SQLite error (e.g. a trigger's RAISE(ABORT, ...)) already rolled the transaction back
  }
}

const incompatibleSchema = (message: string): CohorteError =>
  new CohorteError(errorOf('corruption/incompatible-schema', message));

export class SqliteStateStore implements StateStore {
  readonly kind = 'sqlite';
  readonly #path: string;
  readonly #migrationsDir: string;
  readonly #driverFactory: (path: string) => SqlDriver;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #cohorteVersion: string;
  #driver: SqlDriver | undefined;
  #opened = false;

  constructor(options: SqliteStoreOptions) {
    this.#path = options.path;
    this.#migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    this.#driverFactory = options.driver ?? createNodeSqliteDriver;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? createUuidV7IdSource();
    this.#cohorteVersion = options.cohorteVersion ?? DEFAULT_COHORTE_VERSION;
  }

  /**
   * The connection, opened on first use. Lazy on purpose (DESIGN 2.4 `openSqliteStore`: "nothing touches the file
   * before `open()` or `migrate()`") — and PRIVATE to the three entry points that are allowed to materialise the file:
   * `open()`, `migrate()` and `backup()`. Everything else goes through `#db()`.
   */
  #connection(): SqlDriver {
    if (!this.#driver) this.#driver = this.#driverFactory(this.#path);
    return this.#driver;
  }

  /**
   * The connection of an OPEN store. DESIGN 2.4 has `open()` "refuse rather than guessing; never auto-migrate": a read
   * on a store nobody opened must say so, not create an empty `cohorte.db` (+ `-wal`, `-shm`) as a side effect and then
   * fail with a raw `ERR_SQLITE_ERROR` about a missing table.
   */
  #db(): SqlDriver {
    if (!this.#opened) throw usage(`the store at ${this.#path} is not open: call open() (or migrate()) first`);
    return this.#connection();
  }

  #migrator() {
    return createMigrator({
      driver: this.#connection(),
      migrationsDir: this.#migrationsDir,
      cohorteVersion: this.#cohorteVersion,
    });
  }

  async open(): Promise<StoreInfo> {
    const report = this.#migrator().check();
    if (report.current !== report.target) {
      throw incompatibleSchema(
        `the state database at ${this.#path} is at schema ${report.current}, this build's migrations/state expects ${report.target}`,
      );
    }
    this.#opened = true;
    return { kind: this.kind, schemaVersion: report.current, location: this.#path };
  }

  async close(): Promise<void> {
    this.#opened = false;
    if (this.#driver) {
      this.#driver.close();
      this.#driver = undefined;
    }
  }

  async migrate(mode: 'check' | 'apply'): Promise<MigrationReport> {
    const migrator = this.#migrator();
    if (mode === 'check') return migrator.check();
    const report = migrator.check();
    if (report.current > report.target) {
      throw incompatibleSchema(
        `the state database at ${this.#path} is at schema ${report.current}, newer than this build's migrations/state (target ${report.target})`,
      );
    }
    if (report.pending.length === 0) return { ...report, mode: 'apply', applied: [] };
    // Bootstrap (0001 creates `locks` itself): nothing to lock or back up yet.
    if (report.current === 0) return migrator.apply();
    const owner = { hostId: 'migrate', pid: process.pid, startToken: this.#ids.next<'MigrationToken'>('tok') };
    // Not `this.acquireLock`: the public lock methods require an OPEN store, and `migrate()` is precisely what runs
    // before `open()` can succeed.
    const acquired = this.#acquireLockOn(this.#connection(), {
      scope: 'project',
      key: 'project',
      mode: 'exclusive',
      owner,
      ttlMs: 300_000,
    });
    if (!acquired.ok) {
      throw new CohorteError(
        errorOf(
          'conflict/unexpected',
          'migrate --apply: the project lock is held; cannot migrate while the project is in use',
        ),
      );
    }
    try {
      const backupPath = `${this.#path}.bak-${Date.now()}`;
      await this.backup(backupPath);
      const applied = migrator.apply();
      return { ...applied, backupPath };
    } finally {
      this.#connection().prepare('DELETE FROM locks WHERE lock_id=?').run(acquired.lease.lockId);
    }
  }

  /**
   * `VACUUM INTO`, on the store's own connection — NOT a checkpoint plus a file copy.
   *
   * ADR-0002 makes lock-free readers the normal state of this file ("observers are lock-free readers and are
   * SIGKILL-safe"), and any reader parked in a read transaction blocks `PRAGMA wal_checkpoint(TRUNCATE)`: the pragma
   * then reports `busy` and leaves the committed pages in the `-wal`, so copying the main file alone yields a
   * TRUNCATED, unopenable database ("database disk image is malformed"). `VACUUM INTO` writes a complete, consistent
   * database from the connection's own read view instead, whoever else is on the file. This is the only safety net
   * `migrate('apply')` takes before mutating the schema, so it may not be silently empty.
   */
  async backup(toPath: string): Promise<void> {
    if (this.#path === ':memory:') throw usage('backup: an in-memory store has nothing to back up');
    // SQLite refuses an existing target itself; saying so here keeps the failure typed and the message actionable.
    if (existsSync(toPath)) throw usage(`backup: ${toPath} already exists; a backup never overwrites`);
    this.#connection().prepare('VACUUM INTO ?').run(toPath);
  }

  async transact<T>(
    scope: { runId: RunId } | 'project',
    lease: LeaseToken | null,
    body: (tx: StoreTx) => T,
    opts?: { expectedSequence?: number },
  ): Promise<T> {
    if (!this.#opened) throw usage('the store is not open');
    const db = this.#db();
    const target = scope === 'project' ? scope : scope.runId;
    if (target !== 'project') {
      if (!lease) throw usage(`a transaction on run ${target} needs the run lease`);
      if (lease.runId !== target) throw usage(`the lease of run ${lease.runId || '(none)'} cannot write run ${target}`);
    }
    db.exec('BEGIN IMMEDIATE');
    let tx: SqliteTx | undefined;
    try {
      // I6: the FIRST statement of every write transaction asserts the lease's fencing token — and that the lease
      // really is THE lock of this write's scope (a zone or migration lock of the same run/host is not a licence
      // to write the run: two writers for one run is exactly what I6 forbids).
      if (lease) {
        const lock = getRow<LockRecord>(db, 'locks', ['lock_id'], [lease.lockId]);
        const rightKind =
          target === 'project' ? lock?.scope === 'project' : lock?.scope === 'run' && lock.key === target;
        if (!lock || !rightKind || lock.fencingToken !== lease.fencingToken || lock.ownerHostId !== lease.hostId) {
          throw new CohorteError(
            errorOf(
              'conflict/lease-lost',
              `lock ${lease.lockId} is no longer held with fencing token ${lease.fencingToken}`,
            ),
          );
        }
      }
      if (opts?.expectedSequence !== undefined) {
        if (target === 'project') throw usage('expectedSequence needs a run-scoped transaction');
        const run = getRow<RunRecord>(db, 'runs', ['run_id'], [target]);
        if (run?.lastSequence !== opts.expectedSequence) {
          throw new CohorteError(
            errorOf(
              'conflict/unexpected',
              `run ${target} is at sequence ${run?.lastSequence}, expected ${opts.expectedSequence}`,
            ),
          );
        }
      }
      tx = new SqliteTx(db, target, lease, this.#clock, this.#ids);
      const result = body(tx);
      if (isThenable(result)) throw usage('a transaction body must be synchronous: it returned a thenable');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      safeRollback(db);
      throw error;
    } finally {
      // The tx dies on commit, on rollback and on the thenable rejection alike. Rejecting the CALLER of an async body
      // is not enough: its continuation still holds this `StoreTx`, whose methods write straight to the connection —
      // after the ROLLBACK that would be in autocommit, unfenced, and permanently committed (I6).
      tx?.close();
    }
  }

  async getRun(id: RunId): Promise<RunRecord | undefined> {
    return getRow<RunRecord>(this.#db(), 'runs', ['run_id'], [id]);
  }

  async listRuns(q: { states?: PipelineState[]; limit: number; offset: number }): Promise<RunRecord[]> {
    const db = this.#db();
    const params: unknown[] = [];
    let sql = 'SELECT * FROM runs';
    if (q.states && q.states.length > 0) {
      sql += ` WHERE state IN (${q.states.map(() => '?').join(',')})`;
      params.push(...q.states);
    }
    sql += ' ORDER BY started_at DESC, run_id ASC LIMIT ? OFFSET ?';
    params.push(q.limit, q.offset);
    return (db.prepare(sql).all(...params) as Row[]).map((row) => fromRow<RunRecord>('runs', row));
  }

  async readEvents(
    id: RunId,
    q: { afterSequence: number; limit: number; types?: DurableEventType[] },
  ): Promise<DurableEnvelope[]> {
    const db = this.#db();
    const params: unknown[] = [id, q.afterSequence];
    let sql = 'SELECT * FROM events WHERE run_id=? AND sequence>?';
    if (q.types && q.types.length > 0) {
      sql += ` AND type IN (${q.types.map(() => '?').join(',')})`;
      params.push(...q.types);
    }
    sql += ' ORDER BY sequence LIMIT ?';
    params.push(q.limit);
    return (db.prepare(sql).all(...params) as Row[]).map((row) => envelopeOf(fromRow<EventRecord>('events', row)));
  }

  async loadSnapshot(id: RunId): Promise<StoredSnapshot | undefined> {
    const row = this.#db()
      .prepare('SELECT * FROM snapshots WHERE run_id=? ORDER BY at_sequence DESC LIMIT 1')
      .get(id) as Row | undefined;
    return row && fromRow<StoredSnapshot>('snapshots', row);
  }

  async readRunTree(id: RunId): Promise<RunTreeRows> {
    const run = await this.getRun(id);
    if (!run) throw usage(`readRunTree: run ${id} does not exist`);
    const db = this.#db();
    const of = <T>(table: 'phases' | 'agents' | 'agent_incarnations' | 'worktrees' | 'approvals' | 'budgets'): T[] =>
      (db.prepare(`SELECT * FROM ${table} WHERE run_id=?`).all(id) as Row[]).map((row) => fromRow<T>(table, row));
    return {
      run,
      phases: of<RunTreeRows['phases'][number]>('phases'),
      agents: of<RunTreeRows['agents'][number]>('agents'),
      incarnations: of<RunTreeRows['incarnations'][number]>('agent_incarnations'),
      worktrees: of<RunTreeRows['worktrees'][number]>('worktrees'),
      approvals: of<RunTreeRows['approvals'][number]>('approvals'),
      budgets: of<RunTreeRows['budgets'][number]>('budgets'),
      locks: (db.prepare('SELECT * FROM locks WHERE owner_run_id=?').all(id) as Row[]).map((row) =>
        fromRow<LockRecord>('locks', row),
      ),
    };
  }

  async listPendingApprovals(id?: RunId): Promise<ApprovalRecord[]> {
    const db = this.#db();
    const rows = (
      id === undefined
        ? (db.prepare(`SELECT * FROM approvals WHERE status='pending' ORDER BY created_at, approval_id`).all() as Row[])
        : (db
            .prepare(`SELECT * FROM approvals WHERE status='pending' AND run_id=? ORDER BY created_at, approval_id`)
            .all(id) as Row[])
    ).map((row) => fromRow<ApprovalRecord>('approvals', row));
    return rows;
  }

  async listEffects(id: RunId, q: { states: EffectState[] }): Promise<EffectRecord[]> {
    const placeholders = q.states.map(() => '?').join(',');
    return (
      this.#db()
        .prepare(`SELECT * FROM effects WHERE run_id=? AND state IN (${placeholders})`)
        .all(id, ...q.states) as Row[]
    ).map((row) => fromRow<EffectRecord>('effects', row));
  }

  async readLedger(id: RunId, slot: string): Promise<LedgerEntry[]> {
    return (
      this.#db().prepare('SELECT * FROM worktree_ledger WHERE run_id=? AND slot=? ORDER BY path').all(id, slot) as Row[]
    ).map((row) => fromRow<LedgerEntry>('worktree_ledger', row));
  }

  async getArtifact(id: RunId, artifact: ArtifactId): Promise<ArtifactRecord | undefined> {
    return getRow<ArtifactRecord>(this.#db(), 'artifacts', ['run_id', 'artifact_id'], [id, artifact]);
  }

  async listFindings(id: RunId, q: { phaseRunId?: string; status?: string } = {}): Promise<FindingRecord[]> {
    const params: unknown[] = [id];
    let sql = 'SELECT * FROM findings WHERE run_id=?';
    if (q.phaseRunId !== undefined) {
      sql += ' AND phase_run_id=?';
      params.push(q.phaseRunId);
    }
    if (q.status !== undefined) {
      sql += ' AND status=?';
      params.push(q.status);
    }
    sql += ' ORDER BY created_at, finding_id';
    return (
      this.#db()
        .prepare(sql)
        .all(...params) as Row[]
    ).map((row) => fromRow<FindingRecord>('findings', row));
  }

  async verifyChain(id: RunId, key?: Uint8Array): Promise<VerifyChainResult> {
    const db = this.#db();
    const run = getRow<RunRecord>(db, 'runs', ['run_id'], [id]);
    const tail = run && !run.purgeable ? { lastSequence: run.lastSequence, lastHash: run.lastHash } : undefined;
    const rows = (db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY sequence').all(id) as Row[]).map((row) =>
      fromRow<EventRecord>('events', row),
    );
    return verifyEventRecords(id, rows, key, tail);
  }

  /**
   * Retention-only administrative operation. The migration trigger permits
   * deleting events exclusively after the run has been marked purgeable; keep
   * this outside StateStore so ordinary callers cannot acquire a destructive
   * capability accidentally.
   */
  async purgeEvents(id: RunId): Promise<number> {
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('DELETE FROM events WHERE run_id=?').run(id);
      db.exec('COMMIT');
      return Number(result.changes);
    } catch (error) {
      safeRollback(db);
      throw error;
    }
  }

  async enqueueCommand(cmd: CommandEnvelope): Promise<{ status: EnqueueStatus; record: CommandRecord }> {
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = enqueueCommandRow(db, cmd, this.#clock);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      safeRollback(db);
      throw error;
    }
  }

  async pendingCommands(id: RunId): Promise<CommandRecord[]> {
    return (
      this.#db()
        .prepare(`SELECT * FROM commands WHERE run_id=? AND status='pending' ORDER BY created_at, command_id`)
        .all(id) as Row[]
    ).map((row) => fromRow<CommandRecord>('commands', row));
  }

  async getCommand(id: CommandId): Promise<CommandRecord | undefined> {
    return getRow<CommandRecord>(this.#db(), 'commands', ['command_id'], [id]);
  }

  /** Monotonic per (scope,key), across release/reacquire cycles: `locks` rows disappear on release, so the counter lives in `meta` (2.4's generic key/value table — DESIGN names no other place for it). */
  #nextFencingToken(db: SqlDriver, scope: LockScope, key: string): number {
    const metaKey = `fencing:${scope}:${key}`;
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(metaKey) as { value: string } | undefined;
    const next = (row ? Number.parseInt(row.value, 10) : 0) + 1;
    this.#setFencingToken(db, metaKey, next);
    return next;
  }

  #setFencingToken(db: SqlDriver, metaKey: string, value: number): void {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      metaKey,
      String(value),
    );
  }

  #insertLock(db: SqlDriver, req: LockRequest, fencingToken: number): LeaseToken {
    const lockId = this.#ids.next<'LockId'>('lck');
    const now = Date.parse(this.#clock.now());
    const record: LockRecord = {
      lockId,
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
    insertRow(db, 'locks', record as unknown as Row);
    return { lockId, runId: req.owner.runId ?? NO_RUN_ID, hostId: req.owner.hostId, fencingToken };
  }

  async acquireLock(req: LockRequest): Promise<{ ok: true; lease: LeaseToken } | { ok: false; heldBy: LockRecord[] }> {
    return this.#acquireLockOn(this.#db(), req);
  }

  #acquireLockOn(
    db: SqlDriver,
    req: LockRequest,
  ): { ok: true; lease: LeaseToken } | { ok: false; heldBy: LockRecord[] } {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = (db.prepare('SELECT * FROM locks WHERE scope=? AND key=?').all(req.scope, req.key) as Row[]).map(
        (row) => fromRow<LockRecord>('locks', row),
      );
      const conflicting = existing.filter((lock) => locksConflict(lock, req));
      if (conflicting.length > 0) {
        db.exec('ROLLBACK');
        return { ok: false, heldBy: conflicting };
      }
      const fencingToken = this.#nextFencingToken(db, req.scope, req.key);
      const lease = this.#insertLock(db, req, fencingToken);
      db.exec('COMMIT');
      return { ok: true, lease };
    } catch (error) {
      safeRollback(db);
      throw error;
    }
  }

  async stealLock(req: LockRequest, expected: LockRecord): Promise<LeaseToken> {
    const db = this.#db();
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getRow<LockRecord>(db, 'locks', ['lock_id'], [expected.lockId]);
      if (!current || current.fencingToken !== expected.fencingToken) {
        throw new CohorteError(
          errorOf('conflict/lease-lost', `lock ${expected.lockId} changed since it was read: nothing to steal`),
        );
      }
      const others = (
        db
          .prepare('SELECT * FROM locks WHERE scope=? AND key=? AND lock_id<>?')
          .all(req.scope, req.key, current.lockId) as Row[]
      ).map((row) => fromRow<LockRecord>('locks', row));
      const conflicting = others.filter((lock) => locksConflict(lock, req));
      if (conflicting.length > 0) {
        throw new CohorteError(
          errorOf(
            'conflict/unexpected',
            `stealing ${current.lockId} would still conflict with ${conflicting.length} lock(s)`,
          ),
        );
      }
      db.prepare('DELETE FROM locks WHERE lock_id=?').run(current.lockId);
      const fencingToken = current.fencingToken + 1;
      this.#setFencingToken(db, `fencing:${req.scope}:${req.key}`, fencingToken);
      const lease = this.#insertLock(db, req, fencingToken);
      db.exec('COMMIT');
      return lease;
    } catch (error) {
      safeRollback(db);
      throw error;
    }
  }

  async renewLock(lockId: string, ttlMs: number): Promise<boolean> {
    const now = Date.parse(this.#clock.now());
    const result = this.#db()
      .prepare('UPDATE locks SET lease_expires_at=? WHERE lock_id=?')
      .run(toIsoInstant(now + ttlMs), lockId);
    return Number(result.changes) > 0;
  }

  async releaseLock(lockId: string): Promise<void> {
    this.#db().prepare('DELETE FROM locks WHERE lock_id=?').run(lockId);
  }

  async listLocks(q?: { scope?: LockScope }): Promise<LockRecord[]> {
    const db = this.#db();
    const rows = (
      q?.scope
        ? (db.prepare('SELECT * FROM locks WHERE scope=? ORDER BY acquired_at').all(q.scope) as Row[])
        : (db.prepare('SELECT * FROM locks ORDER BY acquired_at').all() as Row[])
    ).map((row) => fromRow<LockRecord>('locks', row));
    return rows;
  }
}

export function openSqliteStore(options: SqliteStoreOptions): StateStore {
  return new SqliteStateStore(options);
}
