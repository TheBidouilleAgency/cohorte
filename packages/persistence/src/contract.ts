// `@cohorte/persistence/contract` — the StateStore contract (DESIGN 2.4, ADR-0002): asynchronous boundary,
// SYNCHRONOUS transaction body. FROZEN at G0. Stores are dumb: `core` writes projections explicitly, in the same
// transaction as the events that justify them; no store contains a reducer.
import type {
  AgentId,
  ApprovalId,
  ArtifactId,
  CommandId,
  EffectId,
  ErrorInfo,
  EventId,
  RunId,
  Sealed,
  SealedJson,
  Sha256,
  ToolCallId,
} from '@cohorte/base';
import type { CommandEnvelope, DurableEventType, Envelope, PipelineState } from '@cohorte/protocol';
import type {
  AgentRecord,
  ApprovalDecisionRecord,
  ApprovalRecord,
  ArtifactRecord,
  BudgetRecord,
  CommandRecord,
  EffectKind,
  EffectPreState,
  EffectRecord,
  EffectState,
  FindingRecord,
  IncarnationRecord,
  LedgerEntry,
  LockMode,
  LockRecord,
  LockScope,
  MigrationReport,
  PhaseRecord,
  ReplayClass,
  RunRecord,
  RunTreeRows,
  StoredSnapshot,
  StoreInfo,
  TransitionRecord,
  WorktreeRecord,
} from './records.ts';

export type { DurableEventType } from '@cohorte/protocol';
// An explicit list, not `export type *`: Biome 2.5.14's type inference overflows its stack on the star form.
export type {
  AgentRecord,
  ApprovalDecisionRecord,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactRecord,
  BudgetRecord,
  CommandRecord,
  CommandStatus,
  EffectKind,
  EffectPreState,
  EffectRecord,
  EffectState,
  EventRecord,
  FindingRecord,
  IncarnationRecord,
  LedgerEntry,
  LockMode,
  LockRecord,
  LockScope,
  MetaRecord,
  MigrationRecord,
  MigrationReport,
  MigrationStep,
  PhaseRecord,
  ReplayClass,
  RunRecord,
  RunTreeRows,
  StoredSnapshot,
  StoreInfo,
  TableName,
  TransitionRecord,
  WorktreeRecord,
  WorktreeState,
} from './records.ts';
export { HOST_COMPUTED_RUN_KEYS, STATES_WITHOUT_HOST_COLUMNS, TABLE_COLUMNS, TABLE_NAMES } from './records.ts';

export type DurableEnvelope = Envelope<DurableEventType>;
/** What core hands to the store: everything except what the store assigns — and ONLY after Redactor sealed it (I7). */
export type EventDraft = Omit<DurableEnvelope, 'sequence' | 'sub' | 'durability'>;
export type SealedEventDraft = Sealed<EventDraft>;

export interface LeaseToken {
  readonly lockId: string;
  /** `NO_RUN_ID` for a lock whose owner names no run (project, migration) */
  readonly runId: RunId;
  readonly hostId: string;
  readonly fencingToken: number;
}
/** The `runId` of a lease taken without one. Never the id of a run: a run-scoped transaction refuses such a lease. */
export const NO_RUN_ID = '' as RunId;

/**
 * A caller broke the contract (a thenable body, a run-scoped write in a project transaction, a write to another run,
 * an unknown run or effect, a run leaving IDLE without its host-computed columns). Reaching one is a bug, not a run
 * outcome: the transaction is rolled back and nothing is written.
 */
export class StoreUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUsageError';
  }
}

export type VerifyChainResult =
  | { ok: true; events: number; anchors: number }
  | { ok: false; firstBadSequence: number; reason: 'hash-mismatch' | 'gap' | 'duplicate' | 'anchor-mac' };

