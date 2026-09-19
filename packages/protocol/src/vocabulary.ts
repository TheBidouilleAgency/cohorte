// DESIGN 2.3.1 — the ONE home of the shared pipeline vocabulary. `core`, `config` and `persistence` import it from
// `protocol`; `protocol` never imports them. This file is the leaf of the package: it imports nothing from its siblings
// except the enum helpers.
//
// OPEN ON THE WIRE (spec 32: a provisional ADR is never frozen as a closed wire enum): PipelineProfile (ADR-0018),
// Actor.transport (ADR-0004), CohorteRole, StopRecord.resumeRequires, ArtifactRef.kind. The TS unions list the KNOWN
// values; `core` still switches exhaustively over them and rejects an unknown one at the door.
import { ArtifactId, ModelCapability, Sha256 } from '@cohorte/base';
import { type Static, Type } from 'typebox';
import { ClosedEnum, OpenEnum } from './open-enum.ts';

export const PIPELINE_PROFILES = ['feature', 'bugfix', 'review'] as const;
/** D6 / R3. Known values only: the wire schema below is open. */
export type PipelineProfile = (typeof PIPELINE_PROFILES)[number];
export const PipelineProfile = OpenEnum(PIPELINE_PROFILES);
/** A parsed payload carries `OpenEnumOf<PipelineProfile>` (any string): narrow it here, at the door, before a switch. */
export const isKnownProfile = (value: string): value is PipelineProfile =>
  (PIPELINE_PROFILES as readonly string[]).includes(value);

export const ACTIVE_PIPELINE_STATES = [
  'BRAINSTORM',
  'SPEC',
  'PREFLIGHT',
  'BUILD',
  'TEST',
  'REVIEW',
  'FIX',
  'SHIP',
] as const;
/** spec 11.1 + the two states spec 10.1 names */
export const SUSPENDED_STATES = ['PAUSED', 'WAITING_APPROVAL', 'AUTH_REQUIRED', 'QUOTA_EXCEEDED'] as const;
/** FAILED: recoverable checkpoint (spec 24). BLOCKED: human inspection mandatory. */
export const HALTED_STATES = ['FAILED', 'BLOCKED'] as const;
export const TERMINAL_STATES = ['COMPLETED', 'CANCELLED'] as const;
export const PIPELINE_STATES = [
  'IDLE',
  ...ACTIVE_PIPELINE_STATES,
  ...SUSPENDED_STATES,
  ...HALTED_STATES,
  ...TERMINAL_STATES,
] as const;

export const ActivePipelineState = ClosedEnum(ACTIVE_PIPELINE_STATES);
export type ActivePipelineState = Static<typeof ActivePipelineState>;
export const SuspendedState = ClosedEnum(SUSPENDED_STATES);
export type SuspendedState = Static<typeof SuspendedState>;
export const HaltedState = ClosedEnum(HALTED_STATES);
export type HaltedState = Static<typeof HaltedState>;
export const TerminalState = ClosedEnum(TERMINAL_STATES);
export type TerminalState = Static<typeof TerminalState>;
export const PipelineState = ClosedEnum(PIPELINE_STATES);
export type PipelineState = Static<typeof PipelineState>;

export const TRANSITION_REASONS = [
  'start',
  'ready',
  'built',
  'tests-pass',
  'tests-fail',
  'review-approved',
  'review-findings',
  'review-delivered',
  'fixed',
  'shipped',
  'needs-human',
  'approval-resolved',
  'pause-command',
  'resume-command',
  'cancel-command',
  'retry-command',
  'skip-command',
  'auth-required',
  'auth-restored',
  'quota-exceeded',
  'quota-reset',
  'stop-rule',
  'security-violation',
  'unexpected-error',
] as const;
export const TransitionReason = ClosedEnum(TRANSITION_REASONS);
export type TransitionReason = Static<typeof TransitionReason>;

export const STOP_REASONS = [
  // the ten of spec 11.2, in spec order:
  'review-clean',
  'iteration-limit',
  'budget-exhausted',
  'timeout',
  'identical-failure',
  'no-progress',
  'policy-violation',
  'approval-required',
  'unexpected-repo-change',
  'runtime-incompatible',
  // required by spec 10.1, 17.2, 24:
  'auth-required',
  'quota-exceeded',
  'paused',
  'cancelled',
  'agent-dead',
  'unreviewed',
  'internal-error',
  // required by table totality (2.5.1 T16): a check that ERRORED (spawn failure, timeout, sandbox denial) is
  // neither "tests pass" nor "tests fail":
  'check-environment',
] as const;
export const StopReason = ClosedEnum(STOP_REASONS);
export type StopReason = Static<typeof StopReason>;

export const AGENT_STATES = [
  'declared',
  'planned',
  'spawning',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'retrying',
  'escalated',
  'cancelled',
] as const;
export const AgentState = ClosedEnum(AGENT_STATES);
export type AgentState = Static<typeof AgentState>;

