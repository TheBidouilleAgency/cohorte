// DESIGN 2.5, 2.5.1, 2.5.2, 2.5.3 — the shell/kernel types every core area shares. Verbatim where DESIGN gives the
// shape (RunState's aggregate, TransitionDef/TransitionTable/Guard, PhaseContract/AgentPlan/RetryPolicy/PhaseOutcome,
// LoopState/LoopPolicy/LoopDecision/RoundRecord); the smallest consistent reading elsewhere (TaskSpec, ContextRequest,
// AgentGrantRequest, PhaseRunContext/PhaseInputContext, AgentResult, ApprovalDraft, GlobalFacts, HostContext,
// EventDraftInput/EphemeralInput, SnapshotInput, LedgerAudit) — DESIGN names these as parameter/field types without
// spelling every member out, so this file picks the smallest reading consistent with how each is used (DESIGN 2.5's
// port signatures) and records it as a deviation rather than leaving the type unnamed.
import type {
  AgentId,
  ApprovalId,
  BudgetCounters,
  ErrorClass,
  ErrorInfo,
  IsoInstant,
  JsonValue,
  ModelCapability,
  ModelRef,
  RunId,
  Sha256,
  SpecId,
  SurfaceId,
  ThinkingLevel,
  ToolCallId,
} from '@cohorte/base';
// TYPE-ONLY, PLAN PC-8: `RunState` is exactly what a store's `readRunTree` returns — the aggregate `evolve`
// re-derives, transaction by transaction, from the durable event stream.
import type { ApprovalRecord, LeaseToken, RunTreeRows } from '@cohorte/persistence/contract';
import type {
  ActivePipelineState,
  AgentOutput,
  AgentRef,
  ApprovalRequest,
  ArtifactRef,
  CheckResult,
  CohorteRole,
  EphemeralEventType,
  EscalationPolicy,
  EscalationStep,
  EventType,
  Finding,
  GuardOutcome,
  PhaseRef,
  PipelineProfile,
  PipelineState,
  RunPlan,
  StopRecord,
  TransitionReason,
} from '@cohorte/protocol';
import type { Budget, RuntimePin, SandboxPolicy } from '@cohorte/runtime-contract';
import type { AgentGrant } from '@cohorte/security/contract';
import type { TSchema } from 'typebox';
import type { GuardId, TransitionEffectId } from './ids.ts';

export type RunState = RunTreeRows;

// ── phases (DESIGN 2.5.2) ──────────────────────────────────────────────────────────────────────────────────────

/** Rendered by `ContextBuilder`: a stable prefix (hashes the same across incarnations of one attempt) and a suffix
 * that may vary (a later round's remediation items, prior findings). */
export interface TaskSpec {
  role: CohorteRole;
  objective: string;
  stablePrefix: string;
  variableSuffix?: string;
  ownedPaths: string[];
  facts?: Readonly<Record<string, JsonValue>>;
}

/** What `ContextBuilder.build` renders into a `ContextManifest` (DESIGN 2.2.3): which tiers, which prior artifacts. */
export interface ContextRequest {
  tiers: readonly ('system' | 'doctrine' | 'data' | 'task' | 'prior-results')[];
  includePaths?: readonly string[];
  priorResults?: readonly ArtifactRef[];
  tokenBudget?: number;
}

/** What grant computation (DESIGN 2.6.1) is asked for; `AgentGrant` is what it returns. */
export interface AgentGrantRequest {
  role: string;
  ownedPaths: readonly string[];
  readOnlyPaths?: readonly string[];
  tools: readonly string[];
  commandsProfile?: string;
  secrets?: readonly { id: string; exposeAs: 'env'; name: string }[];
  limits?: { maxToolCalls?: number; maxCallsPerMinute?: number };
}

