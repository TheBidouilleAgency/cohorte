// The smallest honest AgentRuntime: an in-process "model" that replays a BrainScript. It proves that the
// conformance suite RUNS, and — through `mutations` — that each rule has teeth. Not collected (no test suffix).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CohorteError, errorOf, type Sha256, type ToolCallId } from '@cohorte/base';
import type { AgentKey, BrainScript, ModelInput, ModelInputMessage } from '../../src/conformance/index.ts';
import type {
  AgentExit,
  AgentRuntime,
  AgentStopCause,
  RuntimeAgentHandle,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeHostBindings,
  RuntimeSnapshot,
  RuntimeToolResult,
  SpawnRequest,
  TaskInput,
  UsageTotals,
} from '../../src/index.ts';

export const ECHO_BASE_URL = 'https://conformance.invalid/v1';

/** One deliberate defect each; the teeth test expects exactly one rule to catch it. */
export interface EchoMutations {
  skipHandlerForOrdinal?: number;
  repeatSeqOnce?: boolean;
  acceptDuplicateIncarnation?: boolean;
  ignoreAssetHashes?: boolean;
  leakTimerOnClose?: boolean;
  note?: 'before-task' | 'dropped' | 'appended-bare';
}

export interface EchoRuntime extends AgentRuntime {
  modelInputs(agent: AgentKey): ModelInput[];
  /** Clears what `leakTimerOnClose` left behind, so that the mutant does not outlive its test. */
  stopLeaks(): void;
}

const yes = { value: 'yes' } as const;
const no = (why: string) => ({ value: 'no', why }) as const;
const CAPABILITIES: RuntimeCapabilities = {
  contractVersion: '1',
  toolExecution: 'host-delegated',
  streaming: no('whole messages only'),
  thinkingStream: no('no thinking'),
  send: { steer: no('not scripted'), followUp: yes },
  cancelCooperative: yes,
  cancelHard: no('in-process'),
  pause: { toolBoundary: yes, modelBoundary: yes },
  continuationFromTranscript: no('no transcript'),
  processIsolation: no('in-process'),
  envFiltering: no('in-process'),
  brainSandbox: no('in-process'),
  resourceLimits: no('in-process'),
  budgetEnforcement: {
    turns: yes,
    modelRequests: yes,
    tokens: no('no tokens'),
    context: no('no tokens'),
    wallClock: no('no timers'),
    outputTokensPerRequest: no('no tokens'),
  },
  hiddenModelCalls: no('every request is scripted'),
  usageReporting: no('no tokens'),
  effectiveModelReporting: yes,
  quotaReporting: no('no provider'),
  authStatusWithoutSecret: yes,
  subscriptionModeAssertion: no('no provider'),
  systemPromptExact: yes,
  runtimePinning: no('test double'),
  platforms: { darwin: yes, linux: yes, win32: yes },
  hints: { memoryPerAgentMb: 1, coldStartMs: 0, maxConcurrentAgents: 64 },
};

const sha256 = (text: string): Sha256 => createHash('sha256').update(text, 'utf8').digest('hex') as Sha256;
const keyOf = (agent: AgentKey): string => `${agent.runId}/${agent.agentId}/${agent.incarnation}`;

interface Agent {
  request: SpawnRequest;
  seq: number;
  turn: number;
  modelRequests: number;
  toolCalls: number;
  cancelled: boolean;
  exited: boolean;
  resumed: Promise<void> | null;
  resume: () => void;
  pending: Map<ToolCallId, AbortController>;
  session: RuntimeAgentHandle['session'];
}

