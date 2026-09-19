// DESIGN 2.2.6 — capabilities: honest, tri-state, doctor-reportable.
import { type Static, Type } from 'typebox';

const strict = { additionalProperties: false } as const;

export const Cap = Type.Union([
  Type.Object({ value: Type.Literal('yes') }, strict),
  Type.Object({ value: Type.Literal('no'), why: Type.String() }, strict),
  Type.Object({ value: Type.Literal('partial'), why: Type.String() }, strict),
]);
export type Cap = Static<typeof Cap>;

export const RuntimeCapabilities = Type.Object(
  {
    contractVersion: Type.Literal('1'),
    /** the only legal value (C1); present so conformance can assert it */
    toolExecution: Type.Literal('host-delegated'),
    streaming: Cap,
    thinkingStream: Cap,
    send: Type.Object({ steer: Cap, followUp: Cap }, strict),
    cancelCooperative: Cap,
    cancelHard: Cap,
    pause: Type.Object({ toolBoundary: Cap, modelBoundary: Cap }, strict),
    continuationFromTranscript: Cap,
    processIsolation: Cap,
    envFiltering: Cap,
    brainSandbox: Cap,
    resourceLimits: Cap,
    budgetEnforcement: Type.Object(
      { turns: Cap, modelRequests: Cap, tokens: Cap, context: Cap, wallClock: Cap, outputTokensPerRequest: Cap },
      strict,
    ),
    /** 'no' = none possible (compaction and engine retries off) */
    hiddenModelCalls: Cap,
    usageReporting: Cap,
    effectiveModelReporting: Cap,
    quotaReporting: Cap,
    authStatusWithoutSecret: Cap,
    subscriptionModeAssertion: Cap,
    systemPromptExact: Cap,
    runtimePinning: Cap,
    platforms: Type.Object({ darwin: Cap, linux: Cap, win32: Cap }, strict),
    hints: Type.Object(
      {
        memoryPerAgentMb: Type.Number({ minimum: 0 }),
        coldStartMs: Type.Number({ minimum: 0 }),
        maxConcurrentAgents: Type.Integer({ minimum: 1 }),
      },
      strict,
    ),
  },
  strict,
);
export type RuntimeCapabilities = Static<typeof RuntimeCapabilities>;