export interface StateStore {
  /** 'sqlite' | 'memory' */
  readonly kind: string;
  /** refuses (corruption/incompatible-schema) rather than guessing; never auto-migrates */
  open(): Promise<StoreInfo>;
  close(): Promise<void>;
  /** numbered, monotonic, sha256-pinned; 'apply' takes the exclusive project lock + backup() */
  migrate(mode: 'check' | 'apply'): Promise<MigrationReport>;
  backup(toPath: string): Promise<void>;

  // ── the single write path ─────────────────────────────────────────────
  /**
   * lease != null: the FIRST statement asserts the lease against the lock row, else throws conflict/lease-lost (I6).
   * For a RUN-scoped transaction the lease must be the run's OWN lock — the row with `scope:'run'`, `key: runId`,
   * `fencing_token = lease.fencingToken` and `owner_host_id = lease.hostId` (in SQL:
   * `SELECT 1 FROM locks WHERE lock_id = ? AND scope = 'run' AND key = ? AND fencing_token = ? AND owner_host_id = ?`).
   * A lease on any OTHER lock that happens to name the run (a zone lock, which the supervisor takes with
   * `owner.runId` set) is refused: otherwise a host that lost the run lease to a steal could keep writing the run
   * through it, and I6 is "ONE writer per run". body MUST be synchronous (a returned thenable is rejected).
   * lease == null is legal only for scope 'project' (init, migrate, lock acquisition, and RUN CREATION: inside
   * `transact('project', null, …)` the body may call `putRun` for a runId that does not exist yet and
   * `enqueueCommand` — and nothing else run-scoped) and for the stand-alone `enqueueCommand` below.
   */
  transact<T>(
    scope: { runId: RunId } | 'project',
    lease: LeaseToken | null,
    body: (tx: StoreTx) => T,
    opts?: { expectedSequence?: number },
  ): Promise<T>;

  // ── reads: lock-free, safe to SIGKILL the reader at any instant ───────
  getRun(runId: RunId): Promise<RunRecord | undefined>;
  listRuns(q: { states?: PipelineState[]; limit: number; offset: number }): Promise<RunRecord[]>;
  /** always paginated by sequence */
  readEvents(
    runId: RunId,
    q: { afterSequence: number; limit: number; types?: DurableEventType[] },
  ): Promise<DurableEnvelope[]>;
  loadSnapshot(runId: RunId): Promise<StoredSnapshot | undefined>;
  /** runs + phases + agents + incarnations + worktrees + approvals + budgets + locks */
  readRunTree(runId: RunId): Promise<RunTreeRows>;
  listPendingApprovals(runId?: RunId): Promise<ApprovalRecord[]>;
  listEffects(runId: RunId, q: { states: EffectState[] }): Promise<EffectRecord[]>;
  readLedger(runId: RunId, slot: string): Promise<LedgerEntry[]>;
  getArtifact(runId: RunId, id: ArtifactId): Promise<ArtifactRecord | undefined>;
  /** Findings are durable phase handoffs; callers must be able to rebuild review state after a host restart. */
  listFindings(runId: RunId, q?: { phaseRunId?: string; status?: string }): Promise<FindingRecord[]>;
  verifyChain(runId: RunId, key?: Uint8Array): Promise<VerifyChainResult>;

  // ── command inbox (D5): the only write a non-owner process performs ───
  enqueueCommand(
    cmd: CommandEnvelope,
  ): Promise<{ status: 'enqueued' | 'duplicate' | 'id-reuse-conflict'; record: CommandRecord }>;
  /** status 'pending', ordered by created_at, command_id */
  pendingCommands(runId: RunId): Promise<CommandRecord[]>;
  getCommand(id: CommandId): Promise<CommandRecord | undefined>;

