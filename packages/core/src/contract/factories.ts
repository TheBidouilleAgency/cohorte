// DESIGN 10.1 rule 3 / PLAN §0 — the `create*` signatures and their `*Deps` types (what the composition root will
// pass) for every core area, and the frozen `@cohorte/core` barrel's typed `NotImplemented` stubs: every factory
// below THROWS as soon as it is called. A later wave unit REPLACES the body, never the signature (once this unit's
// check is green, PLAN's "optimistic scheduling" rule treats the exported names as published); `pipeline/guards`,
// `budgets`, `grants` and `projection` have no dedicated port in `internal.ts` (DESIGN 2.5 does not name one), so
// their return type and `*Deps` are declared here, next to the one factory that uses them.
import type { AgentId, BudgetCounters, RunId, Sha256, SurfaceId } from '@cohorte/base';
import { NotImplemented } from '@cohorte/base';
import type { CanonicalPath } from '@cohorte/git/contract';
import type {
  BlobStore,
  DurableEnvelope,
  EffectKind,
  EphemeralSpool,
  LeaseToken,
  StateStore,
} from '@cohorte/persistence/contract';
import type { ActivePipelineState, AgentOutput, CheckResult, Finding, ReviewResult } from '@cohorte/protocol';
import { resolveModel } from '@cohorte/providers/resolve';
import type {
  AgentRuntime,
  AgentRuntimeProvider,
  RuntimeEvent,
  RuntimeHostBindings,
  SpawnRequest,
  ToolHost,
} from '@cohorte/runtime-contract';
import type {
  AgentGrant,
  ExecRequest,
  PolicyPorts,
  PolicySnapshot,
  PolicyVerdict,
  SandboxCapabilities,
} from '@cohorte/security/contract';
import type { ToolExecContext } from '@cohorte/tools/catalogue';
import { createAgentSupervisorImpl } from '../agents/supervisor/implementation.ts';
import {
  createApprovalService as createApprovalServiceImpl,
  createToolHostReplay as createToolHostReplayImpl,
} from '../approvals/index.ts';
import { createContextBuilder as createContextBuilderImpl } from '../context/index.ts';
import { createEffectJournal as createEffectJournalImpl } from '../durability/journal/index.ts';
import { createLeaseManager as createLeaseManagerImpl } from '../durability/lease/index.ts';
import {
  createTransitionEffectRunner as createTransitionEffectRunnerImpl,
  type TransitionEffectRunnerDeps as TransitionEffectRunnerImplementationDeps,
} from '../effects/transition-runner.ts';
import type { RunEngineDeps } from '../engine/deps.ts';
import { createEngine as createEngineImpl } from '../engine/index.ts';
import { createEventWriter as createEventWriterImpl } from '../events/index.ts';
import { createGrantComputer as createGrantComputerImpl } from '../grants/index.ts';
import { createIntegrationService as createIntegrationServiceImpl } from '../integration/index.ts';
import { createLoopController as createLoopControllerImpl } from '../loop/index.ts';
import { createPhaseContracts as createPhaseContractsImpl } from '../phases/contracts/index.ts';
import { createPhaseExecutor as createPhaseExecutorImpl } from '../phases/executor/implementation.ts';
import { createPipelineGuards as createPipelineGuardsImpl } from '../pipeline/guards/index.ts';
import { createProjection as createProjectionImpl } from '../projection/index.ts';
import { createProvisionerImpl, type ProvisionImplementationDeps } from '../provision/implementation.ts';
import { createResumer as createResumerImpl } from '../resume/index.ts';
import { createReviewCalculator as createReviewCalculatorImpl } from '../review/index.ts';
import { createRunSnapshotterImpl, type SnapshotMetadata } from '../snapshot/implementation.ts';
import { createPinReader as createPinReaderImpl } from '../snapshot/index.ts';
import { createToolHost as createToolHostImpl } from '../toolhost/implementation.ts';
import { createWorktreeServiceImpl, type WorktreeImplementationDeps } from '../worktrees/implementation.ts';
import type { GuardId } from './ids.ts';
import type {
  AgentSupervisor,
  ApprovalService,
  CommitService,
  ContextBuilder,
  EffectJournal,
  EventWriter,
  LeaseManager,
  MergeService,
  PhaseExecutor,
  PinReader,
  Provisioner,
  Resumer,
  RunEngine,
  RunSnapshotter,
  ToolHostReplay,
  WorktreeService,
} from './internal.ts';
import type {
  BillingTable,
  Clock,
  EffectVerifier,
  EffectVerifierRegistry,
  Executor,
  FactCollector,
  GitPort,
  GuardRegistry,
  IdSource,
  InstallInspector,
  ModelResolver,
  PathResolver,
  PolicyEngine,
  ProcessSweeper,
  Redactor,
  ToolRegistry,
  TransitionEffectRunner,
  WorkspaceReader,
} from './ports.ts';
import type {
  AgentGrantRequest,
  AgentPlan,
  GlobalFacts,
  LoopDecision,
  LoopPolicy,
  LoopState,
  PhaseContract,
  PhaseRunContext,
  RunState,
} from './types.ts';

