import type { AuthMode, JsonValue } from '@cohorte/base';
import type { AgentRef, EphemeralEventType, EventType, PhaseRef } from '@cohorte/protocol';
import type { EphemeralRuntimeEvent, RuntimeEvent, RuntimeEventType } from '@cohorte/runtime-contract';
import type { EphemeralInput, EventDraftInput } from '../../contract/types.ts';

export interface RuntimeEventMapperContext {
  agent?: AgentRef;
  phase?: PhaseRef;
  expectedAuthMode?: AuthMode;
  monetaryCost?: JsonValue;
}

export type MappedRuntimeEvent =
  | { durability: 'durable'; draft: EventDraftInput }
  | { durability: 'ephemeral'; draft: EphemeralInput };

const asJson = (value: unknown): JsonValue => value as JsonValue;

function defaultAgent(event: RuntimeEvent): AgentRef {
  return {
    agentId: event.agentId,
    role: 'unknown',
    incarnation: event.incarnation,
    attempt: 1,
  };
}

function common(event: RuntimeEvent, context: RuntimeEventMapperContext): Pick<EventDraftInput, 'phase' | 'agent'> {
  return {
    ...(context.phase === undefined ? {} : { phase: context.phase }),
    agent: context.agent ?? defaultAgent(event),
  };
}

function durable<T extends EventType>(
  event: RuntimeEvent,
  type: T,
  payload: JsonValue,
  context: RuntimeEventMapperContext,
): MappedRuntimeEvent {
  return {
    durability: 'durable',
    draft: {
      type,
      payload,
      source: 'runtime',
      summary: type,
      ...common(event, context),
    },
  };
}

function ephemeral<T extends EphemeralEventType>(
  event: EphemeralRuntimeEvent,
  type: T,
  payload: JsonValue,
  context: RuntimeEventMapperContext,
): MappedRuntimeEvent {
  return {
    durability: 'ephemeral',
    draft: {
      type: type as EphemeralInput['type'],
      payload,
      source: 'runtime',
      severity: 'progress',
      ...(context.phase === undefined ? {} : { phase: context.phase }),
      agent: context.agent ?? defaultAgent(event),
    },
  };
}

/** Maps one runtime event. `agent.exited` is intentionally left to the supervisor because it needs the accepted
 * structured result to choose `agent.completed` versus `agent.failed`. `tool.call.delivered` is folded into the
 * tool completion by the host and therefore never becomes a second durable event. */
export function mapRuntimeEvent(
  event: RuntimeEvent,
  context: RuntimeEventMapperContext = {},
): MappedRuntimeEvent | null {
  switch (event.type) {
    case 'agent.spawned':
      return durable(
        event,
        'agent.spawned',
        asJson({
          agent: context.agent ?? defaultAgent(event),
          tools: event.data.tools,
          systemPromptSha256: event.data.systemPromptSha256,
          effectiveSystemPromptSha256: event.data.effectiveSystemPromptSha256,
          authMode: context.expectedAuthMode ?? 'subscription',
          isolation: {
            level: event.data.isolation.level === 'os' ? 'L1-os' : 'L0-process',
            backend:
              event.data.isolation.backend === 'seatbelt' || event.data.isolation.backend === 'bubblewrap'
                ? event.data.isolation.backend
                : 'none',
            filesystem: event.data.isolation.filesystem === 'enforced' ? 'enforced' : 'advisory',
            network: event.data.isolation.network === 'enforced' ? 'enforced-off' : 'unenforced',
          },
        }),
        context,
      );
    case 'agent.started':
      return durable(
        event,
        'agent.started',
        asJson({ agent: context.agent ?? defaultAgent(event), taskSha256: event.data.taskSha256 }),
        context,
      );
    case 'agent.turn.started':
      return ephemeral(event, 'agent.turn.started', asJson(event.data), context);
    case 'agent.turn.completed':
      return durable(event, 'agent.turn.completed', asJson(event.data), context);
    case 'agent.message.started':
      return ephemeral(event, 'agent.message.started', asJson(event.data), context);
    case 'agent.message.delta':
      return ephemeral(event, 'agent.message.delta', asJson(event.data), context);
    case 'agent.message.completed': {
      const { textBytes, ...data } = event.data;
      return durable(event, 'agent.message.completed', asJson({ ...data, bytes: textBytes }), context);
    }
    case 'agent.message.accepted':
      return durable(
        event,
        'agent.message.accepted',
        asJson({ agent: context.agent ?? defaultAgent(event), ...event.data }),
        context,
      );
    case 'model.requested':
      return durable(
        event,
        'model.requested',
        asJson({ ...event.data, expectedAuthMode: context.expectedAuthMode ?? 'subscription' }),
        context,
      );
    case 'model.responded':
      return durable(
        event,
        'model.responded',
        asJson({
          requestId: event.data.requestId,
          requestedModel: event.data.requestedModel,
          effectiveModel: event.data.effectiveModel,
          authMode: event.data.authMode,
          authSource: event.data.authSource,
          status: event.data.error === undefined ? 'ok' : 'error',
          ...(event.data.httpStatus === undefined ? {} : { httpStatus: event.data.httpStatus }),
          durationMs: event.data.durationMs,
          tokens: event.data.usage,
          monetaryCost: context.monetaryCost ?? 'not_applicable',
          quota: event.data.quota,
          attempt: event.data.attempt,
          ...(event.data.error === undefined ? {} : { error: event.data.error }),
        }),
        context,
      );
    case 'tool.call.rejected':
      return durable(event, 'tool.rejected', asJson(event.data), context);
    case 'tool.call.progress':
      return ephemeral(
        event,
        'tool.progress',
        asJson({ toolCallId: event.data.toolCallId, ...event.data.update }),
        context,
      );
    case 'tool.call.requested':
    case 'tool.call.delivered':
    case 'agent.exited':
      return null;
    case 'agent.paused':
      return durable(
        event,
        'agent.state.changed',
        asJson({
          agent: context.agent ?? defaultAgent(event),
          from: 'running',
          to: 'paused',
          reason: 'paused',
          pausedAt: event.data.at,
          attemptConsumed: false,
        }),
        context,
      );
    case 'agent.resumed':
      return durable(
        event,
        'agent.state.changed',
        asJson({
          agent: context.agent ?? defaultAgent(event),
          from: 'paused',
          to: 'running',
          reason: 'resumed',
          attemptConsumed: false,
        }),
        context,
      );
    case 'runtime.warning':
      return durable(
        event,
        'runtime.warning',
        asJson({ agent: context.agent ?? defaultAgent(event), ...event.data }),
        context,
      );
  }
}

export function runtimeEventTypesHandledByMapper(): readonly RuntimeEventType[] {
  return [
    'agent.spawned',
    'agent.started',
    'agent.turn.started',
    'agent.turn.completed',
    'agent.message.started',
    'agent.message.delta',
    'agent.message.completed',
    'agent.message.accepted',
    'model.requested',
    'model.responded',
    'tool.call.rejected',
    'tool.call.progress',
    'agent.paused',
    'agent.resumed',
    'runtime.warning',
  ];
}
