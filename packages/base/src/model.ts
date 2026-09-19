import { type Static, Type } from 'typebox';

export const ModelCapability = Type.Union([
  Type.Literal('fast'),
  Type.Literal('coding'),
  Type.Literal('reasoning'),
  Type.Literal('vision'),
  Type.Literal('cheap'),
]);
export type ModelCapability = Static<typeof ModelCapability>;

/** Spec 10, VERBATIM. Thinking level is NOT part of ModelRef: it travels next to it (SpawnRequest.thinking, tier table). */
export const ModelRef = Type.Object(
  {
    provider: Type.String(),
    model: Type.String(),
    capability: Type.Optional(ModelCapability),
  },
  { additionalProperties: false },
);
export type ModelRef = Static<typeof ModelRef>;

export const ThinkingLevel = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
]);
export type ThinkingLevel = Static<typeof ThinkingLevel>;

/** spec 10: exactly these two */
export const AuthMode = Type.Union([Type.Literal('subscription'), Type.Literal('api')]);
export type AuthMode = Static<typeof AuthMode>;

/** A number exists only for a metered leg (authMode 'api'). NEVER 'not_applicable' for a metered leg (I8). */
export const MonetaryCost = Type.Union([
  Type.Literal('not_applicable'),
  Type.Object(
    {
      currency: Type.Literal('USD'),
      amount: Type.Number({ minimum: 0 }),
      basis: Type.Union([Type.Literal('catalogue'), Type.Literal('estimate')]),
      priceCatalogVersion: Type.String(),
    },
    { additionalProperties: false },
  ),
]);
export type MonetaryCost = Static<typeof MonetaryCost>;