// ── engine ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The engine's implementation grew additive dependencies after the Wave-0
 * seam was published. Keep the public name, but expose the complete shape so
 * the composition root cannot accidentally construct a non-functional host.
 */
export type EngineDeps = RunEngineDeps;
export function createEngine(deps: EngineDeps): RunEngine {
  return createEngineImpl(deps);
}

// ── resume ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResumeDeps {
  store: StateStore;
  clock: Clock;
  sweeper: ProcessSweeper;
  effectVerifiers: EffectVerifierRegistry;
  worktrees: WorktreeService;
  // WIDENED at gate G1 (docs/v3/requests/U1.10.md D1, raised as a `lead` finding by both of U1.10's reviewers), the
  // same way `EventsDeps.spool` and `JournalDeps.redactor` were widened in U0.08's own fix round 1: never a reshape,
  // never a rename, and every added field is an EXISTING frozen port, so no contract and no package edge is new.
  // Without them DESIGN 4.4's steps 4 and 9-11 are unreachable — `run.resumed` / `lock.stolen` / `approval.resolved`
  // need an `EventWriter` (only a `Redactor` mints the `Sealed<T>` `StoreTx.appendEvents` takes), an approved call
  // whose requester died is replayed through `ToolHostReplay` (DESIGN 4.5), step 4's immutability check needs
  // `InstallInspector.installDir()`, and the `blocked-ack` approvals of steps 6 and 11 need an `ApprovalId`.
  // `packages/core/src/resume/index.ts` imports and re-exports THIS type; there is exactly one `ResumeDeps`.
  events: EventWriter;
  redactor: Redactor;
  toolHostReplay: ToolHostReplay;
  installInspector: InstallInspector;
  ids: IdSource;
}
export function createResumer(deps: ResumeDeps): Resumer {
  return createResumerImpl(deps);
}

// ── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EventsDeps {
  redactor: Redactor;
  clock: Clock;
  ids: IdSource;
  /** Ephemeral events never reach the store (DESIGN 2.3.2): `EventWriter.ephemeral()` writes to the run-level spool
   * port instead. Widened in fix round 1 (reviewer finding); `packages/core/src/events/index.ts` re-exports this
   * type rather than declaring a second one. */
  spool: EphemeralSpool;
}
export function createEventWriter(deps: EventsDeps): EventWriter {
  return createEventWriterImpl(deps);
}

// ── durability/journal ──────────────────────────────────────────────────────────────────────────────────────────

export interface JournalDeps {
  store: StateStore;
  events: EventWriter;
  clock: Clock;
  /** `StoreTx.completeEffect` persists a `SealedJson` result and `beginEffect` a sealed `request`/`verify` (DESIGN
   * 0.2 I7), so the journal seals what `perform()` returns before it is written. Widened in fix round 1 (reviewer
   * finding); `packages/core/src/durability/journal/index.ts` re-exports this type rather than declaring a second. */
  redactor: Redactor;
}
export function createEffectJournal(deps: JournalDeps): EffectJournal {
  return createEffectJournalImpl(deps);
}

