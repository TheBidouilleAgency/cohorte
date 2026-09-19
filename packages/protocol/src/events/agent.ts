// DESIGN 2.3.3 — agents, their turns and messages, the model calls and the context they were given (R9).
import {
  AgentId,
  AuthMode,
  BudgetCounters,
  ErrorInfo,
  ModelRef,
  MonetaryCost,
  QuotaInfo,
  Sha256,
  ThinkingLevel,
  TokenUsage,
} from '@cohorte/base';
import { Type } from 'typebox';
import { AgentOutput } from '../agent-output.ts';
import { ClosedEnum, OpenEnum } from '../open-enum.ts';
import { AgentRef, RuntimeRef, SandboxReport } from '../refs.ts';
import { AgentState, ArtifactRef, EscalationStep } from '../vocabulary.ts';
import { count, durable, ephemeral, milliseconds } from './declare.ts';

export const AGENT_STATE_CHANGE_REASONS = [
  'planned',
  'spawned',
  'tool-wait',
  'approval-wait',
  'quota-wait',
  'peer-wait',
  'paused',
  'resumed',
  'completed',
  'failed',
  'cancelled',
  'retry',
  'escalation',
  'recovery',
  'park',
  'pause-expiry',
] as const;
/** `agent.state.changed.attemptConsumed` is true ONLY for these reasons (2.5.4): a reincarnation that is not a retry costs no attempt. */
export const ATTEMPT_CONSUMING_REASONS = ['retry', 'escalation'] as const;

export const MESSAGE_ROLES = ['assistant', 'user', 'tool-result'] as const;
export const MESSAGE_CHANNELS = ['text', 'thinking', 'tool-input'] as const;
export const MESSAGE_STOPS = ['stop', 'length', 'tool-use', 'error', 'aborted'] as const;
export const MESSAGE_DELIVERIES = ['steer', 'follow-up'] as const;
export const MESSAGE_DELTA_MAX_LENGTH = 8192;
export const MESSAGE_PREVIEW_MAX_LENGTH = 512;

export const CONTEXT_TIERS = ['system', 'doctrine', 'data', 'task', 'prior-results'] as const;
export const CONTEXT_TRUST_LEVELS = ['cohorte', 'human', 'untrusted-repository', 'agent-output'] as const;
export const CONTEXT_SOURCE_KINDS = ['asset', 'project-file', 'artifact', 'event-summary', 'inline'] as const;
export const CONTEXT_REDUCTION_STRATEGIES = ['excerpt', 'outline', 'summary-with-refs', 'dropped'] as const;
export const CONTEXT_EXCLUSION_REASONS = ['secret', 'outside-scope', 'size', 'binary'] as const;

/**
 * R9. The shapes of the context manifest (DESIGN 2.2.4), declared here a second time: protocol imports no other
 * package than base (C4). Exported because `inspect { kind: 'context' }` returns this payload as it is.
 */
export const ContextBuiltPayload = Type.Object({
  agent: AgentRef,
  manifestSha256: Sha256,
  tokenEstimate: count(),
  tokenLimit: count(),
  entries: Type.Array(
    Type.Object({
      id: Type.String(),
      tier: ClosedEnum(CONTEXT_TIERS),
      trust: ClosedEnum(CONTEXT_TRUST_LEVELS),
      source: Type.Object({ kind: ClosedEnum(CONTEXT_SOURCE_KINDS), ref: Type.String() }),
      sha256: Sha256,
      bytes: count(),
      tokenEstimate: count(),
    }),
  ),
  reductions: Type.Array(
    Type.Object({
      entryId: Type.String(),
      strategy: ClosedEnum(CONTEXT_REDUCTION_STRATEGIES),
      fromBytes: count(),
      toBytes: count(),
    }),
  ),
  exclusions: Type.Array(Type.Object({ pattern: Type.String(), reason: ClosedEnum(CONTEXT_EXCLUSION_REASONS) })),
  manifest: ArtifactRef,
});