  // ── locks / leases (spec 15, 11.3) ────────────────────────────────────
  /**
   * Refused as long as a CONFLICTING row exists, however stale: `leaseExpiresAt` is ADVISORY (see `LockRequest.ttlMs`)
   * and no store evicts an expired row here. Taking over a dead host's lock is `stealLock`, never an implicit expiry.
   */
  acquireLock(req: LockRequest): Promise<{ ok: true; lease: LeaseToken } | { ok: false; heldBy: LockRecord[] }>;
  /** fencingToken = old + 1; emits lock.stolen through the caller */
  stealLock(req: LockRequest, expected: LockRecord): Promise<LeaseToken>;
  /** false = lease lost: the host MUST stop producing effects. An expired-but-unstolen lock still renews (true). */
  renewLock(lockId: string, ttlMs: number): Promise<boolean>;
  releaseLock(lockId: string): Promise<void>;
  listLocks(q?: { scope?: LockScope }): Promise<LockRecord[]>;
}

/** Synchronous. Every method fully applies inside the enclosing transaction or throws (rollback). */
export interface StoreTx {
  /** assigns sequence = last+1…, prev_hash/hash; bumps runs.last_sequence, runs.version */
  appendEvents(drafts: readonly SealedEventDraft[]): DurableEnvelope[];
  /** UNIQUE(run_id, idempotency_key) */
  recordTransition(t: TransitionRecord): 'recorded' | 'duplicate';
  putRun(r: RunRecord): void;
  patchRun(runId: RunId, p: Partial<RunRecord>): void;
  putPhase(p: PhaseRecord): void;
  putAgent(a: AgentRecord): void;
  putIncarnation(i: IncarnationRecord): void;
  putWorktree(w: WorktreeRecord): void;
  putLedger(e: LedgerEntry): void;
  clearLedger(runId: RunId, slot: string, upToEffectSeq: number): void;
  /** UNIQUE(run_id, idempotency_key) */
  putApproval(a: ApprovalRecord): 'created' | 'exists';
  resolveApproval(id: ApprovalId, d: ApprovalDecisionRecord): 'resolved' | 'already-resolved';
  /** live allow-for-run, or unconsumed allow-once */
  findGrant(runId: RunId, grantKey: string): ApprovalRecord | undefined;
  setBudget(b: BudgetRecord): void;
  putArtifact(a: ArtifactRecord): void;
  putFinding(f: FindingRecord): void;
  // effect journal (4.1)
  /**
   * Which stored state maps to which answer, for the row already filed under `(runId, idempotencyKey)`:
   * `done` -> `already-done` (the caller replays the stored result, nothing re-executes); `intent` / `in-doubt` ->
   * `open` (recovery decides by replay class, 4.1); `failed` / `compensated` -> `started`, a NEW attempt on the SAME
   * row: it keeps its effectId and createdAt and is rebuilt from the intent alone, so the previous attempt's
   * `result`, `error` and `compensatedBy` are cleared. No stored row at all -> `started` with a fresh effectId.
   */
  beginEffect(
    e: EffectIntent,
  ):
    | { status: 'started'; effectId: EffectId }
    | { status: 'already-done'; record: EffectRecord }
    | { status: 'open'; record: EffectRecord /* intent | in-doubt */ };
  completeEffect(id: EffectId, result: SealedJson, post?: { treeDigest?: string; head?: string }): void;
  failEffect(id: EffectId, error: ErrorInfo): void;
  markEffectInDoubt(id: EffectId, note: string): void;
  compensateEffects(ids: EffectId[], byEffect: EffectId): void;
  // inbox
  /**
   * same row and same rules as StateStore.enqueueCommand, but INSIDE a transaction: this is what makes
   * `start` = { run row IDLE + signed start command } ONE atomic write (4.3 #1).
   *
   * ORDER IS LOAD-BEARING in the run-creation transaction: call this FIRST and `putRun` only on `'enqueued'`. On
   * `'duplicate'` / `'id-reuse-conflict'` the run must NOT be written — a retried `start` that writes the run first
   * commits an orphan IDLE run beside the answer "duplicate", which is the very outcome the single atomic write
   * exists to prevent. Neither status throws, so nothing else rolls the transaction back for you.
   */
  enqueueCommand(cmd: CommandEnvelope): 'enqueued' | 'duplicate' | 'id-reuse-conflict';
  claimCommand(id: CommandId, hostId: string): boolean;
  finishCommand(id: CommandId, outcome: 'completed' | 'rejected', resultEventId: EventId): void;
  /** AFTER the events it covers (spec 11.3); keep last 3 */
  writeSnapshot(s: StoredSnapshot): void;
  // synchronous read-modify-write helpers
  run(): RunRecord;
  agent(id: AgentId): AgentRecord | undefined;
  incarnation(id: AgentId, n: number): IncarnationRecord | undefined;
  worktree(slot: string): WorktreeRecord | undefined;
  approval(id: ApprovalId): ApprovalRecord | undefined;
  effectByKey(key: string): EffectRecord | undefined;
  budget(level: string, scopeId: string): BudgetRecord | undefined;
}