// ── durability/lease ────────────────────────────────────────────────────────────────────────────────────────────

export interface LeaseDeps {
  store: StateStore;
  clock: Clock;
}
export function createLeaseManager(deps: LeaseDeps): LeaseManager {
  return createLeaseManagerImpl(deps);
}

// ── toolhost ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ToolHostDeps {
  policy: PolicyEngine;
  paths: PathResolver;
  toolRegistry: ToolRegistry;
  journal: EffectJournal;
  events: EventWriter;
  approvals: ApprovalService;
  redactor: Redactor;
  /** Additive host-side bindings required by DESIGN 2.6.2 stages 1-8. */
  policySnapshot: PolicySnapshot;
  policyPorts: PolicyPorts;
  grantFor(call: Parameters<PolicyEngine['evaluate']>[0]): AgentGrant;
  grantKeyFor(call: Parameters<PolicyEngine['evaluate']>[0], verdict: PolicyVerdict): string;
  executionFor(call: Parameters<PolicyEngine['evaluate']>[0]): ToolExecContext;
  leaseFor(call: Parameters<PolicyEngine['evaluate']>[0]): LeaseToken;
  sandbox: SandboxCapabilities;
  requestApproval(
    call: Parameters<PolicyEngine['evaluate']>[0],
    verdict: PolicyVerdict,
    signal: AbortSignal,
  ): Promise<{ decision: 'allow-once' | 'allow-for-run' | 'deny'; approvalId?: string }>;
  recordRequested(call: Parameters<PolicyEngine['evaluate']>[0]): Promise<void>;
  recordDenied(call: Parameters<PolicyEngine['evaluate']>[0], verdict: PolicyVerdict): Promise<void>;
}
export function createToolHost(deps: ToolHostDeps): ToolHost {
  return createToolHostImpl(deps);
}

// ── approvals ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ApprovalsDeps {
  store: StateStore;
  events: EventWriter;
  clock: Clock;
  ids: IdSource;
  /** Required for persistence I7; optional keeps the frozen one-wave call source-compatible. */
  redactor?: Redactor;
}
export function createApprovalService(deps: ApprovalsDeps): ApprovalService {
  return createApprovalServiceImpl(deps);
}
export function createToolHostReplay(deps: ToolHostDeps): ToolHostReplay {
  return createToolHostReplayImpl(deps);
}

// ── context ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ContextDeps {
  pin: PinReader;
  workspace: WorkspaceReader;
  writeTask(plan: AgentPlan, bytes: Uint8Array): Promise<{ path: string; sha256: Sha256; bytes: number }>;
}
export function createContextBuilder(deps: ContextDeps): ContextBuilder {
  return createContextBuilderImpl(deps);
}

// ── snapshot ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SnapshotDeps {
  installInspector: InstallInspector;
  clock: Clock;
  /** CAS and logical-path catalogue used by PinReader; core never reads installation files directly. */
  pinStore?: BlobStore;
  pinRefs?: Readonly<Record<string, { sha256: Sha256; bytes: number; path: string }>>;
  metadata?: SnapshotMetadata;
}
export function createRunSnapshotter(deps: SnapshotDeps): RunSnapshotter {
  if (!deps.pinStore || !deps.metadata) throw new NotImplemented('core/snapshot: missing CAS/metadata binding');
  return createRunSnapshotterImpl({
    installInspector: deps.installInspector,
    clock: deps.clock,
    pinStore: deps.pinStore,
    metadata: deps.metadata,
  });
}
export function createPinReader(deps: SnapshotDeps): PinReader {
  return createPinReaderImpl(deps);
}

// ── agents/supervisor ───────────────────────────────────────────────────────────────────────────────────────────

