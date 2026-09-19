import { type AgentId, type BudgetCounters, errorOf, type ModelCapability, type SurfaceId } from '@cohorte/base';
import type { ActivePipelineState, CohorteRole } from '@cohorte/protocol';
import { Type } from 'typebox';
import type { PhaseContractRegistry, PhasesContractsDeps } from '../../contract/factories.ts';
import type { AgentPlan, AgentResult, PhaseContract, PhaseInputContext, TaskSpec } from '../../contract/types.ts';
import { calculateReview } from '../../review/normalize.ts';

export type { PhaseContractRegistry, PhasesContractsDeps };

const SUPPORTED_PHASES = [
  'PREFLIGHT',
  'BUILD',
  'TEST',
  'REVIEW',
  'FIX',
  'SHIP',
] as const satisfies readonly ActivePipelineState[];
type SupportedPhase = (typeof SUPPORTED_PHASES)[number];

const RETRY = {
  maxAttempts: 3,
  retryOn: ['timeout', 'provider-transient', 'tool-transient'] as const,
  backoff: { baseMs: 250, factor: 2, maxMs: 10_000, jitter: 'full' as const },
};

const OBJECTIVES: Record<SupportedPhase, string> = {
  PREFLIGHT: 'validate readiness, specification completeness and surface ownership',
  BUILD: 'implement the frozen specification in isolated surface worktrees',
  TEST: 'run the project checks against the integration tree',
  REVIEW: 'review every touched surface against the immutable review reference',
  FIX: 'address open review findings without changing their claims',
  SHIP: 'verify the approved integration digest and prepare the ship report',
};

const phaseError = (state: ActivePipelineState) =>
  errorOf('configuration/phase-not-available', `phase ${state} has no V3 implementation`);

function surfacesOf(ctx: PhaseInputContext): string[] {
  const fromWorktrees = ctx.run.worktrees.map((worktree) => worktree.slot).filter((slot) => !slot.startsWith('_'));
  const fromAgents = ctx.run.agents.flatMap((agent) => (agent.surface === undefined ? [] : [agent.surface as string]));
  const fromPlan = ctx.run.run.zones?.filter((zone) => !zone.startsWith('_')) ?? [];
  return [...new Set([...fromPlan, ...fromWorktrees, ...fromAgents])].sort();
}

function toolsFor(role: CohorteRole): string[] {
  if (role === 'reviewer' || role === 'security-reviewer') {
    return ['read_file', 'list_files', 'search', 'git_diff', 'submit_result'];
  }
  return ['read_file', 'list_files', 'search', 'git_diff', 'write_file', 'patch_file', 'run_command', 'submit_result'];
}

function planFor(role: 'implementer' | 'reviewer' | 'fixer', surface: string, state: SupportedPhase): AgentPlan {
  const ownedPaths = [`${surface}/**`];
  const tools = toolsFor(role);
  const readOnly = role === 'reviewer';
  const task: TaskSpec = {
    role,
    objective: OBJECTIVES[state],
    stablePrefix: `cohorte ${state.toLowerCase()} task for surface ${surface}`,
    ownedPaths,
    facts: { phase: state, surface },
  };
  return {
    agentId: `agt_${role}_${surface}` as AgentId,
    role,
    surface: surface as SurfaceId,
    owner: surface,
    promptId: `agents/${role}`,
    task,
    context: { tiers: ['system', 'doctrine', 'data', 'task', 'prior-results'], includePaths: ownedPaths },
    tools,
    grant: {
      role,
      ownedPaths: readOnly ? [] : ownedPaths,
      ...(readOnly ? { readOnlyPaths: ownedPaths } : {}),
      tools,
    },
    modelTier: (role === 'reviewer' ? 'reasoning' : 'coding') as ModelCapability,
    budget: { maxEngineRetries: 0 },
    workspace: readOnly ? { kind: 'readonly-ref', ref: 'review-ref' } : { kind: 'slot', slot: surface },
  };
}

function budgetFor(run: PhaseInputContext['run'], state: SupportedPhase): BudgetCounters {
  const record = run.budgets.find((budget) => budget.level === 'phase' && budget.scopeId === state);
  return record?.limit ?? {};
}

function contractFor(state: SupportedPhase): PhaseContract {
  return {
    id: state.toLowerCase(),
    version: 1,
    state,
    objectives: [OBJECTIVES[state]],
    resolveInputs(ctx) {
      if (ctx.phase.state !== state) return { ok: false, error: phaseError(ctx.phase.state) };
      return { ok: true, value: { phase: state, runId: ctx.run.run.runId, surfaces: surfacesOf(ctx) } };
    },
    planAgents(input: unknown, ctx): AgentPlan[] {
      const surfaces =
        input && typeof input === 'object' && 'surfaces' in input && Array.isArray(input.surfaces)
          ? input.surfaces.filter((surface): surface is string => typeof surface === 'string').sort()
          : surfacesOf(ctx);
      if (state === 'TEST' || state === 'PREFLIGHT' || state === 'SHIP') return [];
      const role = state === 'BUILD' ? 'implementer' : state === 'REVIEW' ? 'reviewer' : 'fixer';
      return surfaces.map((surface) => planFor(role, surface, state));
    },
    outputSchema: Type.Unknown(),
    checks: [],
    budget: (run) => budgetFor(run, state),
    stop: [],
    retry: RETRY,
    approvals: state === 'SHIP' ? [{ kind: 'ship', applies: () => true }] : [],
    assemble(_input: unknown, results: AgentResult[]) {
      if (state === 'REVIEW') {
        const findings = results.flatMap((result) => result.output?.findings ?? []);
        return { ok: true, value: { phase: state, results, review: calculateReview(findings, []) } };
      }
      return { ok: true, value: { phase: state, results } };
    },
  } as PhaseContract;
}

export function createPhaseContracts(_deps: PhasesContractsDeps): PhaseContractRegistry {
  const contracts = new Map<SupportedPhase, PhaseContract>(
    SUPPORTED_PHASES.map((state) => [state, contractFor(state)]),
  );
  return {
    get: (state) =>
      SUPPORTED_PHASES.includes(state as SupportedPhase) ? contracts.get(state as SupportedPhase) : undefined,
  };
}

// Keep this assertion close to the registry so adding a new active state forces an explicit decision here.
const _supportedStatesAreKnown: readonly ActivePipelineState[] = SUPPORTED_PHASES;
void _supportedStatesAreKnown;
