import { type Static, Type } from 'typebox';
import { IsoInstant } from './ids.ts';

const count = () => Type.Integer({ minimum: 0 });

export const TokenUsage = Type.Object(
  {
    input: count(),
    output: count(),
    cacheRead: count(),
    cacheWrite: count(),
    total: count(),
  },
  { additionalProperties: false },
);
export type TokenUsage = Static<typeof TokenUsage>;

export const QuotaWindow = Type.Object(
  {
    name: Type.String(),
    usedPercent: Type.Optional(Type.Number({ minimum: 0 })),
    resetsAt: Type.Optional(IsoInstant),
    limitLabel: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type QuotaWindow = Static<typeof QuotaWindow>;

export const QuotaInfo = Type.Union([
  Type.Object({ known: Type.Literal(false) }, { additionalProperties: false }),
  Type.Object(
    {
      known: Type.Literal(true),
      source: Type.Union([Type.Literal('response-headers'), Type.Literal('error')]),
      provider: Type.String(),
      windows: Type.Array(QuotaWindow),
      observedAt: IsoInstant,
    },
    { additionalProperties: false },
  ),
]);
export type QuotaInfo = Static<typeof QuotaInfo>;

/** Lives in base (not in the protocol vocabulary) because `security` (BudgetReader, 2.6.1) needs it and may not import `protocol`. `protocol` re-exports it. */
export const BudgetCounters = Type.Object(
  {
    tokens: Type.Optional(count()),
    modelRequests: Type.Optional(count()),
    toolCalls: Type.Optional(count()),
    wallClockMs: Type.Optional(Type.Number({ minimum: 0 })),
    retries: Type.Optional(count()),
    fixRounds: Type.Optional(count()),
    contextTokens: Type.Optional(count()),
    concurrentAgents: Type.Optional(count()),
    estimatedQuotaPercent: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type BudgetCounters = Static<typeof BudgetCounters>;