export interface PhaseContract<I = unknown, O = unknown> {
  readonly id: string;
  readonly version: number;
  readonly state: ActivePipelineState;
  /** human text; never parsed */
  readonly objectives: readonly string[];
  /** deterministic: run state + artifacts + snapshot only */
  resolveInputs(ctx: PhaseInputContext): { ok: true; value: I } | { ok: false; error: ErrorInfo };
  /** "agents attendus" */
  planAgents(input: I, ctx: PhaseInputContext): AgentPlan[];
  /** the phase is not complete until this validates */
  readonly outputSchema: TSchema;
  readonly checks: readonly PhaseCheck<I, O>[];
  budget(run: RunState): BudgetCounters;
  readonly stop: readonly StopRule[];
  readonly retry: RetryPolicy;
  readonly approvals: readonly ApprovalRule[];
  /** e.g. review math */
  assemble(
    input: I,
    results: AgentResult[],
    ctx: PhaseInputContext,
  ): { ok: true; value: O } | { ok: false; error: ErrorInfo };
}

export interface PhaseCheck<I, O> {
  readonly id: string;
  evaluate(input: I, output: O, ctx: PhaseInputContext): boolean;
}
export interface StopRule {
  readonly reason: string;
  applies(ctx: PhaseInputContext): boolean;
}
export interface ApprovalRule {
  readonly kind: ApprovalRequest['kind'];
  applies(ctx: PhaseInputContext): boolean;
}

export interface AgentPlan {
  agentId: AgentId;
  role: CohorteRole;
  surface?: SurfaceId;
  owner: string;
  parentAgentId?: AgentId;
  /** 'agents/implementer' -> PromptRef via PinReader */
  promptId: string;
  task: TaskSpec;
  context: ContextRequest;
  tools: string[];
  grant: AgentGrantRequest;
  modelTier: ModelCapability;
  budget: Budget;
  workspace: { kind: 'slot'; slot: string } | { kind: 'readonly-ref'; ref: string } | { kind: 'none' };
  serializeWith?: AgentId[];
}

export interface RetryPolicy {
  maxAttempts: number;
  /** only timeout, provider-transient, tool-transient, or error.retryable */
  retryOn: readonly ErrorClass[];
  backoff: { baseMs: number; factor: number; maxMs: number; jitter: 'none' | 'full' };
}

export type PhaseOutcome =
  | { kind: 'passed'; output: JsonValue; artifacts: ArtifactRef[]; checks?: CheckResult[] }
  | {
      kind: 'failed';
      failure: {
        code: 'checks-red' | 'agent-dead' | 'outputs-invalid' | 'merge-conflict';
        error: ErrorInfo;
        findings: Finding[];
      };
      checks?: CheckResult[];
    }
  | { kind: 'needs-human'; approval: ApprovalDraft }
  /** state fully persisted; re-entry continues at phases.step */
  | { kind: 'suspended'; stop: StopRecord; error?: ErrorInfo };

/** What `PhaseContract.resolveInputs` / `.planAgents` / `.assemble` read: run state + artifacts + snapshot only. */
export interface PhaseInputContext {
  run: RunState;
  phase: PhaseRef;
  now: IsoInstant;
}

/** What `PhaseExecutor.execute` and `AgentSupervisor.runAgents` are handed on top: the lease + the abort signal of
 * the step, so a crash mid-step resumes at the same step (DESIGN 2.5.2 `GenericPhaseExecutor`). */
export interface PhaseRunContext extends PhaseInputContext {
  lease: LeaseToken;
  signal: AbortSignal;
}

export interface AgentResult {
  agent: AgentRef;
  outcome: 'completed' | 'failed' | 'cancelled';
  output?: AgentOutput;
  error?: ErrorInfo;
  artifacts: ArtifactRef[];
  usage: BudgetCounters;
}

/** What `ApprovalService.request` is handed: an `ApprovalRequest` (R6) before an id is minted, plus the idempotency
 * key and grant key the store needs (DESIGN 4.5). */
export type ApprovalDraft = Omit<ApprovalRequest, 'approvalId' | 'cli'> & {
  idempotencyKey: string;
  grantKey: string;
  agentId?: AgentId;
  incarnation?: number;
  toolCallId?: ToolCallId;
};

// ── loop controller (DESIGN 2.5.3, spec 11.2) ─────────────────────────────────────────────────────────────────