/** R2 */
export const NODE_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'paused',
  'waiting-approval',
  'cancelled',
  'skipped',
  'blocked',
] as const;
export const NodeStatus = ClosedEnum(NODE_STATUSES);
export type NodeStatus = Static<typeof NodeStatus>;

/** The eleven roles of spec 8, and `verifier`: the id is reserved, the adversarial cross-check is off in V3.0 (2.9). */
export const COHORTE_ROLES = [
  'discoverer',
  'brainstormer',
  'architect',
  'spec-author',
  'implementer',
  'tester',
  'reviewer',
  'security-reviewer',
  'fixer',
  'release-manager',
  'reconciler',
  'verifier',
] as const;
export type CohorteRole = (typeof COHORTE_ROLES)[number];
/** OpenEnum on the wire. Inside Cohorte a role is one of the known ones: see {@link KnownCohorteRole}. */
export const CohorteRole = OpenEnum(COHORTE_ROLES);
/** Closed: for data Cohorte itself authors and switches over (the escalation ladder). */
export const KnownCohorteRole = ClosedEnum(COHORTE_ROLES);

/** spec 22 speaks of 'major' */
export const SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export const Severity = ClosedEnum(SEVERITIES);
export type Severity = Static<typeof Severity>;

/** V3.0 implements ONE transport; 'stdin' / 'socket' are future open-enum values, not promises. Identity rules: 2.6.7 */
export const ACTOR_TRANSPORTS = ['cli'] as const;
export const Actor = Type.Object({
  kind: ClosedEnum(['human', 'client', 'system']),
  id: Type.String(),
  transport: OpenEnum(ACTOR_TRANSPORTS),
});
export type Actor = Static<typeof Actor>;

export const GuardOutcome = Type.Object({
  id: Type.String(),
  ok: Type.Boolean(),
  detail: Type.Optional(Type.String()),
});
export type GuardOutcome = Static<typeof GuardOutcome>;

export const RESUME_REQUIREMENTS = [
  'approval',
  'auth-login',
  'quota-reset',
  'budget-raise',
  'human-ack',
  'repo-repair',
  'reinstall-pinned-version',
  'environment-repair',
] as const;
export const StopRecord = Type.Object({
  reason: StopReason,
  detail: Type.String(),
  resumable: Type.Boolean(),
  resumeRequires: Type.Optional(OpenEnum(RESUME_REQUIREMENTS)),
});
export type StopRecord = Static<typeof StopRecord>;

/** Declared in base/usage.ts (DESIGN 2.1, PLAN PC-8); re-exported so protocol consumers keep one import. */
export { BudgetCounters } from '@cohorte/base';

export const EscalationStep = Type.Union([
  Type.Object({
    kind: Type.Literal('model-tier'),
    role: KnownCohorteRole,
    from: ModelCapability,
    to: ModelCapability,
  }),
  Type.Object({ kind: Type.Literal('role'), from: KnownCohorteRole, to: KnownCohorteRole }),
  Type.Object({ kind: Type.Literal('human') }),
]);
export type EscalationStep = Static<typeof EscalationStep>;

/** Data: used by config AND by `escalation.applied`. Defaults: sameFailureCount 2, maxPerRun 2. */
export const EscalationPolicy = Type.Object({
  sameFailureCount: Type.Integer({ minimum: 1 }),
  ladder: Type.Array(EscalationStep),
  maxPerRun: Type.Integer({ minimum: 0 }),
});
export type EscalationPolicy = Static<typeof EscalationPolicy>;

export const ARTIFACT_KINDS = [
  'diff',
  'file',
  'log',
  'report',
  'agent-output',
  'transcript',
  'context',
  'prompt',
  'patch',
] as const;
/**
 * DESIGN 2.3.3. Declared HERE and re-exported by refs.ts: CheckResult needs it, and refs.ts needs the states and the
 * profile of this file. Schemas are values, so an import cycle between the two files would read a const before it is set.
 */
export const ArtifactRef = Type.Object({
  artifactId: ArtifactId,
  kind: OpenEnum(ARTIFACT_KINDS),
  path: Type.String(),
  sha256: Sha256,
  bytes: Type.Integer({ minimum: 0 }),
});
export type ArtifactRef = Static<typeof ArtifactRef>;

export const CheckResult = Type.Object({
  name: Type.String(),
  status: ClosedEnum(['passed', 'failed', 'errored', 'skipped']),
  argv: Type.Array(Type.String()),
  exitCode: Type.Optional(Type.Integer()),
  durationMs: Type.Number({ minimum: 0 }),
  treeDigest: Type.String(),
  output: Type.Optional(ArtifactRef),
});
export type CheckResult = Static<typeof CheckResult>;