export function createEchoRuntime(
  bindings: RuntimeHostBindings,
  script: BrainScript,
  mutations: EchoMutations = {},
): EchoRuntime {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const agents = new Map<string, Agent>();
  const incarnations = new Set<string>();
  const inputs = new Map<string, ModelInput[]>();
  const exits: Promise<void>[] = [];
  const leaks: ReturnType<typeof setInterval>[] = [];
  let seqRepeated = false;

  const emit = <E extends RuntimeEvent>(
    agent: Agent,
    type: E['type'],
    durability: E['durability'],
    data: E['data'],
  ): number => {
    const repeat = mutations.repeatSeqOnce === true && !seqRepeated && type === 'model.responded';
    if (repeat) seqRepeated = true;
    else agent.seq += 1;
    const { runId, agentId, incarnation } = agent.request;
    const event = {
      type,
      durability,
      runId,
      agentId,
      incarnation,
      seq: agent.seq,
      at: bindings.clock.now(),
      data,
    } as RuntimeEvent;
    for (const listener of listeners) listener(event);
    return agent.seq;
  };

  const readVerified = (ref: TaskInput): string => {
    const text = readFileSync(ref.path, 'utf8');
    if (!mutations.ignoreAssetHashes && sha256(text) !== ref.sha256)
      throw new CohorteError(
        errorOf('security/asset-hash-mismatch', `the content of ${ref.path} does not match its reference`),
      );
    return text;
  };

  const usageOf = (agent: Agent): UsageTotals => ({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    modelRequests: agent.modelRequests,
    toolCalls: agent.toolCalls,
    turns: agent.turn,
    wallClockMs: 0,
  });

  async function run(agent: Agent, systemPrompt: string, task: string, note: string | null): Promise<AgentExit> {
    const { request } = agent;
    const opening: ModelInputMessage[] = [{ role: 'user', text: task }];
    if (note !== null && mutations.note !== 'dropped') {
      if (mutations.note === 'before-task') opening.unshift({ role: 'user', text: note });
      else if (mutations.note === 'appended-bare') opening[0] = { role: 'user', text: `${task}\n\n${note}` };
      else opening.push({ role: 'user', text: note });
    }
    const messages = opening;
    const recorded: ModelInput[] = [];
    inputs.set(keyOf(request), recorded);
    const finish = (outcome: AgentExit['outcome'], stop: AgentStopCause): AgentExit => {
      const exit: AgentExit = { outcome, stop, usage: usageOf(agent), lastSeq: agent.seq + 1 };
      agent.exited = true;
      emit(agent, 'agent.exited', 'durable', exit);
      return exit;
    };

    emit(agent, 'agent.started', 'durable', { taskSha256: request.task.sha256 });
    for (;;) {
      if (agent.resumed) await agent.resumed;
      if (agent.cancelled) return finish('cancelled', 'cancelled');
      if (request.budget.maxModelRequests !== undefined && agent.modelRequests >= request.budget.maxModelRequests)
        return finish('completed', 'budget');

      agent.modelRequests += 1;
      const requestId = `req_${agent.modelRequests}`;
      emit(agent, 'model.requested', 'durable', { requestId, model: request.model, attempt: 1 });
      recorded.push({ systemPrompt, messages: messages.map((message) => ({ ...message })) });
      const turn = script.turns[agent.modelRequests - 1] ?? {};
      const calls = turn.toolCalls ?? [];
      emit(agent, 'model.responded', 'durable', {
        requestId,
        requestedModel: request.model,
        effectiveModel: { provider: request.model.provider, model: request.model.model, baseUrl: ECHO_BASE_URL },
        authMode: request.auth.mode,
        authSource: 'none',
        durationMs: 0,
        usage: usageOf(agent).tokens,
        attempt: 1,
        stop: calls.length > 0 ? 'tool-use' : 'stop',
        quota: { known: false },
      });
      const text = turn.text ?? '';
      messages.push({ role: 'assistant', text });
      emit(agent, 'agent.message.completed', 'durable', {
        messageId: `msg_${agent.modelRequests}`,
        role: 'assistant',
        textSha256: sha256(text),
        textBytes: Buffer.byteLength(text),
        preview: text.slice(0, 512),
        stop: calls.length > 0 ? 'tool-use' : 'stop',
      });

      for (const { tool, input } of calls) {
        if (!request.tools.some((grant) => grant.tool === tool)) {
          emit(agent, 'tool.call.rejected', 'durable', {
            tool,
            cause: 'unknown-tool',
            message: `Tool ${tool} not found`,
          });
          messages.push({ role: 'tool-result', text: `Tool ${tool} not found` });
          continue;
        }
        agent.toolCalls += 1;
        const ordinal = agent.toolCalls;
        const toolCallId = `tc_${request.incarnation}_${ordinal}` as ToolCallId;
        const { runId, agentId, incarnation } = request;
        const call = { runId, agentId, incarnation, toolCallId, ordinal, tool, input };
        emit(agent, 'tool.call.requested', 'durable', { call });
        if (agent.resumed) await agent.resumed;
        if (agent.cancelled) break;
        const controller = new AbortController();
        agent.pending.set(toolCallId, controller);
        let result: RuntimeToolResult = { isError: false, content: [] };
        if (mutations.skipHandlerForOrdinal !== ordinal)
          result = await bindings.toolHost.handleToolCall(call, { signal: controller.signal, progress: () => {} });
        agent.pending.delete(toolCallId);
        emit(agent, 'tool.call.delivered', 'durable', {
          toolCallId,
          isError: result.isError,
          terminate: result.terminate === true,
          waitedMs: 0,
        });
        const delivered = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
        messages.push({ role: 'tool-result', text: delivered });
        if (agent.cancelled) break;
      }

      if (agent.cancelled) return finish('cancelled', 'cancelled');
      agent.turn += 1;
      emit(agent, 'agent.turn.completed', 'durable', { turn: agent.turn, toolCalls: calls.length });
      if (calls.length === 0) return finish('completed', 'model-stop');
      if (request.budget.maxTurns !== undefined && agent.turn >= request.budget.maxTurns)
        return finish('completed', 'budget');
    }
  }

  const live = (agentId: string): Agent => {
    const found = [...agents.values()].find((agent) => agent.request.agentId === agentId && !agent.exited);
    if (!found) throw new CohorteError(errorOf('validation/unexpected', `no live agent ${agentId}`));
    return found;
  };

  const cancelAgent = (agent: Agent): void => {
    agent.cancelled = true;
    for (const controller of agent.pending.values()) controller.abort();
    agent.resume();
  };

  return {
    id: 'echo',
    version: '0.0.0+echo.1',
    capabilities: () => structuredClone(CAPABILITIES),

    async spawn(request) {
      const key = keyOf(request);
      if (incarnations.has(key) && !mutations.acceptDuplicateIncarnation)
        throw new CohorteError(errorOf('conflict/incarnation-exists', `${key} was already spawned`));
      if (request.auth.baseUrl !== ECHO_BASE_URL)
        throw new CohorteError(
          errorOf('security/auth-endpoint-mismatch', 'the echo runtime only talks to its own endpoint'),
        );
      const systemPrompt = readVerified(request.systemPrompt);
      const task = readVerified(request.task);
      const note = request.continuation ? readVerified(request.continuation.note) : null;
      incarnations.add(key);

      const stateDir = bindings.stateDir(request.runId, request.agentId, request.incarnation);
      const session = {
        runtime: 'echo',
        engineVersion: '1',
        sessionId: bindings.ids.next<'SessionId'>('ses'),
        transcript: { path: join(stateDir, 'transcript.ndjson'), format: 'echo-ndjson-v1' },
      };
      const agent: Agent = {
        request,
        seq: 0,
        turn: 0,
        modelRequests: 0,
        toolCalls: 0,
        cancelled: false,
        exited: false,
        resumed: null,
        resume: () => {},
        pending: new Map(),
        session,
      };
      agents.set(key, agent);
      emit(agent, 'agent.spawned', 'durable', {
        session,
        requestedModel: request.model,
        tools: request.tools.map((grant) => grant.tool),
        systemPromptSha256: request.systemPrompt.sha256,
        effectiveSystemPromptSha256: sha256(systemPrompt),
        isolation: { level: 'none', filesystem: 'advisory', network: 'none', backend: 'in-process' },
      });
      // A macrotask-free hop: the caller gets its handle before the first model request.
      const exit = Promise.resolve().then(() => run(agent, systemPrompt, task, note));
      exits.push(exit.then(() => undefined));
      const { runId, agentId, incarnation } = request;
      return { runId, agentId, incarnation, session, startedAt: bindings.clock.now(), process: null, exit };
    },

    async send(agentId, message) {
      emit(live(agentId), 'agent.message.accepted', 'durable', {
        messageId: message.messageId,
        delivery: message.delivery,
      });
    },

    async cancel(agentId) {
      cancelAgent(live(agentId));
    },

    async pause(agentId) {
      const agent = live(agentId);
      if (agent.resumed) return;
      agent.resumed = new Promise((resolve) => {
        agent.resume = resolve;
      });
      emit(agent, 'agent.paused', 'durable', { at: agent.pending.size > 0 ? 'tool-boundary' : 'model-boundary' });
    },

    async resume(agentId) {
      const agent = live(agentId);
      if (!agent.resumed) return;
      agent.resumed = null;
      emit(agent, 'agent.resumed', 'durable', {});
      agent.resume();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async inspect(agentId): Promise<RuntimeSnapshot> {
      const agent = [...agents.values()].findLast((candidate) => candidate.request.agentId === agentId);
      if (!agent) throw new CohorteError(errorOf('validation/unexpected', `no agent ${agentId}`));
      const { runId, incarnation, model } = agent.request;
      return {
        runId,
        agentId: agent.request.agentId,
        incarnation,
        state: agent.exited
          ? 'exited'
          : agent.resumed
            ? 'paused'
            : agent.pending.size > 0
              ? 'awaiting-tool'
              : 'running',
        turn: agent.turn,
        pendingToolCalls: [...agent.pending.keys()],
        requestedModel: model,
        usage: usageOf(agent),
        session: agent.session,
        lastSeq: agent.seq,
        diagnostics: {},
      };
    },

    async close() {
      for (const agent of agents.values()) if (!agent.exited) cancelAgent(agent);
      await Promise.all(exits);
      if (mutations.leakTimerOnClose) leaks.push(setInterval(() => {}, 60_000));
    },

    modelInputs: (agent) => inputs.get(keyOf(agent)) ?? [],
    stopLeaks: () => {
      for (const timer of leaks.splice(0)) clearInterval(timer);
    },
  };
}
