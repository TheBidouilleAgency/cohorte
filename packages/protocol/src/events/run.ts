// DESIGN 2.3.3 — the run, its host, its phases and its checks.
import {
  AgentId,
  BudgetCounters,
  CommandId,
  EffectId,
  ErrorInfo,
  MonetaryCost,
  Sha256,
  SpecId,
  SurfaceId,
  TokenUsage,
} from '@cohorte/base';
import { Type } from 'typebox';
import { ClosedEnum } from '../open-enum.ts';
import { PhaseRef, ResumeReport, RunPlan } from '../refs.ts';
import {
  ActivePipelineState,
  Actor,
  ArtifactRef,
  CheckResult,
  GuardOutcome,
  HaltedState,
  PipelineProfile,
  PipelineState,
  StopRecord,
  TransitionReason,
} from '../vocabulary.ts';
import { count, durable, milliseconds } from './declare.ts';

export const SPEC_KINDS = ['feature', 'patch', 'review'] as const;
export const HOST_DETACH_CAUSES = ['exit', 'signal', 'lease-lost', 'shutdown-command', 'fatal'] as const;
export const PHASE_OUTCOMES = ['passed', 'failed', 'needs-human', 'skipped'] as const;
export const CHECKPOINT_CAUSES = ['phase-boundary', 'interval', 'pause', 'shutdown', 'pre-effect', 'fatal'] as const;

export const RUN_EVENTS = {
  'pipeline.started': durable(
    Type.Object({
      profile: PipelineProfile,
      tableVersion: count(),
      spec: Type.Object({ id: SpecId, sha256: Sha256, kind: ClosedEnum(SPEC_KINDS) }),
      snapshotDigest: Sha256,
      runtime: Type.Object({ id: Type.String(), version: Type.String(), pinDigest: Type.String() }),
      plan: RunPlan,
      base: Type.Object({ branch: Type.String(), sha: Type.String() }),
      integrationBranch: Type.String(),
      cohorteVersion: Type.String(),
      hostId: Type.String(),
    }),
  ),
  'pipeline.completed': durable(
    Type.Object({
      stop: StopRecord,
      integration: Type.Object({ branch: Type.String(), headSha: Type.String(), treeDigest: Type.String() }),
      totals: Type.Object({
        usage: BudgetCounters,
        tokens: TokenUsage,
        monetaryCost: MonetaryCost,
        fixRounds: count(),
        durationMs: milliseconds(),
      }),
    }),
  ),
  'pipeline.failed': durable(
    Type.Object({ state: HaltedState, error: ErrorInfo, stop: StopRecord, checkpointSequence: count() }),
  ),
  'run.state.changed': durable(
    Type.Object({
      transitionId: Type.String(),
      defId: Type.String(),
      tableVersion: count(),
      from: PipelineState,
      to: PipelineState,
      reason: TransitionReason,
      actor: Actor,
      guards: Type.Array(GuardOutcome),
      idempotencyKey: Type.String(),
      resumeTo: Type.Optional(ActivePipelineState),
      stop: Type.Optional(StopRecord),
    }),
  ),
  'run.paused': durable(
    Type.Object({
      commandId: Type.Optional(CommandId),
      parkedAgents: Type.Array(AgentId),
      inFlightEffects: Type.Array(EffectId),
    }),
  ),
  'run.resumed': durable(
    Type.Object({
      commandId: Type.Optional(CommandId),
      mode: ClosedEnum(['unpause', 'recovery', 'retry']),
      report: ResumeReport,
    }),
  ),
  'run.cancelled': durable(
    Type.Object({
      commandId: Type.Optional(CommandId),
      reason: Type.String(),
      cancelledAgents: Type.Array(AgentId),
      worktreesKept: Type.Boolean(),
    }),
  ),
  'run.host.attached': durable(
    Type.Object({
      hostId: Type.String(),
      pid: count(),
      cohorteVersion: Type.String(),
      fencingToken: count(),
      takeover: Type.Boolean(),
    }),
  ),
  'run.host.detached': durable(Type.Object({ hostId: Type.String(), cause: ClosedEnum(HOST_DETACH_CAUSES) })),
  'phase.started': durable(
    Type.Object({
      phase: PhaseRef,
      contractId: Type.String(),
      /** PhaseContract.version (DESIGN 2.5.2): a number */
      contractVersion: count(),
      planned: Type.Array(Type.Object({ agentId: AgentId, role: Type.String(), surface: Type.Optional(SurfaceId) })),
      budget: BudgetCounters,
    }),
  ),
  'phase.completed': durable(
    Type.Object({
      phase: PhaseRef,
      outcome: ClosedEnum(PHASE_OUTCOMES),
      outputs: Type.Array(ArtifactRef),
      checks: Type.Array(CheckResult),
      durationMs: milliseconds(),
    }),
  ),
  'check.started': durable(Type.Object({ name: Type.String(), argv: Type.Array(Type.String()), slot: Type.String() })),
  'check.completed': durable(CheckResult),
  error: durable(Type.Object({ error: ErrorInfo, fatal: Type.Boolean() })),
  'checkpoint.created': durable(
    Type.Object({
      atSequence: count(),
      snapshotSha256: Sha256,
      chainHash: Type.String(),
      chainMac: Type.String(),
      cause: ClosedEnum(CHECKPOINT_CAUSES),
    }),
  ),
} as const;
