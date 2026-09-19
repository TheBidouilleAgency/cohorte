// Record types of the state store (DESIGN 2.4): ONE interface per table of migrations/state/0001_init.sql, and the
// column <-> key map that keeps the two column-for-column equal. A nullable column is an optional key; a `*_json`
// column is a structured key; a 0/1 INTEGER is a boolean. Nothing here behaves: the stores do.
import type {
  AgentId,
  ApprovalId,
  ArtifactId,
  AuthMode,
  BudgetCounters,
  CommandId,
  EffectId,
  ErrorInfo,
  EventId,
  FindingId,
  IsoInstant,
  JsonValue,
  ModelRef,
  PhaseRunId,
  RunId,
  SealedJson,
  Sha256,
  SpecId,
  SurfaceId,
  ToolCallId,
} from '@cohorte/base';
import type {
  ActivePipelineState,
  Actor,
  AgentState,
  CheckResult,
  CommandAuth,
  CommandEnvelope,
  GuardOutcome,
  NodeStatus,
  PipelineState,
  RunPlan,
  Severity,
  StopRecord,
  TransitionReason,
} from '@cohorte/protocol';

// ── vocabulary shared with contract.ts (declared here so that records never import the contract) ────────────────
export type ReplayClass = 'idempotent' | 'verifiable' | 'at-most-once';
export type EffectState = 'intent' | 'done' | 'failed' | 'in-doubt' | 'compensated';
export type EffectKind =
  | 'fs.snapshot.materialize'
  | 'git.branch.create'
  | 'git.ref.create'
  | 'git.worktree.add'
  | 'git.worktree.remove'
  | 'git.worktree.reset'
  | 'git.commit'
  | 'git.merge'
  | 'provision.command'
  | 'check.command'
  | 'agent.spawn'
  | 'tool.read'
  | 'tool.write_file'
  | 'tool.patch_file'
  | 'tool.run_command'
  | 'tool.network_request'
  | 'tool.git_commit';
export type LockScope = 'project' | 'zone' | 'run' | 'integration' | 'slot' | 'migration';
export type LockMode = 'shared' | 'exclusive';
export type ApprovalStatus = 'pending' | 'allow-once' | 'allow-for-run' | 'deny' | 'expired' | 'superseded';
export type CommandStatus = 'pending' | 'claimed' | 'completed' | 'rejected';
export type WorktreeState = 'intent' | 'ready' | 'held' | 'in-doubt' | 'quarantined' | 'removed';

/** The pre-state an effect is bound to (4.1, 4.5). */
export interface EffectPreState {
  checkpointSha?: string;
  ledgerSha256?: Sha256;
  beforeSha256?: Sha256;
  /** the grant binding of an asked COMMAND (4.5) */
  treeDigest?: string;
}

// ── one record per table ────────────────────────────────────────────────────────────────────────────────────────
export interface MigrationRecord {
  id: number;
  name: string;
  sha256: Sha256;
  appliedAt: IsoInstant;
  cohorteVersion: string;
}

export interface MetaRecord {
  key: string;
  value: string;
}

/** The six keys marked (*) are absent while the run is IDLE: only the host can compute them, in the T04 transaction. */
export interface RunRecord {
  runId: RunId;
  /** open: the known profiles are validated in TypeScript, not by the store (ADR-0018) */
  profile: string;
  tableVersion: number;
  specId: SpecId;
  specSha256: Sha256;
  title: string;
  state: PipelineState;
  resumeTo?: ActivePipelineState;
  stop?: StopRecord;
  lastError?: ErrorInfo;
  /** store-assigned by `appendEvents`, like `lastHash` and `version`: a `putRun` / `patchRun` never moves them */
  lastSequence: number;
  lastHash: string;
  version: number;
  /** (*) */
  snapshotDigest?: Sha256;
  /** (*) the RuntimePin of runtime-contract, opaque here */
  runtimePin?: JsonValue;
  /** (*) */
  plan?: RunPlan;
  pinnedInstallDir: string;
  baseBranch: string;
  /** (*) */
  baseSha?: string;
  /** (*) */
  integrationBranch?: string;
  integrationHead?: string;
  approvedTreeDigest?: string;
  skipWaivers?: JsonValue;
  /** (*) */
  zones?: string[];
  hostId?: string;
  hostPid?: number;
  hostStartToken?: string;
  hostHeartbeatAt?: IsoInstant;
  cancelRequested: boolean;
  pauseRequested: boolean;
  schemaVersion: number;
  cohorteVersion: string;
  purgeable: boolean;
  startedAt: IsoInstant;
  updatedAt: IsoInstant;
  endedAt?: IsoInstant;
}

