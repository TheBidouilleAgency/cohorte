// DESIGN 2.2.4 — handle, messages, snapshot.
import {
  AgentId,
  AuthMode,
  ErrorInfo,
  type IsoInstant,
  type JsonValue,
  JsonValueSchema,
  ModelRef,
  RunId,
  TokenUsage,
  ToolCallId,
} from '@cohorte/base';
import { type Static, type TUnsafe, Type } from 'typebox';

const strict = { additionalProperties: false } as const;
const count = () => Type.Integer({ minimum: 0 });
// The explicit TUnsafe keeps Biome's type inference out of `Static<TRecord>`: it overflows its stack there and then
// exits 0, so the lint LOOKS green while nothing was checked (docs/v3/requests/U0.02.md R1, U0.03.md R1).
const jsonMap = (): TUnsafe<Record<string, JsonValue>> =>
  Type.Unsafe<Record<string, JsonValue>>(Type.Record(Type.String(), JsonValueSchema));

/** `format` is a label, e.g. 'jsonl-v3' | 'fake-ndjson-v1' — never interpreted by core */
export const TranscriptRef = Type.Object({ path: Type.String(), format: Type.String() }, strict);
export type TranscriptRef = Static<typeof TranscriptRef>;

/** R8: opaque to clients */
export const RuntimeSessionRef = Type.Object(
  { runtime: Type.String(), engineVersion: Type.String(), sessionId: Type.String(), transcript: TranscriptRef },
  strict,
);
export type RuntimeSessionRef = Static<typeof RuntimeSessionRef>;

export const UsageTotals = Type.Object(
  {
    tokens: TokenUsage,
    modelRequests: count(),
    toolCalls: count(),
    turns: count(),
    wallClockMs: Type.Number({ minimum: 0 }),
  },
  strict,
);
export type UsageTotals = Static<typeof UsageTotals>;

export const EffectiveModel = Type.Object(
  {
    provider: Type.String(),
    model: Type.String(),
    api: Type.Optional(Type.String()),
    baseUrl: Type.Optional(Type.String()),
  },
  strict,
);
export type EffectiveModel = Static<typeof EffectiveModel>;

/** The ADAPTER's typed cause, recorded by the host BEFORE it acts. The engine's own stop reason is never a discriminator [X]. */
export const AgentStopCause = Type.Union([
  Type.Literal('host-terminated'),
  Type.Literal('model-stop'),
  Type.Literal('output-truncated'),
  Type.Literal('budget'),
  Type.Literal('cancelled'),
  Type.Literal('engine-error'),
  Type.Literal('process-exit'),
]);
export type AgentStopCause = Static<typeof AgentStopCause>;

export const AgentExit = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('crashed'),
    ]),
    stop: AgentStopCause,
    error: Type.Optional(ErrorInfo),
    usage: UsageTotals,
    lastSeq: count(),
  },
  strict,
);
export type AgentExit = Static<typeof AgentExit>;

export interface RuntimeAgentHandle {
  readonly runId: RunId;
  readonly agentId: AgentId;
  readonly incarnation: number;
  readonly session: RuntimeSessionRef;
  readonly startedAt: IsoInstant;
  /** startToken = OS process start time: orphan kill never trusts a bare pid */
  readonly process: { pid: number; pgid: number; startToken: string } | null;
  /** settles exactly once, never rejects, only AFTER the final RuntimeEvent was delivered */
  readonly exit: Promise<AgentExit>;
}

const delivery = () => Type.Union([Type.Literal('steer'), Type.Literal('follow-up')]);

export const RuntimeMessage = Type.Union([
  Type.Object(
    { kind: Type.Literal('user'), messageId: Type.String(), text: Type.String(), delivery: delivery() },
    strict,
  ),
  // rendered as a user message prefixed "[cohorte]"
  Type.Object(
    { kind: Type.Literal('host-note'), messageId: Type.String(), text: Type.String(), delivery: delivery() },
    strict,
  ),
]);
export type RuntimeMessage = Static<typeof RuntimeMessage>;

export const RuntimeSnapshot = Type.Object(
  {
    runId: RunId,
    agentId: AgentId,
    incarnation: Type.Integer({ minimum: 1 }),
    state: Type.Union([
      Type.Literal('starting'),
      Type.Literal('running'),
      Type.Literal('awaiting-tool'),
      Type.Literal('paused'),
      Type.Literal('settling'),
      Type.Literal('exited'),
    ]),
    pausedAt: Type.Optional(Type.Union([Type.Literal('tool-boundary'), Type.Literal('model-boundary')])),
    turn: count(),
    pendingToolCalls: Type.Array(ToolCallId),
    requestedModel: ModelRef,
    effectiveModel: Type.Optional(EffectiveModel),
    authMode: Type.Optional(AuthMode),
    usage: UsageTotals,
    contextTokens: Type.Optional(count()),
    contextWindow: Type.Optional(count()),
    session: RuntimeSessionRef,
    lastSeq: count(),
    /** pid, rssMb, lastHeartbeatAt, engine flags… never secrets */
    diagnostics: jsonMap(),
  },
  strict,
);
export type RuntimeSnapshot = Static<typeof RuntimeSnapshot>;
