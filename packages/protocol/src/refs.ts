// DESIGN 2.3.3 (the records that event payloads, documents and commands share).
//
// OPEN ON THE WIRE: SandboxReport.level / .backend / .filesystem / .network (ADR-0003), RunPlan.profile and
// RunPlan.trust.grantedBy, ApprovalRequest.kind, and every ResumeReport verdict.
import {
  AgentId,
  ApprovalId,
  AuthMode,
  BudgetCounters,
  CommandId,
  EffectId,
  IsoInstant,
  JsonValueSchema,
  ModelRef,
  PhaseRunId,
  Sha256,
  SurfaceId,
  ThinkingLevel,
  ToolCallId,
} from '@cohorte/base';
import { type Static, Type } from 'typebox';
import { ClosedEnum, OpenEnum } from './open-enum.ts';
import { ActivePipelineState, PipelineProfile } from './vocabulary.ts';

export { ARTIFACT_KINDS, ArtifactRef } from './vocabulary.ts';

const count = () => Type.Integer({ minimum: 0 });

export const PhaseRef = Type.Object({
  phaseRunId: PhaseRunId,
  state: ActivePipelineState,
  iteration: count(),
});
export type PhaseRef = Static<typeof PhaseRef>;

/** `role` is a plain string here (DESIGN 2.3.3): a reader must be able to show an agent whose role it does not know. */
export const AgentRef = Type.Object({
  agentId: AgentId,
  role: Type.String(),
  surface: Type.Optional(SurfaceId),
  incarnation: count(),
  attempt: count(),
});
export type AgentRef = Static<typeof AgentRef>;

/** R8: optional wherever it appears, and opaque. A client never needs it. */
export const RuntimeRef = Type.Object({
  runtime: Type.String(),
  version: Type.String(),
  sessionId: Type.String(),
  transcriptRef: Type.String(),
});
export type RuntimeRef = Static<typeof RuntimeRef>;

export const FileTouch = Type.Object({
  /** worktree-relative, POSIX */
  path: Type.String(),
  op: ClosedEnum(['read', 'create', 'modify', 'delete']),
  beforeSha256: Type.Optional(Sha256),
  afterSha256: Type.Optional(Sha256),
  bytes: Type.Optional(count()),
});
export type FileTouch = Static<typeof FileTouch>;

export const SANDBOX_LEVELS = ['L0-process', 'L1-os'] as const;
export const SANDBOX_BACKENDS = ['none', 'seatbelt', 'bubblewrap'] as const;
/** 'partial' = backend active but its escape test (S-28 / S-29) has not passed on this platform */
export const SANDBOX_FILESYSTEM_VERDICTS = ['enforced', 'partial', 'advisory'] as const;
export const SANDBOX_NETWORK_VERDICTS = ['enforced-off', 'partial', 'unenforced'] as const;
export const SandboxReport = Type.Object({
  level: OpenEnum(SANDBOX_LEVELS),
  backend: OpenEnum(SANDBOX_BACKENDS),
  filesystem: OpenEnum(SANDBOX_FILESYSTEM_VERDICTS),
  network: OpenEnum(SANDBOX_NETWORK_VERDICTS),
});
export type SandboxReport = Static<typeof SandboxReport>;

export const TRUST_GRANTS = ['none-needed', 'user-config', 'cli-flag', 'trust-record'] as const;
export const RunPlan = Type.Object({
  profile: PipelineProfile,
  runtime: Type.Object({ id: Type.String(), version: Type.String() }),
  /** 2.10.1: WHO consented to every security-loosening key of the project file */
  trust: Type.Object({
    policySha256: Sha256,
    loosenedKeys: Type.Array(Type.String()),
    grantedBy: OpenEnum(TRUST_GRANTS),
  }),
  models: Type.Array(
    Type.Object({
      role: Type.String(),
      requested: ModelRef,
      thinking: ThinkingLevel,
      authMode: AuthMode,
      billing: ClosedEnum(['plan-limits', 'metered']),
      reason: Type.String(),
    }),
  ),
  apiBillingEnabled: Type.Boolean(),
  /** non-empty => the plan printed to the human names per-token billing */
  meteredProviders: Type.Array(Type.String()),
  sandbox: SandboxReport,
  sandboxRequire: ClosedEnum(['native', 'best-effort']),
  brainIsolation: ClosedEnum(['os', 'process']),
  budgets: Type.Object({
    run: BudgetCounters,
    perPhase: BudgetCounters,
    perAgent: BudgetCounters,
    perProvider: Type.Record(Type.String(), BudgetCounters),
    perTool: Type.Record(Type.String(), BudgetCounters),
  }),
  network: Type.Object({ provisioning: Type.Boolean() }),
  promptOverrides: Type.Array(Type.String()),
  unattended: Type.Boolean(),
});
export type RunPlan = Static<typeof RunPlan>;

