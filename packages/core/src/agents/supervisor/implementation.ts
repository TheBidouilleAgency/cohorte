import type { AgentId, Clock, IdSource } from '@cohorte/base';
import type { AgentOutput } from '@cohorte/protocol';
import type {
  AgentExit,
  AgentRuntime,
  AgentRuntimeProvider,
  RuntimeEvent,
  RuntimeHostBindings,
  SpawnRequest,
} from '@cohorte/runtime-contract';
import type { AgentSupervisor, EventWriter } from '../../contract/internal.ts';
import type { AgentPlan, AgentResult, PhaseRunContext } from '../../contract/types.ts';

export interface SupervisorImplementationDeps {
  runtimeProvider: AgentRuntimeProvider;
  events: EventWriter;
  clock: Clock;
  ids: IdSource;
  bindings?: RuntimeHostBindings;
  requestFor?: (plan: AgentPlan, ctx: PhaseRunContext, incarnation: number) => SpawnRequest | Promise<SpawnRequest>;
  runtime?: AgentRuntime;
  concurrency?: number;
  onRuntimeEvent?: (event: RuntimeEvent) => void | Promise<void>;
  outputFor?: (agentId: AgentId) => AgentOutput | undefined;
}

function resultFromExit(
  plan: AgentPlan,
  exit: AgentExit,
  incarnation: number,
  outputFor?: SupervisorImplementationDeps['outputFor'],
): AgentResult {
  const outcome = exit.outcome === 'completed' ? 'completed' : exit.outcome === 'cancelled' ? 'cancelled' : 'failed';
  const output = outputFor?.(plan.agentId);
  return {
    agent: {
      agentId: plan.agentId,
      role: plan.task.role,
      ...(plan.surface === undefined ? {} : { surface: plan.surface }),
      incarnation,
      attempt: 1,
    },
    outcome,
    ...(output === undefined ? {} : { output }),
    ...(exit.error === undefined ? {} : { error: exit.error }),
    artifacts: [],
    usage: {
      tokens: exit.usage.tokens.total,
      modelRequests: exit.usage.modelRequests,
      toolCalls: exit.usage.toolCalls,
      wallClockMs: exit.usage.wallClockMs,
    },
  };
}

async function runOne(
  runtime: AgentRuntime,
  plan: AgentPlan,
  ctx: PhaseRunContext,
  incarnation: number,
  requestFor: SupervisorImplementationDeps['requestFor'],
  outputFor: SupervisorImplementationDeps['outputFor'],
): Promise<AgentResult> {
  if (!requestFor) throw new Error(`configuration/supervisor-request-missing: ${plan.agentId}`);
  const request = await requestFor(plan, ctx, incarnation);
  const handle = await runtime.spawn(request);
  return resultFromExit(plan, await handle.exit, incarnation, outputFor);
}

function nextIncarnation(plan: AgentPlan, ctx: PhaseRunContext, seen: Map<AgentId, number>): number {
  const previous = (ctx.run?.agents ?? [])
    .filter((agent) => agent.agentId === plan.agentId)
    .reduce((highest, agent) => Math.max(highest, agent.incarnation), 0);
  return Math.max(previous, seen.get(plan.agentId) ?? 0) + 1;
}

export function createAgentSupervisorImpl(deps: SupervisorImplementationDeps): AgentSupervisor {
  if (!deps.runtime && !deps.bindings) throw new Error('configuration/supervisor-bindings-missing');
  let runtime = deps.runtime;
  let subscribedRuntime: AgentRuntime | undefined;
  const runtimeWrites: Promise<void>[] = [];
  const seenIncarnations = new Map<AgentId, number>();
  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? 3));
  return {
    async runAgents(plans, ctx) {
      runtime ??= await deps.runtimeProvider.create(
        deps.bindings as RuntimeHostBindings,
        await deps.runtimeProvider.pin(),
      );
      const activeRuntime = runtime;
      if (deps.onRuntimeEvent && subscribedRuntime !== activeRuntime) {
        subscribedRuntime = activeRuntime;
        activeRuntime.subscribe((event) => {
          const write = deps.onRuntimeEvent?.(event);
          if (write !== undefined) runtimeWrites.push(Promise.resolve(write));
        });
      }
      const results: AgentResult[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < plans.length) {
          const index = cursor++;
          const plan = plans[index];
          if (plan) {
            const incarnation = nextIncarnation(plan, ctx, seenIncarnations);
            seenIncarnations.set(plan.agentId, incarnation);
            results[index] = await runOne(activeRuntime, plan, ctx, incarnation, deps.requestFor, deps.outputFor);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, worker));
      const pendingRuntimeWrites = runtimeWrites.splice(0);
      await Promise.all(pendingRuntimeWrites);
      return results;
    },
  };
}
