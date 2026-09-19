// DESIGN 2.2.5 — RuntimeEvent: "Pi-shaped, not Pi-typed". Durability is part of the type (C5).
import {
  AgentId,
  AuthMode,
  ErrorInfo,
  IsoInstant,
  ModelRef,
  QuotaInfo,
  RunId,
  Sha256,
  TokenUsage,
  ToolCallId,
} from '@cohorte/base';
import { type Static, type TSchema, type TUnsafe, Type } from 'typebox';
import { AgentExit, EffectiveModel, RuntimeSessionRef } from './session.ts';
import { RuntimeToolCall, ToolProgress } from './tools.ts';

const strict = { additionalProperties: false } as const;
const count = () => Type.Integer({ minimum: 0 });
const boundary = () => Type.Union([Type.Literal('tool-boundary'), Type.Literal('model-boundary')]);
const delivery = () => Type.Union([Type.Literal('steer'), Type.Literal('follow-up')]);
const messageRole = () => Type.Union([Type.Literal('assistant'), Type.Literal('user'), Type.Literal('tool-result')]);

/**
 * A CLOSED five-value set on this frontier: an adapter maps any other engine stop reason (Pi 0.85.1 also has
 * 'pending' and 'deferred') to 'error' and emits runtime.warning{code: ENGINE_STOP_REASON_UNMAPPED}.
 */
export const ModelStop = Type.Union([
  Type.Literal('stop'),
  Type.Literal('length'),
  Type.Literal('tool-use'),
  Type.Literal('error'),
  Type.Literal('aborted'),
]);
export type ModelStop = Static<typeof ModelStop>;
export const ENGINE_STOP_REASON_UNMAPPED = 'engine-stop-reason-unmapped';

export const PREVIEW_MAX_LENGTH = 512;

export const IsolationReport = Type.Object(
  {
    level: Type.Union([Type.Literal('os'), Type.Literal('process'), Type.Literal('none')]),
    filesystem: Type.Union([Type.Literal('enforced'), Type.Literal('advisory')]),
    network: Type.Union([Type.Literal('enforced'), Type.Literal('partial'), Type.Literal('none')]),
    backend: Type.String(),
  },
  strict,
);
export type IsolationReport = Static<typeof IsolationReport>;

const durable = <P extends TSchema>(data: P) => ({ durability: 'durable', data }) as const;
const ephemeral = <P extends TSchema>(data: P) => ({ durability: 'ephemeral', data }) as const;

/**
 * One row per event type: its durability and the schema of `data`. EVERY durable type has a named target in the
 * protocol catalogue, or an explicit "not forwarded" rule (DESIGN 2.3.3). `authSource: 'none'` exists only for
 * runtimes that hold no credential (the fake); a fake run reports the authMode its plan requested.
 */