export interface RoundRecord {
  round: number;
  blocking: number;
  fingerprint: string;
  checkFingerprint?: string;
  tokens: number;
  escalation?: EscalationStep;
}

export interface LoopState {
  fixRounds: number;
  reviewRounds: number;
  history: RoundRecord[];
  seenFingerprints: string[];
  escalations: EscalationStep[];
  deniedCalls: Record<AgentId, number>;
  startedAtMs: number;
}

export interface LoopPolicy {
  /** default 5, clamp 1..10 */
  maxFixRounds: number;
  /** 3 */
  noProgressWindow: number;
  /** 5 */
  maxDeniedCallsPerAgent: number;
  runWallClockMs: number;
  escalation: EscalationPolicy;
}

export type LoopDecision =
  | { kind: 'ship' }
  | { kind: 'continue'; fingerprint: string }
  | { kind: 'escalate'; step: EscalationStep; then: 'continue' }
  | { kind: 'stop'; stop: StopRecord };

// ── global stops (DESIGN 2.5.3) ────────────────────────────────────────────────────────────────────────────────

/** What `checkGlobalStops` is handed on top of `RunState`: everything evaluated "before every engine step and on
 * every budget/approval/lock/git fact change" — gathered by `FactCollector` through ports, never read directly. */
export interface GlobalFacts {
  cancelRequested: boolean;
  pauseRequested: boolean;
  leaseLost: boolean;
  pinMismatch: boolean;
  tableVersionKnown: boolean;
  securityErrorPending: boolean;
  deniedCallsByAgent: Readonly<Record<string, number>>;
  unexplainedWorktreeChange: boolean;
  blockingApprovalPending: boolean;
  authProbeMatchesExpected: boolean;
  quotaWindowExhausted: boolean;
  estimatedQuotaPercent?: number;
  budgets: {
    run: BudgetCounters;
    perPhase?: BudgetCounters;
    perAgent?: BudgetCounters;
    perProvider?: BudgetCounters;
    perTool?: BudgetCounters;
  };
  nowMs: number;
  startedAtMs: number;
}

// ── the versioned transition table (DESIGN 2.5.1, spec 11.1) ─────────────────────────────────────────────────────

/** What a `Guard` reads: the projected run and the facts `collectFacts(ids)` gathered before evaluation for the
 * row's own preconditions (DESIGN 2.5.1: "facts are gathered BEFORE by collectFacts(ids)"). */
export interface GuardContext {
  run: RunState;
  facts: GlobalFacts;
  now: IsoInstant;
}

/** PURE and synchronous; the outcome is forwarded unchanged into `run.state.changed.guards` (DESIGN 2.3.3). */
export type Guard = (ctx: GuardContext) => GuardOutcome;

/**
 * A row of the code table: from, to, reason, actor, preconditions, effects. The ids are the CLOSED sets of
 * `./ids.ts`, so a typo in a table row (`U0.09`'s `feature.v1.ts` and siblings, `as const satisfies TransitionTable`)
 * is a compile error, not a runtime scan's finding.
 *
 * DEVIATION from DESIGN 2.5.1 (one value, additive): `from` also accepts `'*any-non-terminal'`. DESIGN's own T27
 * row spans `{IDLE, *active, *suspended, FAILED, BLOCKED}`, which its two wildcards cannot express, and a single
 * `from` string cannot list five sources. The third wildcard is the smallest consistent reading; every OTHER value
 * stays closed, which is the point of the type.
 */
export interface TransitionDef {
  /** stable: "T12" */
  readonly id: string;
  readonly from: PipelineState | '*active' | '*suspended' | '*any-non-terminal';
  readonly to: PipelineState | '*resumeTo';
  readonly reason: TransitionReason;
  readonly actor: 'system' | 'human' | 'either';
  /** ALL must hold; evaluated in order; first failure is reported */
  readonly preconditions: readonly GuardId[];
  /** declarative; each is executed through the effect journal */
  readonly effects: readonly TransitionEffectId[];
}

