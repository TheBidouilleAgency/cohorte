// DESIGN 2.2.2 — rule C1: tools are executed by the host, never by the runtime.
import { AgentId, type JsonValue, JsonValueSchema, RunId, type SealedText, ToolCallId } from '@cohorte/base';
import { type Static, type TUnsafe, Type } from 'typebox';

const strict = { additionalProperties: false } as const;

export interface ToolHost {
  /**
   * Called exactly once per model tool call, in emission order (ordinal), BEFORE any effect. MUST resolve (a rejection
   * is a host bug: the runtime treats it as isError + agent failure). MUST settle promptly after ctx.signal aborts.
   * MAY take hours (human decision).
   */
  handleToolCall(call: RuntimeToolCall, ctx: ToolCallContext): Promise<RuntimeToolResult>;
}

export const RuntimeToolCall = Type.Object(
  {
    runId: RunId,
    agentId: AgentId,
    incarnation: Type.Integer({ minimum: 1 }),
    /** tc_<incarnation>_<ordinal> */
    toolCallId: ToolCallId,
    /** the engine's own id, transcript correlation only */
    engineToolCallId: Type.Optional(Type.String()),
    /** 1-based, per incarnation, gapless */
    ordinal: Type.Integer({ minimum: 1 }),
    tool: Type.String(),
    /** as produced by the model after engine-side coercion; the host re-validates strictly */
    input: JsonValueSchema,
  },
  strict,
);
export type RuntimeToolCall = Static<typeof RuntimeToolCall>;

export interface ToolCallContext {
  signal: AbortSignal;
  progress(update: ToolProgress): void;
}

export const ToolProgress = Type.Object(
  { text: Type.Optional(Type.String()), bytes: Type.Optional(Type.Integer({ minimum: 0 })) },
  strict,
);
export type ToolProgress = Static<typeof ToolProgress>;

export const ToolContent = Type.Union([
  // The static type carries the seal; on a wire a sealed text is a string like any other.
  Type.Object({ type: Type.Literal('text'), text: Type.Unsafe<SealedText>(Type.String()) }, strict),
  Type.Object({ type: Type.Literal('image'), mediaType: Type.String(), dataBase64: Type.String() }, strict),
]);
export type ToolContent = Static<typeof ToolContent>;

/** content is SEALED: the engine transcript never holds an unredacted tool result (I7). */
export const RuntimeToolResult = Type.Object(
  {
    isError: Type.Boolean(),
    content: Type.Array(ToolContent),
    /** host asks the runtime to end the agent loop after this batch */
    terminate: Type.Optional(Type.Boolean()),
    /** opaque audit id, stored in the transcript */
    resultRef: Type.Optional(Type.String()),
  },
  strict,
);
export type RuntimeToolResult = Static<typeof RuntimeToolResult>;

export const TOOL_NAME_PATTERN = '^[a-z][a-z0-9_]{1,40}$';

/** Root keywords a provider would have to flatten or would refuse: a grant's schema is ONE flat top-level object. */
export const TOOL_INPUT_SCHEMA_FORBIDDEN_ROOT_KEYS = [
  '$ref',
  '$defs',
  'definitions',
  'oneOf',
  'anyOf',
  'allOf',
] as const;

/** JSON Schema 2020-12, ONE flat top-level object: no $ref/$defs/oneOf at root (provider flattening). */
export const ToolInputSchema: TUnsafe<JsonValue> = Type.Unsafe<JsonValue>(
  Type.Object(
    { type: Type.Literal('object'), properties: Type.Optional(Type.Record(Type.String(), JsonValueSchema)) },
    {
      additionalProperties: true,
      not: { anyOf: TOOL_INPUT_SCHEMA_FORBIDDEN_ROOT_KEYS.map((key) => ({ required: [key] })) },
    },
  ),
);

/** What the BRAIN needs to know. No paths, no commands: what a call may touch is decided host-side. */
export const ToolGrant = Type.Object(
  {
    /** TOOL_NAME_PATTERN; never differs only by case from another grant (see toolGrantProblems) */
    tool: Type.String({ pattern: TOOL_NAME_PATTERN }),
    description: Type.String(),
    inputSchema: ToolInputSchema,
    /** ordering hint only */
    effect: Type.Union([
      Type.Literal('read'),
      Type.Literal('write'),
      Type.Literal('execute'),
      Type.Literal('network'),
      Type.Literal('control'),
    ]),
    /** true for the result tool */
    terminal: Type.Boolean(),
  },
  strict,
);
export type ToolGrant = Static<typeof ToolGrant>;

/**
 * The rule a schema cannot say: inside ONE grant list no two names are equal, or differ only by case (providers
 * fold tool names). Works on unvalidated names too, which is why it re-checks the pattern. Empty = no problem.
 */
export function toolGrantProblems(grants: readonly Pick<ToolGrant, 'tool'>[]): string[] {
  const pattern = new RegExp(TOOL_NAME_PATTERN);
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const { tool } of grants) {
    if (!pattern.test(tool)) problems.push(`tool name ${JSON.stringify(tool)} does not match ${TOOL_NAME_PATTERN}`);
    const folded = tool.toLowerCase();
    const earlier = seen.get(folded);
    if (earlier === undefined) seen.set(folded, tool);
    else if (earlier === tool) problems.push(`tool ${JSON.stringify(tool)} is granted twice`);
    else problems.push(`tools ${JSON.stringify(earlier)} and ${JSON.stringify(tool)} differ only by case`);
  }
  return problems;
}
