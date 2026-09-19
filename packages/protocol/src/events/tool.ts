// DESIGN 2.3.3 — tool calls, the files they touch, and review.
import {
  AgentId,
  ApprovalId,
  EffectId,
  FindingId,
  JsonValueSchema,
  Sha256,
  SurfaceId,
  ToolCallId,
} from '@cohorte/base';
import { Type } from 'typebox';
import { Finding, ReviewResult } from '../agent-output.ts';
import { ClosedEnum, OpenEnum } from '../open-enum.ts';
import { AgentRef, FileTouch, PhaseRef, SandboxReport } from '../refs.ts';
import { ArtifactRef } from '../vocabulary.ts';
import { count, durable, ephemeral, milliseconds, REPLAY_CLASSES, ReviewRef } from './declare.ts';

export const TOOL_DENIAL_STAGES = [
  'liveness',
  'schema',
  'capability',
  'path',
  'command',
  'network',
  'budget',
  'approval',
] as const;
export const TOOL_REJECTION_CAUSES = ['unknown-tool', 'invalid-input', 'output-truncated'] as const;
export const TOOL_DECISIONS = ['allow', 'allow-once', 'allow-for-run'] as const;
export const FINDING_DISPOSITIONS = ['kept', 'refuted', 'deferred', 'needs-investigation', 'duplicate'] as const;

const FileAccess = Type.Object({
  toolCallId: ToolCallId,
  file: FileTouch,
  diffStat: Type.Optional(Type.Object({ added: count(), removed: count() })),
});

export const TOOL_EVENTS = {
  /** `args` is sealed */
  'tool.requested': durable(
    Type.Object({ toolCallId: ToolCallId, tool: Type.String(), args: JsonValueSchema, argsSha256: Sha256 }),
  ),
  'tool.denied': durable(
    Type.Object({
      toolCallId: ToolCallId,
      tool: Type.String(),
      stage: OpenEnum(TOOL_DENIAL_STAGES),
      ruleId: Type.String(),
      reason: Type.String(),
      overridable: Type.Boolean(),
      evaluatedRules: Type.Array(Type.String()),
      approvalId: Type.Optional(ApprovalId),
    }),
  ),
  /**
   * The ENGINE refused the call before the host saw it: no `toolCallId`, no gate, no rule ids — which is why it is
   * not a `tool.denied`. `message` is sealed.
   */
  'tool.rejected': durable(
    Type.Object({
      engineToolCallId: Type.Optional(Type.String()),
      tool: Type.String(),
      cause: OpenEnum(TOOL_REJECTION_CAUSES),
      message: Type.String(),
    }),
  ),
  'tool.started': durable(
    Type.Object({
      toolCallId: ToolCallId,
      tool: Type.String(),
      effectId: EffectId,
      decision: ClosedEnum(TOOL_DECISIONS),
      ruleId: Type.String(),
      grantId: Type.Optional(Type.String()),
      normalizedArgs: JsonValueSchema,
      replayClass: ClosedEnum(REPLAY_CLASSES),
      sandbox: SandboxReport,
      /** marks a host-side replay of an approved call (4.5) */
      replayOfApproval: Type.Optional(ApprovalId),
    }),
  ),
  'tool.progress': ephemeral(
    Type.Object({ toolCallId: ToolCallId, text: Type.Optional(Type.String()), bytes: Type.Optional(count()) }),
  ),
  'tool.completed': durable(
    Type.Object({
      toolCallId: ToolCallId,
      tool: Type.String(),
      effectId: EffectId,
      isError: Type.Boolean(),
      exitCode: Type.Optional(Type.Integer()),
      signal: Type.Optional(Type.String()),
      timedOut: Type.Boolean(),
      durationMs: milliseconds(),
      /** time the runtime waited for the host, from the delivery of the call */
      waitedMs: milliseconds(),
      output: Type.Object({
        sha256: Sha256,
        bytes: count(),
        truncated: Type.Boolean(),
        preview: Type.String(),
        artifact: Type.Optional(ArtifactRef),
      }),
      filesTouched: Type.Array(FileTouch),
      /** hits dropped by output filtering (2.7) */
      filteredPaths: Type.Optional(count()),
      replayed: Type.Boolean(),
    }),
  ),
  'file.read': durable(FileAccess),
  'file.written': durable(FileAccess),
  'file.changed': durable(
    Type.Object({
      slot: Type.String(),
      files: Type.Array(FileTouch),
      detectedBy: ClosedEnum(['post-command-scan', 'ledger-audit']),
      attributedTo: Type.Optional(ToolCallId),
    }),
  ),
  'review.started': durable(
    Type.Object({
      phase: PhaseRef,
      reviewRef: ReviewRef,
      surfaces: Type.Array(SurfaceId),
      reviewers: Type.Array(AgentId),
    }),
  ),
  'review.finding': durable(
    Type.Object({ finding: Finding, reviewer: AgentRef, disposition: ClosedEnum(FINDING_DISPOSITIONS) }),
  ),
  'review.completed': durable(
    Type.Object({
      verdict: ReviewResult.properties.verdict,
      blocking: count(),
      blockingItems: Type.Array(Type.String()),
      fingerprint: ReviewResult.properties.fingerprint,
      unreviewed: Type.Array(SurfaceId),
      counts: ReviewResult.properties.counts,
      clean: Type.Boolean(),
    }),
  ),
  'review.approved': durable(
    Type.Object({
      reviewRef: ReviewRef,
      waivers: Type.Array(Type.Object({ findingId: FindingId, approvalId: ApprovalId })),
    }),
  ),
} as const;