export const AGENT_EVENTS = {
  'agent.declared': durable(
    Type.Object({
      agent: AgentRef,
      parentAgentId: Type.Optional(AgentId),
      owner: Type.String(),
      ownedPaths: Type.Array(Type.String()),
      grantsDigest: Sha256,
      requestedModel: ModelRef,
      thinking: ThinkingLevel,
      routingReason: Type.String(),
      budget: BudgetCounters,
    }),
  ),
  'agent.spawned': durable(
    Type.Object({
      agent: AgentRef,
      worktree: Type.Optional(
        Type.Object({ slot: Type.String(), path: Type.String(), branch: Type.String(), baseSha: Type.String() }),
      ),
      tools: Type.Array(Type.String()),
      systemPromptSha256: Sha256,
      effectiveSystemPromptSha256: Sha256,
      authMode: AuthMode,
      isolation: SandboxReport,
      runtimeRef: Type.Optional(RuntimeRef),
    }),
  ),
  'agent.started': durable(Type.Object({ agent: AgentRef, taskSha256: Sha256 })),
  'agent.state.changed': durable(
    Type.Object({
      agent: AgentRef,
      from: AgentState,
      to: AgentState,
      reason: OpenEnum(AGENT_STATE_CHANGE_REASONS),
      pausedAt: Type.Optional(ClosedEnum(['tool-boundary', 'model-boundary'])),
      attemptConsumed: Type.Boolean(),
    }),
  ),
  'agent.completed': durable(
    Type.Object({
      agent: AgentRef,
      status: AgentOutput.properties.status,
      summary: Type.String(),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      output: ArtifactRef,
      artifacts: Type.Array(ArtifactRef),
      findings: count(),
      questions: Type.Array(Type.String()),
      usage: BudgetCounters,
    }),
  ),
  'agent.failed': durable(
    Type.Object({
      agent: AgentRef,
      error: ErrorInfo,
      willRetry: Type.Boolean(),
      nextIncarnation: Type.Optional(count()),
    }),
  ),
  'agent.turn.started': ephemeral(Type.Object({ turn: count() })),
  'agent.turn.completed': durable(Type.Object({ turn: count(), toolCalls: count() })),
  /** R1 */
  'agent.message.started': ephemeral(Type.Object({ messageId: Type.String(), role: ClosedEnum(MESSAGE_ROLES) })),
  'agent.message.delta': ephemeral(
    Type.Object({
      messageId: Type.String(),
      channel: ClosedEnum(MESSAGE_CHANNELS),
      contentIndex: count(),
      delta: Type.String({ maxLength: MESSAGE_DELTA_MAX_LENGTH }),
    }),
  ),
  'agent.message.completed': durable(
    Type.Object({
      messageId: Type.String(),
      role: ClosedEnum(MESSAGE_ROLES),
      preview: Type.String({ maxLength: MESSAGE_PREVIEW_MAX_LENGTH }),
      textSha256: Sha256,
      bytes: count(),
      stop: Type.Optional(ClosedEnum(MESSAGE_STOPS)),
    }),
  ),
  /** the runtime took a `send` (host note, nudge, or `agent.send`) into its queue */
  'agent.message.accepted': durable(
    Type.Object({ agent: AgentRef, messageId: Type.String(), delivery: ClosedEnum(MESSAGE_DELIVERIES) }),
  ),
  /** non-fatal runtime diagnostics (unmapped stop reason, stale auth snapshot, degraded capability); `message` is sealed */
  'runtime.warning': durable(
    Type.Object({ agent: Type.Optional(AgentRef), code: Type.String(), message: Type.String() }),
  ),
  'model.requested': durable(
    Type.Object({
      requestId: Type.String(),
      model: ModelRef,
      expectedAuthMode: AuthMode,
      contextSha256: Type.Optional(Sha256),
      attempt: count(),
    }),
  ),
  'model.responded': durable(
    Type.Object({
      requestId: Type.String(),
      requestedModel: ModelRef,
      effectiveModel: Type.Object({
        provider: Type.String(),
        model: Type.String(),
        api: Type.Optional(Type.String()),
        baseUrl: Type.Optional(Type.String()),
      }),
      authMode: AuthMode,
      authSource: ClosedEnum(['oauth', 'api-key', 'none']),
      status: ClosedEnum(['ok', 'error']),
      httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
      durationMs: milliseconds(),
      tokens: TokenUsage,
      monetaryCost: MonetaryCost,
      quota: QuotaInfo,
      attempt: count(),
      error: Type.Optional(ErrorInfo),
    }),
  ),
  'context.built': durable(ContextBuiltPayload),
  'escalation.applied': durable(Type.Object({ agent: AgentRef, step: EscalationStep, because: Type.String() })),
} as const;
