import type { AgentId, IsoInstant, RunId, Sha256, ToolCallId } from '@cohorte/base';
import type { AgentOutput } from '@cohorte/protocol';
import type { AgentRuntime, RuntimeEvent, RuntimeEventType, SpawnRequest } from '@cohorte/runtime-contract';
import { describe, expect, it } from 'vitest';
import { createAgentSupervisorImpl } from '../../src/agents/supervisor/implementation.ts';
import { mapRuntimeEvent, runtimeEventTypesHandledByMapper } from '../../src/agents/supervisor/map.ts';

const runId = 'run_0123456789abcdef0123456789abcdef' as RunId;
const agentId = 'agt_implementer_api' as AgentId;
const at = '2026-01-01T00:00:00.000Z' as IsoInstant;
const hash = 'a'.repeat(64) as Sha256;

const event = <T extends RuntimeEventType>(type: T, data: RuntimeEvent['data']): RuntimeEvent =>
  ({
    type,
    durability:
      type === 'agent.turn.started' ||
      type === 'agent.message.started' ||
      type === 'agent.message.delta' ||
      type === 'tool.call.progress'
        ? 'ephemeral'
        : 'durable',
    runId,
    agentId,
    incarnation: 1,
    seq: 1,
    at,
    data,
  }) as RuntimeEvent;

describe('runtime event mapper', () => {
  it('maps runtime diagnostics and preserves the runtime source', () => {
    const mapped = mapRuntimeEvent(event('runtime.warning', { code: 'degraded', message: 'sandbox fallback' }));
    expect(mapped).toMatchObject({
      durability: 'durable',
      draft: {
        type: 'runtime.warning',
        source: 'runtime',
        payload: { code: 'degraded', message: 'sandbox fallback' },
      },
    });
  });

  it('maps ephemeral progress and deliberately drops supervisor-owned exit/delivery events', () => {
    const progress = mapRuntimeEvent(
      event('tool.call.progress', { toolCallId: 'tc_1_1' as ToolCallId, update: { text: 'reading' } }),
    );
    expect(progress).toMatchObject({
      durability: 'ephemeral',
      draft: { type: 'tool.progress', payload: { text: 'reading' } },
    });
    expect(
      mapRuntimeEvent(
        event('agent.exited', {
          outcome: 'completed',
          stop: 'model-stop',
          usage: {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            modelRequests: 0,
            toolCalls: 0,
            turns: 0,
            wallClockMs: 0,
          },
          lastSeq: 1,
        }),
      ),
    ).toBeNull();
    expect(
      mapRuntimeEvent(
        event('tool.call.delivered', {
          toolCallId: 'tc_1_1' as ToolCallId,
          isError: false,
          terminate: false,
          waitedMs: 3,
        }),
      ),
    ).toBeNull();
  });

  it('keeps the mapper inventory explicit and stable', () => {
    expect(runtimeEventTypesHandledByMapper()).toHaveLength(15);
    expect(new Set(runtimeEventTypesHandledByMapper()).size).toBe(15);
    expect(
      mapRuntimeEvent(
        event('agent.message.completed', {
          messageId: 'm1',
          role: 'assistant',
          textSha256: hash,
          textBytes: 4,
          preview: 'done',
        }),
      ),
    ).toMatchObject({ draft: { type: 'agent.message.completed', payload: { bytes: 4 } } });
  });

  it('spawns plans through the injected runtime and respects the result boundary', async () => {
    let spawned = 0;
    const runtime = {
      spawn: async (_request: SpawnRequest) => {
        spawned += 1;
        return {
          exit: Promise.resolve({
            outcome: 'completed',
            stop: 'model-stop',
            usage: {
              tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
              modelRequests: 1,
              toolCalls: 0,
              turns: 1,
              wallClockMs: 1,
            },
            lastSeq: 1,
          }),
        };
      },
      subscribe: () => () => {},
    } as unknown as AgentRuntime;
    const supervisor = createAgentSupervisorImpl({
      runtimeProvider: {} as never,
      events: {} as never,
      clock: {} as never,
      ids: {} as never,
      runtime,
      requestFor: () => ({}) as SpawnRequest,
    });
    const results = await supervisor.runAgents(
      [{ agentId, task: { role: 'implementer' }, surface: undefined } as never],
      {} as never,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe('completed');
    expect(spawned).toBe(1);
  });

  it('attaches the host-accepted structured output to the agent result', async () => {
    const output: AgentOutput = {
      status: 'completed',
      summary: 'reviewed',
      artifacts: [],
      findings: [],
      checks: [],
      questions: [],
      confidence: 1,
    };
    const runtime = {
      spawn: async (_request: SpawnRequest) => ({
        exit: Promise.resolve({
          outcome: 'completed',
          stop: 'model-stop',
          usage: {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            modelRequests: 0,
            toolCalls: 1,
            turns: 1,
            wallClockMs: 0,
          },
          lastSeq: 1,
        }),
      }),
      subscribe: () => () => {},
    } as unknown as AgentRuntime;
    const supervisor = createAgentSupervisorImpl({
      runtimeProvider: {} as never,
      events: {} as never,
      clock: {} as never,
      ids: {} as never,
      runtime,
      requestFor: () => ({}) as SpawnRequest,
      outputFor: (id) => (id === agentId ? output : undefined),
    });
    const results = await supervisor.runAgents(
      [{ agentId, task: { role: 'reviewer' }, surface: undefined } as never],
      {} as never,
    );
    expect(results[0]?.output).toEqual(output);
  });
});