export const APPROVAL_KINDS = [
  'tool',
  'shared-path',
  'ship',
  'budget',
  'loop-stalled',
  'contract-change',
  'spec-not-ready',
  'review-leftovers',
  'unowned-path',
  'api-billing',
  'blocked-ack',
  'provision-network',
] as const;
/** R6 — everything a human needs without reading a transcript */
export const ApprovalRequest = Type.Object({
  approvalId: ApprovalId,
  kind: OpenEnum(APPROVAL_KINDS),
  agent: Type.Optional(AgentRef),
  phase: Type.Optional(PhaseRef),
  tool: Type.Optional(Type.String()),
  /** sealed */
  args: Type.Optional(JsonValueSchema),
  affectedPaths: Type.Array(Type.String()),
  /** sealed; agent-controlled text: clients MUST render it through the sanitiser of 2.3.6 */
  preview: Type.Object({ kind: ClosedEnum(['diff', 'command', 'text']), text: Type.String() }),
  /** only for the `approval_request` tool: the answers the agent offered; `approve.answer` must be one of them */
  options: Type.Optional(Type.Array(Type.String())),
  ruleId: Type.String(),
  reason: Type.String(),
  asks: Type.Array(Type.Object({ stage: Type.String(), ruleId: Type.String(), reason: Type.String() })),
  allowedDecisions: Type.Array(ClosedEnum(['allow-once', 'allow-for-run', 'deny'])),
  /** what the decision is bound to (4.5): the target's beforeSha256 (write/patch) or the slot's treeDigest (command) */
  preStateSha256: Type.Optional(Sha256),
  expiresAt: Type.Optional(IsoInstant),
  unattended: ClosedEnum(['deny', 'wait']),
  /** literal "cohorte approve <id>" */
  cli: Type.String(),
});
export type ApprovalRequest = Static<typeof ApprovalRequest>;

export const WORKTREE_VERDICTS = [
  'ok',
  're-added',
  'ledger-explained',
  'quarantined-reset',
  'unexplained-change',
  'missing-branch',
] as const;
export const EFFECT_VERDICTS = ['done', 'failed', 're-executed', 'in-doubt', 'compensated'] as const;
export const APPROVED_REPLAY_OUTCOMES = ['executed', 'binding-changed', 'denied-by-gate'] as const;
export const ResumeReport = Type.Object({
  takeover: Type.Boolean(),
  hostId: Type.String(),
  fencingToken: count(),
  locks: Type.Object({ rebuilt: Type.Array(Type.String()), conflicts: Type.Array(Type.String()) }),
  orphans: Type.Array(
    Type.Object({
      agentId: Type.Optional(AgentId),
      incarnation: Type.Optional(count()),
      pid: count(),
      kind: ClosedEnum(['brain', 'command']),
      killed: Type.Boolean(),
    }),
  ),
  worktrees: Type.Array(
    Type.Object({ slot: Type.String(), path: Type.String(), verdict: OpenEnum(WORKTREE_VERDICTS) }),
  ),
  effects: Type.Array(
    Type.Object({
      effectId: EffectId,
      kind: Type.String(),
      replayClass: ClosedEnum(['idempotent', 'verifiable', 'at-most-once']),
      verdict: OpenEnum(EFFECT_VERDICTS),
    }),
  ),
  approvalsCarried: Type.Array(ApprovalId),
  commandsApplied: Type.Array(CommandId),
  inDoubt: Type.Array(EffectId),
  /** 4.5 parked path */
  approvedReplays: Type.Array(
    Type.Object({ approvalId: ApprovalId, toolCallId: ToolCallId, outcome: OpenEnum(APPROVED_REPLAY_OUTCOMES) }),
  ),
});
export type ResumeReport = Static<typeof ResumeReport>;