export interface AgentSupervisorDeps {
  runtimeProvider: AgentRuntimeProvider;
  events: EventWriter;
  clock: Clock;
  ids: IdSource;
  bindings?: RuntimeHostBindings;
  runtime?: AgentRuntime;
  requestFor?: (plan: AgentPlan, ctx: PhaseRunContext, incarnation: number) => SpawnRequest | Promise<SpawnRequest>;
  concurrency?: number;
  onRuntimeEvent?: (event: RuntimeEvent) => void | Promise<void>;
  outputFor?: (agentId: AgentId) => AgentOutput | undefined;
}
export function createAgentSupervisor(deps: AgentSupervisorDeps): AgentSupervisor {
  if (!deps.bindings && !deps.runtime) throw new NotImplemented('core/agents/supervisor: missing runtime binding');
  return createAgentSupervisorImpl(deps);
}

// ── worktrees ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface WorktreesDeps {
  git: GitPort;
  journal: EffectJournal;
  events: EventWriter;
  runId?: RunId;
  repo?: CanonicalPath;
  root?: CanonicalPath;
  integrationHead?: string;
}
export function createWorktreeService(deps: WorktreesDeps): WorktreeService {
  if (!deps.runId || !deps.repo || !deps.root || !deps.integrationHead)
    throw new NotImplemented('core/worktrees: missing run binding');
  const implementation: WorktreeImplementationDeps = {
    git: deps.git,
    runId: deps.runId,
    repo: deps.repo,
    root: deps.root,
    integrationHead: deps.integrationHead,
  };
  return createWorktreeServiceImpl(implementation);
}

// ── provision ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProvisionDeps {
  executor: Executor;
  journal: EffectJournal;
  requestFor?(slot: string): Promise<ExecRequest & { key: string; manifestSha256: Sha256 }>;
}
export function createProvisioner(deps: ProvisionDeps): Provisioner {
  if (!deps.requestFor) throw new NotImplemented('core/provision: missing request binding');
  const implementation: ProvisionImplementationDeps = {
    executor: deps.executor,
    requestFor: async (slot) => {
      const value = await deps.requestFor?.(slot);
      if (!value) throw new Error(`configuration/provision-request-missing: ${slot}`);
      const { key, manifestSha256, ...request } = value;
      return { key, manifestSha256, request };
    },
  };
  return createProvisionerImpl(implementation);
}

// ── phases/executor ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PhasesExecutorDeps {
  contracts: PhaseContractRegistry;
  supervisor: AgentSupervisor;
  worktrees: WorktreeService;
  integration: IntegrationService;
  events: EventWriter;
  /** Optional projection writer used by the host composition to persist acquired slots in the same run lease. */
  store?: StateStore;
  /** Optional durable finding projection; when present, review findings are sealed and indexed by run. */
  redactor?: Redactor;
  checkRunner?: PhaseCheckRunner;
}
export interface PhaseCheckRunner {
  run(ctx: PhaseRunContext): Promise<CheckResult[]>;
}
export function createPhaseExecutor(deps: PhasesExecutorDeps): PhaseExecutor {
  return createPhaseExecutorImpl(deps);
}

// ── phases/contracts ────────────────────────────────────────────────────────────────────────────────────────────

export interface PhaseContractRegistry {
  get(state: ActivePipelineState): PhaseContract | undefined;
}
export interface PhasesContractsDeps {
  provisioner: Provisioner;
}
export function createPhaseContracts(deps: PhasesContractsDeps): PhaseContractRegistry {
  return createPhaseContractsImpl(deps);
}

// ── integration (git.commit / git.merge as ports, PLAN PC-4) ──────────────────────────────────────────────────────

export interface IntegrationService extends CommitService, MergeService {}
export interface IntegrationDeps {
  git: GitPort;
  journal: EffectJournal;
  events: EventWriter;
}
export function createIntegrationService(deps: IntegrationDeps): IntegrationService {
  return createIntegrationServiceImpl(deps);
}

// ── loop ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LoopController {
  decideAfterReview(review: ReviewResult | null, loop: LoopState, policy: LoopPolicy): LoopDecision;
  decideAfterTest(checks: readonly CheckResult[], loop: LoopState, policy: LoopPolicy): LoopDecision;
}
export type LoopDeps = Record<string, never>;
export function createLoopController(deps: LoopDeps): LoopController {
  return createLoopControllerImpl(deps);
}