/** One row of `events`: the projection columns plus the hashed unit. */
export interface EventRecord {
  runId: RunId;
  sequence: number;
  eventId: EventId;
  type: string;
  timestamp: IsoInstant;
  source: string;
  phaseRunId?: PhaseRunId;
  agentId?: AgentId;
  causationId?: string;
  severity: string;
  summary: string;
  /** the full SEALED envelope as canonical JSON */
  envelope: string;
  prevHash: string;
  /** sha256(prevHash || '\n' || envelope) */
  hash: string;
}

/** spec 11.1: all eight fields. */
export interface TransitionRecord {
  transitionId: string;
  runId: RunId;
  defId: string;
  tableVersion: number;
  from: PipelineState;
  to: PipelineState;
  reason: TransitionReason;
  actor: Actor;
  guards: GuardOutcome[];
  effects: string[];
  idempotencyKey: string;
  eventId: EventId;
}

export interface PhaseRecord {
  runId: RunId;
  phaseRunId: PhaseRunId;
  state: ActivePipelineState;
  iteration: number;
  status: NodeStatus;
  outcome?: string;
  checks: CheckResult[];
  startedAt?: IsoInstant;
  endedAt?: IsoInstant;
}

export interface AgentRecord {
  runId: RunId;
  agentId: AgentId;
  phaseRunId: PhaseRunId;
  role: string;
  surface?: SurfaceId;
  label: string;
  state: AgentState;
  /** retries of the WORK: incremented by `failed -> retrying | escalated` and by nothing else (2.5.4) */
  attempt: number;
  /** runtime sessions */
  incarnation: number;
  maxAttempts: number;
  maxIncarnations: number;
  model: ModelRef;
  effectiveModel?: { provider: string; model: string };
  authMode?: AuthMode;
  slot?: string;
  contextSha256?: Sha256;
  grantsDigest?: Sha256;
  usage: BudgetCounters;
  summary?: string;
  lastError?: ErrorInfo;
  pendingApproval?: ApprovalId;
  runtimeRef?: JsonValue;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

export interface IncarnationRecord {
  runId: RunId;
  agentId: AgentId;
  incarnation: number;
  attempt: number;
  /** open: owned by the agent supervisor */
  state: string;
  /** 'initial' | 'retry' | 'escalation' | a ReincarnateCause */
  cause?: string;
  pid?: number;
  startToken?: string;
  hostNonce?: string;
  runtimeRef?: JsonValue;
  stop?: string;
  reason?: string;
  usage?: BudgetCounters;
  startedAt?: IsoInstant;
  endedAt?: IsoInstant;
}

export interface WorktreeRecord {
  runId: RunId;
  slot: string;
  path: string;
  branch?: string;
  baseSha: string;
  checkpointSha: string;
  lastTreeDigest?: string;
  lockfileSha256?: Sha256;
  provisionKey?: string;
  /** 5.7: digest of the provisioned dependency tree */
  depsManifestSha256?: Sha256;
  holderAgentId?: AgentId;
  state: WorktreeState;
}

/** A dirty path since the last Cohorte commit, with the content hash Cohorte expects (4.4). */
export interface LedgerEntry {
  runId: RunId;
  slot: string;
  path: string;
  /** null = deleted */
  sha256: Sha256 | null;
  effectId: EffectId;
  effectSeq: number;
}

export interface EffectRecord {
  effectId: EffectId;
  runId: RunId;
  idempotencyKey: string;
  kind: EffectKind;
  replayClass: ReplayClass;
  state: EffectState;
  agentId?: AgentId;
  toolCallId?: ToolCallId;
  slot?: string;
  request: SealedJson;
  verify: SealedJson;
  preState?: EffectPreState;
  result?: SealedJson;
  /** `failed`: the failure; `in-doubt`: the note, as `human-required/in-doubt-effect` (`result` stays whatever the last attempt left). */
  error?: ErrorInfo;
  consumesGrant?: ApprovalId;
  compensatedBy?: EffectId;
  /** the fencing token of the transaction that wrote the intent */
  fencingToken: number;
  /** `runs.last_sequence` when the intent was written / when the effect reached a final state */
  intentSeq: number;
  doneSeq?: number;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

/** What `resolveApproval` is given: who answered what, when, and the authenticator of the resolving command (ADR-0022). */
export interface ApprovalDecisionRecord {
  actor: Actor;
  /** absent when the SYSTEM resolves (`expired`, `superseded`) */
  commandId?: CommandId;
  answer: Exclude<ApprovalStatus, 'pending'>;
  note?: string;
  decidedAt: IsoInstant;
  /** the sequence of `approval.resolved` */
  resolvedSeq: number;
  auth?: CommandAuth;
}

export interface ApprovalRecord {
  approvalId: ApprovalId;
  runId: RunId;
  idempotencyKey: string;
  /** open on the wire (ApprovalRequest.kind) */
  kind: string;
  agentId?: AgentId;
  incarnation?: number;
  toolCallId?: ToolCallId;
  status: ApprovalStatus;
  /** ApprovalRequest incl. the NORMALISED pending call */
  request: SealedJson;
  /** sha256(tool | normalised call | pre-state binding): what a decision is valid for (4.5) */
  grantKey: string;
  decision?: Omit<ApprovalDecisionRecord, 'auth' | 'resolvedSeq'>;
  commandAuth?: CommandAuth;
  /** allow-once: set in the intent transaction of the consuming effect */
  consumedByEffect?: EffectId;
  requestedSeq: number;
  resolvedSeq?: number;
  expiresAt?: IsoInstant;
  createdAt: IsoInstant;
  resolvedAt?: IsoInstant;
}

export interface BudgetRecord {
  runId: RunId;
  level: string;
  scopeId: string;
  consumed: BudgetCounters;
  limit: BudgetCounters;
  updatedAt: IsoInstant;
}

export interface ArtifactRecord {
  artifactId: ArtifactId;
  runId: RunId;
  /** open on the wire (ARTIFACT_KINDS) */
  kind: string;
  /** relative to the run directory, POSIX separators */
  path: string;
  sha256: Sha256;
  bytes: number;
  mediaType?: string;
  agentId?: AgentId;
  phaseRunId?: PhaseRunId;
  createdAt: IsoInstant;
}

export interface FindingRecord {
  runId: RunId;
  findingId: FindingId;
  phaseRunId: PhaseRunId;
  agentId?: AgentId;
  severity: Severity;
  /** open: owned by the loop controller ('open' | 'fixed' | 'waived' ...) */
  status: string;
  /** the sealed finding as the reviewer submitted it */
  finding: SealedJson;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

export interface CommandRecord {
  commandId: CommandId;
  runId?: RunId;
  type: string;
  /** sha256 of the canonical body (the envelope minus `auth`): same id + other body = `id-reuse-conflict` */
  bodySha256: Sha256;
  envelope: CommandEnvelope;
  authScheme?: string;
  authValue?: string;
  status: CommandStatus;
  claimedBy?: string;
  resultEventId?: EventId;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

/** Flat, like the table: the owner of DESIGN's `LockOwner` is the four `owner*` keys. */
export interface LockRecord {
  lockId: string;
  scope: LockScope;
  key: string;
  mode: LockMode;
  ownerRunId?: RunId;
  ownerHostId: string;
  ownerPid: number;
  ownerStartToken: string;
  fencingToken: number;
  zones?: string[];
  leaseExpiresAt: IsoInstant;
  acquiredAt: IsoInstant;
}

export interface StoredSnapshot {
  runId: RunId;
  atSequence: number;
  schemaVersion: number;
  cohorteVersion: string;
  stateSha256: Sha256;
  state: SealedJson;
}

// ── aggregates ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface RunTreeRows {
  run: RunRecord;
  phases: PhaseRecord[];
  agents: AgentRecord[];
  incarnations: IncarnationRecord[];
  worktrees: WorktreeRecord[];
  approvals: ApprovalRecord[];
  budgets: BudgetRecord[];
  locks: LockRecord[];
}

export interface StoreInfo {
  kind: string;
  /** the highest applied migration id */
  schemaVersion: number;
  /** a path for a file store, `:memory:` otherwise */
  location: string;
}

export interface MigrationStep {
  id: number;
  name: string;
  sha256: Sha256;
}

export interface MigrationReport {
  mode: 'check' | 'apply';
  /** schema version before this call / the version this build expects */
  current: number;
  target: number;
  pending: MigrationStep[];
  applied: MigrationStep[];
  /** `apply` only: where `backup()` wrote the pre-migration copy */
  backupPath?: string;
}

// ── table <-> record parity ─────────────────────────────────────────────────────────────────────────────────────
type ColumnMap<R> = Readonly<Record<string, keyof R & string>>;

const columns =
  <R>() =>
  <const M extends ColumnMap<R>>(map: [keyof R & string] extends [M[keyof M]] ? M : never): M =>
    map;

/**
 * Every table of 0001_init.sql, column by column, against the key of its record type. The `columns<R>()` helper
 * refuses a map that names a key the record lacks OR misses one it has, so this constant and the record types cannot
 * drift; the DDL parity test compares its left-hand side with `PRAGMA table_info`.
 */
export const TABLE_COLUMNS = {
  migrations: columns<MigrationRecord>()({
    id: 'id',
    name: 'name',
    sha256: 'sha256',
    applied_at: 'appliedAt',
    cohorte_version: 'cohorteVersion',
  }),
  meta: columns<MetaRecord>()({ key: 'key', value: 'value' }),
  runs: columns<RunRecord>()({
    run_id: 'runId',
    profile: 'profile',
    table_version: 'tableVersion',
    spec_id: 'specId',
    spec_sha256: 'specSha256',
    title: 'title',
    state: 'state',
    resume_to: 'resumeTo',
    stop_json: 'stop',
    last_error_json: 'lastError',
    last_sequence: 'lastSequence',
    last_hash: 'lastHash',
    version: 'version',
    snapshot_digest: 'snapshotDigest',
    runtime_pin_json: 'runtimePin',
    plan_json: 'plan',
    pinned_install_dir: 'pinnedInstallDir',
    base_branch: 'baseBranch',
    base_sha: 'baseSha',
    integration_branch: 'integrationBranch',
    integration_head: 'integrationHead',
    approved_tree_digest: 'approvedTreeDigest',
    skip_waivers_json: 'skipWaivers',
    zones_json: 'zones',
    host_id: 'hostId',
    host_pid: 'hostPid',
    host_start_token: 'hostStartToken',
    host_heartbeat_at: 'hostHeartbeatAt',
    cancel_requested: 'cancelRequested',
    pause_requested: 'pauseRequested',
    schema_version: 'schemaVersion',
    cohorte_version: 'cohorteVersion',
    purgeable: 'purgeable',
    started_at: 'startedAt',
    updated_at: 'updatedAt',
    ended_at: 'endedAt',
  }),
  events: columns<EventRecord>()({
    run_id: 'runId',
    sequence: 'sequence',
    event_id: 'eventId',
    type: 'type',
    timestamp: 'timestamp',
    source: 'source',
    phase_run_id: 'phaseRunId',
    agent_id: 'agentId',
    causation_id: 'causationId',
    severity: 'severity',
    summary: 'summary',
    envelope: 'envelope',
    prev_hash: 'prevHash',
    hash: 'hash',
  }),
  transitions: columns<TransitionRecord>()({
    transition_id: 'transitionId',
    run_id: 'runId',
    def_id: 'defId',
    table_version: 'tableVersion',
    from_state: 'from',
    to_state: 'to',
    reason: 'reason',
    actor_json: 'actor',
    guards_json: 'guards',
    effects_json: 'effects',
    idempotency_key: 'idempotencyKey',
    event_id: 'eventId',
  }),
  phases: columns<PhaseRecord>()({
    run_id: 'runId',
    phase_run_id: 'phaseRunId',
    state: 'state',
    iteration: 'iteration',
    status: 'status',
    outcome: 'outcome',
    checks_json: 'checks',
    started_at: 'startedAt',
    ended_at: 'endedAt',
  }),
  agents: columns<AgentRecord>()({
    run_id: 'runId',
    agent_id: 'agentId',
    phase_run_id: 'phaseRunId',
    role: 'role',
    surface: 'surface',
    label: 'label',
    state: 'state',
    attempt: 'attempt',
    incarnation: 'incarnation',
    max_attempts: 'maxAttempts',
    max_incarnations: 'maxIncarnations',
    model_json: 'model',
    effective_model_json: 'effectiveModel',
    auth_mode: 'authMode',
    slot: 'slot',
    context_sha256: 'contextSha256',
    grants_digest: 'grantsDigest',
    usage_json: 'usage',
    summary: 'summary',
    last_error_json: 'lastError',
    pending_approval: 'pendingApproval',
    runtime_ref_json: 'runtimeRef',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  }),
  agent_incarnations: columns<IncarnationRecord>()({
    run_id: 'runId',
    agent_id: 'agentId',
    incarnation: 'incarnation',
    attempt: 'attempt',
    state: 'state',
    cause: 'cause',
    pid: 'pid',
    start_token: 'startToken',
    host_nonce: 'hostNonce',
    runtime_ref_json: 'runtimeRef',
    stop: 'stop',
    reason: 'reason',
    usage_json: 'usage',
    started_at: 'startedAt',
    ended_at: 'endedAt',
  }),
  worktrees: columns<WorktreeRecord>()({
    run_id: 'runId',
    slot: 'slot',
    path: 'path',
    branch: 'branch',
    base_sha: 'baseSha',
    checkpoint_sha: 'checkpointSha',
    last_tree_digest: 'lastTreeDigest',
    lockfile_sha256: 'lockfileSha256',
    provision_key: 'provisionKey',
    deps_manifest_sha256: 'depsManifestSha256',
    holder_agent_id: 'holderAgentId',
    state: 'state',
  }),
  worktree_ledger: columns<LedgerEntry>()({
    run_id: 'runId',
    slot: 'slot',
    path: 'path',
    sha256: 'sha256',
    effect_id: 'effectId',
    effect_seq: 'effectSeq',
  }),
  effects: columns<EffectRecord>()({
    effect_id: 'effectId',
    run_id: 'runId',
    idempotency_key: 'idempotencyKey',
    kind: 'kind',
    replay_class: 'replayClass',
    state: 'state',
    agent_id: 'agentId',
    tool_call_id: 'toolCallId',
    slot: 'slot',
    request_json: 'request',
    verify_json: 'verify',
    pre_state_json: 'preState',
    result_json: 'result',
    error_json: 'error',
    consumes_grant: 'consumesGrant',
    compensated_by: 'compensatedBy',
    fencing_token: 'fencingToken',
    intent_seq: 'intentSeq',
    done_seq: 'doneSeq',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  }),
  approvals: columns<ApprovalRecord>()({
    approval_id: 'approvalId',
    run_id: 'runId',
    idempotency_key: 'idempotencyKey',
    kind: 'kind',
    agent_id: 'agentId',
    incarnation: 'incarnation',
    tool_call_id: 'toolCallId',
    status: 'status',
    request_json: 'request',
    grant_key: 'grantKey',
    decision_json: 'decision',
    command_auth_json: 'commandAuth',
    consumed_by_effect: 'consumedByEffect',
    requested_seq: 'requestedSeq',
    resolved_seq: 'resolvedSeq',
    expires_at: 'expiresAt',
    created_at: 'createdAt',
    resolved_at: 'resolvedAt',
  }),
  budgets: columns<BudgetRecord>()({
    run_id: 'runId',
    level: 'level',
    scope_id: 'scopeId',
    consumed_json: 'consumed',
    limit_json: 'limit',
    updated_at: 'updatedAt',
  }),
  artifacts: columns<ArtifactRecord>()({
    artifact_id: 'artifactId',
    run_id: 'runId',
    kind: 'kind',
    path: 'path',
    sha256: 'sha256',
    bytes: 'bytes',
    media_type: 'mediaType',
    agent_id: 'agentId',
    phase_run_id: 'phaseRunId',
    created_at: 'createdAt',
  }),
  findings: columns<FindingRecord>()({
    run_id: 'runId',
    finding_id: 'findingId',
    phase_run_id: 'phaseRunId',
    agent_id: 'agentId',
    severity: 'severity',
    status: 'status',
    finding_json: 'finding',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  }),
  commands: columns<CommandRecord>()({
    command_id: 'commandId',
    run_id: 'runId',
    type: 'type',
    body_sha256: 'bodySha256',
    envelope_json: 'envelope',
    auth_scheme: 'authScheme',
    auth_value: 'authValue',
    status: 'status',
    claimed_by: 'claimedBy',
    result_event_id: 'resultEventId',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  }),
  locks: columns<LockRecord>()({
    lock_id: 'lockId',
    scope: 'scope',
    key: 'key',
    mode: 'mode',
    owner_run_id: 'ownerRunId',
    owner_host_id: 'ownerHostId',
    owner_pid: 'ownerPid',
    owner_start_token: 'ownerStartToken',
    fencing_token: 'fencingToken',
    zones_json: 'zones',
    lease_expires_at: 'leaseExpiresAt',
    acquired_at: 'acquiredAt',
  }),
  snapshots: columns<StoredSnapshot>()({
    run_id: 'runId',
    at_sequence: 'atSequence',
    schema_version: 'schemaVersion',
    cohorte_version: 'cohorteVersion',
    state_sha256: 'stateSha256',
    state_json: 'state',
  }),
} as const;
export type TableName = keyof typeof TABLE_COLUMNS;
export const TABLE_NAMES = Object.keys(TABLE_COLUMNS) as readonly TableName[];

/**
 * The six host-computed columns of `runs`: a run may leave IDLE | CANCELLED | FAILED only with all of them set.
 * "Set" means non-null, exactly as the DDL's `IS NOT NULL` CHECK reads it: `runtimePin` is a `JsonValue` and a
 * stored JSON `null` is a missing column, not a value. Every implementation refuses both spellings alike.
 */
export const HOST_COMPUTED_RUN_KEYS = [
  'snapshotDigest',
  'runtimePin',
  'plan',
  'baseSha',
  'integrationBranch',
  'zones',
] as const satisfies readonly (keyof RunRecord)[];
export const STATES_WITHOUT_HOST_COLUMNS: readonly PipelineState[] = ['IDLE', 'CANCELLED', 'FAILED'];