export const RUNTIME_EVENT_TYPES = {
  'agent.spawned': durable(
    Type.Object(
      {
        session: RuntimeSessionRef,
        requestedModel: ModelRef,
        tools: Type.Array(Type.String()),
        systemPromptSha256: Sha256,
        effectiveSystemPromptSha256: Sha256,
        isolation: IsolationReport,
      },
      strict,
    ),
  ),
  'agent.started': durable(Type.Object({ taskSha256: Sha256 }, strict)),
  'agent.turn.started': ephemeral(Type.Object({ turn: count() }, strict)),
  'agent.turn.completed': durable(Type.Object({ turn: count(), toolCalls: count() }, strict)),
  'agent.message.started': ephemeral(Type.Object({ messageId: Type.String(), role: messageRole() }, strict)),
  'agent.message.delta': ephemeral(
    Type.Object(
      {
        messageId: Type.String(),
        channel: Type.Union([Type.Literal('text'), Type.Literal('thinking'), Type.Literal('tool-input')]),
        contentIndex: count(),
        delta: Type.String(),
      },
      strict,
    ),
  ),
  'agent.message.completed': durable(
    Type.Object(
      {
        messageId: Type.String(),
        role: messageRole(),
        textSha256: Sha256,
        textBytes: count(),
        preview: Type.String({ maxLength: PREVIEW_MAX_LENGTH }),
        stop: Type.Optional(ModelStop),
      },
      strict,
    ),
  ),
  'model.requested': durable(
    Type.Object(
      {
        requestId: Type.String(),
        model: ModelRef,
        contextSha256: Type.Optional(Sha256),
        contextTokensEstimate: Type.Optional(count()),
        attempt: Type.Integer({ minimum: 1 }),
      },
      strict,
    ),
  ),
  'model.responded': durable(
    Type.Object(
      {
        requestId: Type.String(),
        requestedModel: ModelRef,
        effectiveModel: EffectiveModel,
        authMode: AuthMode,
        authSource: Type.Union([Type.Literal('oauth'), Type.Literal('api-key'), Type.Literal('none')]),
        durationMs: Type.Number({ minimum: 0 }),
        usage: TokenUsage,
        httpStatus: Type.Optional(Type.Integer()),
        attempt: Type.Integer({ minimum: 1 }),
        stop: ModelStop,
        quota: QuotaInfo,
        error: Type.Optional(ErrorInfo),
      },
      strict,
    ),
  ),
  // model asked; nothing ran yet; ToolHost WILL be called
  'tool.call.requested': durable(Type.Object({ call: RuntimeToolCall }, strict)),
  // engine refused BEFORE the host: ToolHost is NOT called [X]
  'tool.call.rejected': durable(
    Type.Object(
      {
        engineToolCallId: Type.Optional(Type.String()),
        tool: Type.String(),
        cause: Type.Union([
          Type.Literal('unknown-tool'),
          Type.Literal('invalid-input'),
          Type.Literal('output-truncated'),
        ]),
        message: Type.String(),
      },
      strict,
    ),
  ),
  'tool.call.progress': ephemeral(Type.Object({ toolCallId: ToolCallId, update: ToolProgress }, strict)),
  'tool.call.delivered': durable(
    Type.Object(
      {
        toolCallId: ToolCallId,
        isError: Type.Boolean(),
        terminate: Type.Boolean(),
        waitedMs: Type.Number({ minimum: 0 }),
      },
      strict,
    ),
  ),
  'agent.paused': durable(Type.Object({ at: boundary() }, strict)),
  'agent.resumed': durable(Type.Unsafe<Record<string, never>>(Type.Object({}, strict))),
  'agent.message.accepted': durable(Type.Object({ messageId: Type.String(), delivery: delivery() }, strict)),
  'agent.exited': durable(AgentExit),
  'runtime.warning': durable(Type.Object({ code: Type.String(), message: Type.String() }, strict)),
} as const;

type EventTable = typeof RUNTIME_EVENT_TYPES;
export type RuntimeEventType = keyof EventTable;

interface Ev<T extends string, D extends 'durable' | 'ephemeral', P> {
  type: T;
  durability: D;
  runId: RunId;
  agentId: AgentId;
  incarnation: number;
  /** per incarnation, strictly increasing over BOTH durabilities */
  seq: number;
  at: IsoInstant;
  data: P;
}

/** Discriminated on `type`. */
export type RuntimeEvent = {
  [T in RuntimeEventType]: Ev<T, EventTable[T]['durability'], Static<EventTable[T]['data']>>;
}[RuntimeEventType];
export type RuntimeEventOf<T extends RuntimeEventType> = Extract<RuntimeEvent, { type: T }>;
export type DurableRuntimeEvent = Extract<RuntimeEvent, { durability: 'durable' }>;
export type EphemeralRuntimeEvent = Extract<RuntimeEvent, { durability: 'ephemeral' }>;

export const RUNTIME_EVENT_TYPE_NAMES = Object.freeze(Object.keys(RUNTIME_EVENT_TYPES)) as readonly RuntimeEventType[];

const envelope = {
  runId: RunId,
  agentId: AgentId,
  incarnation: Type.Integer({ minimum: 1 }),
  seq: count(),
  at: IsoInstant,
};

// The annotation is deliberate: the union is assembled from the table, so there is nothing to infer from.
export const RuntimeEvent: TUnsafe<RuntimeEvent> = Type.Unsafe<RuntimeEvent>(
  Type.Union(
    RUNTIME_EVENT_TYPE_NAMES.map((type) => {
      const row = RUNTIME_EVENT_TYPES[type];
      return Type.Object(
        { type: Type.Literal(type), durability: Type.Literal(row.durability), ...envelope, data: row.data },
        strict,
      );
    }),
  ),
);

export const isDurable = (event: RuntimeEvent): event is DurableRuntimeEvent => event.durability === 'durable';