export interface TransitionTable {
  readonly profile: PipelineProfile;
  readonly version: number;
  readonly initial: 'IDLE';
  readonly phases: readonly ActivePipelineState[];
  readonly rows: readonly TransitionDef[];
}

// ── host / engine (DESIGN 2.5) ─────────────────────────────────────────────────────────────────────────────────

/** What `RunEngine.run` and `Resumer.recover` are handed: the identity of THIS run host process. */
export interface HostContext {
  hostId: string;
  pid: number;
  startToken: string;
  cohorteVersion: string;
  signal: AbortSignal;
}

/** What `EventWriter.append` is handed: an unsealed, unvalidated durable-event draft; `EventWriter` strict-validates,
 * summarises, redacts and stamps it before it reaches the store (DESIGN 2.5). */
export interface EventDraftInput {
  type: EventType;
  payload: JsonValue;
  source?: 'cohorte' | 'runtime' | 'client' | 'human';
  phase?: PhaseRef;
  agent?: AgentRef;
  causationId?: string;
  summary: string;
  severity?: 'info' | 'success' | 'warning' | 'error' | 'progress';
}

/** What `EventWriter.ephemeral` is handed: same shape, restricted to the ephemeral types of the catalogue.
 *
 * `source` and `severity` were WIDENED IN at gate G1 (docs/v3/requests/U1.08.md R9), additively and with the same
 * defaults as before (`'cohorte'` / `'info'`), so nothing that already builds one changes. Every ephemeral type of
 * the catalogue originates in the RUNTIME (`agent.message.started` / `.delta`, `agent.turn.started`,
 * `tool.progress`); without these two fields a message's deltas were attributed to `cohorte` while its durable twin
 * `agent.message.completed` could be stamped `runtime`, so a client grouping by `source` saw one message produced by
 * two producers — and `severity: 'progress'`, which DESIGN 2.3.2 lists for exactly this kind of event, was
 * unreachable. `summary` stays absent: an ephemeral carries none (the writer stamps `''`). */
export interface EphemeralInput {
  type: EphemeralEventType;
  payload: JsonValue;
  source?: 'cohorte' | 'runtime' | 'client' | 'human';
  phase?: PhaseRef;
  agent?: AgentRef;
  severity?: 'info' | 'success' | 'warning' | 'error' | 'progress';
}

/** What `RunSnapshotter.capture` needs to materialise the eight items of spec 16 into the CAS (DESIGN 6.1). */
export interface SnapshotInput {
  runId: RunId;
  projectRoot: string;
  installDir: string;
  spec?: { id: SpecId; path: string };
  configPaths: { config: string; ownership: string; policy: string; conventions?: string };
  runtime: RuntimePin;
  trust: RunPlan['trust'];
  sandbox: SandboxPolicy;
  models: { role: string; requested: ModelRef; thinking: ThinkingLevel }[];
  /** Embedded prompt bytes to pin before any agent is spawned. */
  prompts?: { id: string; source: 'shipped' | 'project-override'; logicalPath: string; path: string }[];
}

/** What `WorktreeService.audit` returns: per-path expected vs. actual, and the verdict the caller derives. */
export interface LedgerAudit {
  slot: string;
  verdict: 'ok' | 're-added' | 'ledger-explained' | 'quarantined-reset' | 'unexplained-change' | 'missing-branch';
  entries: { path: string; expectedSha256: Sha256 | null; actualSha256: Sha256 | null; explained: boolean }[];
}

/** DESIGN 2.5.2: what `WorktreeService.checkpoint` is called for. Re-declared (not imported) from the protocol
 * `checkpoint.created.cause` closed set, so `core/src/contract/**` needs no runtime import of `protocol`'s events
 * table just for one literal union. */
export type CheckpointCause = 'phase-boundary' | 'interval' | 'pause' | 'shutdown' | 'pre-effect' | 'fatal';

/** Re-exported so a caller that already has an `ApprovalRecord` (from `StateStore`) never needs a second import
 * just to read `ApprovalService.grantFor`'s return type. */
export type { AgentGrant, ApprovalId, ApprovalRecord };