// ── review ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReviewCalculator {
  compute(findings: readonly Finding[], unreviewed: SurfaceId[]): ReviewResult;
}
export type ReviewDeps = Record<string, never>;
export function createReviewCalculator(deps: ReviewDeps): ReviewCalculator {
  return createReviewCalculatorImpl(deps);
}

// ── pipeline/guards (no dedicated directory: `packages/core/src/pipeline/**` is not owned by this unit) ──────────

export interface PipelineGuards extends GuardRegistry {
  collectFacts(ids: readonly GuardId[]): Promise<GlobalFacts>;
}
export interface PipelineGuardsDeps {
  factCollector: FactCollector;
}
export function createPipelineGuards(deps: PipelineGuardsDeps): PipelineGuards {
  return createPipelineGuardsImpl(deps);
}

// ── budgets ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BudgetTracker {
  remaining(level: 'run' | 'phase' | 'agent' | 'provider' | 'tool', id: string): BudgetCounters;
}
export interface BudgetsDeps {
  store: StateStore;
  billing: BillingTable;
  /** Synchronous projection read used by the security gate before a tool call.
   * The StateStore remains asynchronous; the engine updates this projection when
   * it folds a durable usage event. */
  readRemaining?: (level: 'run' | 'phase' | 'agent' | 'provider' | 'tool', id: string) => BudgetCounters;
}
export function createBudgetTracker(deps: BudgetsDeps): BudgetTracker {
  return {
    remaining(level, id) {
      const value = deps.readRemaining?.(level, id);
      if (value === undefined) return {};
      return { ...value };
    },
  };
}

// ── grants ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GrantComputer {
  compute(request: AgentGrantRequest): AgentGrant;
}
export type GrantsDeps = Record<string, never>;
export function createGrantComputer(deps: GrantsDeps): GrantComputer {
  return createGrantComputerImpl(deps);
}

// ── projection ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface Projection {
  evolve(state: RunState, event: DurableEnvelope): RunState;
}
export type ProjectionDeps = Record<string, never>;
export function createProjection(deps: ProjectionDeps): Projection {
  return createProjectionImpl(deps);
}

// ── model resolution / process sweeping (ports this plan adds; a factory each, so the barrel is uniform) ─────────

export type ModelResolverDeps = Record<string, never>;
export function createModelResolver(_deps: ModelResolverDeps): ModelResolver {
  return { resolve: resolveModel };
}
export type ProcessSweeperDeps = Record<string, never>;
export function createProcessSweeper(_deps: ProcessSweeperDeps): ProcessSweeper {
  return {
    isAlive(pid, _startToken): boolean {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async kill(pid, _startToken, signal = 'SIGTERM'): Promise<void> {
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      try {
        process.kill(pid, signal as NodeJS.Signals);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
  };
}
/** Every declarative effect of DESIGN 2.5.1's `effects` column runs through the journal and writes events; the unit
 * that implements the runner adds the area services its own ids need (`open-approval` -> `ApprovalService`,
 * `park-agents` -> `AgentSupervisor`, …) by WIDENING this type, never by reshaping it. */
export interface TransitionEffectRunnerDeps {
  store: StateStore;
  journal: EffectJournal;
  events: EventWriter;
  clock: Clock;
  handlers?: TransitionEffectRunnerImplementationDeps['handlers'];
}
export function createTransitionEffectRunner(deps: TransitionEffectRunnerDeps): TransitionEffectRunner {
  return createTransitionEffectRunnerImpl({
    journal: deps.journal,
    ...(deps.handlers ? { handlers: deps.handlers } : {}),
  });
}
export interface EffectVerifierRegistryDeps {
  verifiers?: Partial<Record<EffectKind, EffectVerifier>>;
}
export function createEffectVerifierRegistry(deps: EffectVerifierRegistryDeps): EffectVerifierRegistry {
  const verifiers = new Map<EffectKind, EffectVerifier>(
    Object.entries(deps.verifiers ?? {}) as [EffectKind, EffectVerifier][],
  );
  return { get: (kind) => verifiers.get(kind) };
}