export interface EffectIntent {
  runId: RunId;
  idempotencyKey: string;
  kind: EffectKind;
  replayClass: ReplayClass;
  agentId?: AgentId;
  toolCallId?: ToolCallId;
  slot?: string;
  request: SealedJson;
  /** data the kind-specific verifier needs after a crash */
  verify: SealedJson;
  preState?: EffectPreState;
  /** allow-once is consumed in THIS transaction: exactly once across a crash */
  consumesGrant?: ApprovalId;
}

export interface LockOwner {
  runId?: RunId;
  hostId: string;
  pid: number;
  startToken: string;
}
export interface LockRequest {
  scope: LockScope;
  key: string;
  mode: LockMode;
  owner: LockOwner;
  /**
   * How long the holder promises to keep renewing. The resulting `leaseExpiresAt` is ADVISORY and INFORMATIONAL: no
   * store evicts an expired row, `acquireLock` still refuses against it, `renewLock` still returns true, and a write
   * fenced on it still commits. What a run's expiry is FOR is telling a supervisor that the holder looks dead, and
   * the takeover it then performs is `stealLock` (fencing + 1), the one mechanism that invalidates the old lease.
   */
  ttlMs: number;
  zones?: string[];
}

export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number | bigint };
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
  close(): void;
}

export interface BlobStore {
  put(bytes: Uint8Array): Promise<{ sha256: Sha256; bytes: number }>;
  /** re-verifies the hash on EVERY read: security/pin-tampered */
  read(sha256: Sha256): Promise<Uint8Array>;
  has(sha256: Sha256): Promise<boolean>;
}
export interface RunFiles {
  dir(runId: RunId, ...sub: string[]): string;
  agentDir(runId: RunId, agentId: AgentId, incarnation: number): string;
  writeArtifact(runId: RunId, rel: string, bytes: Uint8Array): Promise<ArtifactRecord>;
}
export interface EphemeralSpool {
  append(runId: RunId, line: string): void;
  tail(runId: RunId, after: { sequence: number; sub: number }, signal: AbortSignal): AsyncIterable<string>;
}

// ── the two pure definitions both stores share, so that a chain written by one verifies in the other ────────────
/** Zones overlap by PATH SEGMENT: `src/app` overlaps `src` and `src/app/ui`, never `src/application`. */
export function zonesOverlap(a: string, b: string): boolean {
  const left = a.split('/').filter((segment) => segment !== '' && segment !== '.');
  const right = b.split('/').filter((segment) => segment !== '' && segment !== '.');
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** Two lock requests on the same (scope, key) conflict unless both are shared; two ZONE locks only where zones overlap. */
export function locksConflict(
  a: { scope: LockScope; key: string; mode: LockMode; zones?: readonly string[] | undefined },
  b: { scope: LockScope; key: string; mode: LockMode; zones?: readonly string[] | undefined },
): boolean {
  if (a.scope !== b.scope || a.key !== b.key) return false;
  if (a.mode === 'shared' && b.mode === 'shared') return false;
  if (a.scope !== 'zone') return true;
  const left = a.zones ?? [];
  const right = b.zones ?? [];
  // A zone lock that names no zone reserves the whole key.
  if (left.length === 0 || right.length === 0) return true;
  return left.some((zone) => right.some((other) => zonesOverlap(zone, other)));
}
