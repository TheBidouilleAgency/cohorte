// DESIGN 2.2.7 — pin and auth status.
import { IsoInstant, Sha256 } from '@cohorte/base';
import { type Static, Type } from 'typebox';

const strict = { additionalProperties: false } as const;
const count = () => Type.Integer({ minimum: 0 });

/** spec 16 */
export const RuntimePin = Type.Object(
  {
    runtimeId: Type.String(),
    adapterVersion: Type.String(),
    engine: Type.Union([Type.Object({ name: Type.String(), version: Type.String() }, strict), Type.Null()]),
    node: Type.Object({ version: Type.String(), execPath: Type.String() }, strict),
    artifacts: Type.Array(
      Type.Object(
        {
          role: Type.Union([
            Type.Literal('agent-host-bundle'),
            Type.Literal('engine-package-tree'),
            Type.Literal('install-lock'),
          ]),
          path: Type.String(),
          sha256: Sha256,
          files: Type.Optional(count()),
          bytes: count(),
        },
        strict,
      ),
    ),
    /** sha256(canonicalJson(all of the above)) */
    digest: Sha256,
  },
  strict,
);
export type RuntimePin = Static<typeof RuntimePin>;

/** never contains a token, a refresh token or an account secret */
export const ProviderAuthStatus = Type.Object(
  {
    provider: Type.String(),
    /** 'unknown-transient' = credential store locked: NEVER mapped to AUTH_REQUIRED */
    state: Type.Union([
      Type.Literal('oauth'),
      Type.Literal('api-key'),
      Type.Literal('absent'),
      Type.Literal('unknown-transient'),
    ]),
    subscription: Type.Boolean(),
    source: Type.Optional(Type.String()),
    checkedAt: IsoInstant,
    /** non-secret account/tenant label WHEN the engine exposes one without a secret; absent otherwise */
    accountLabel: Type.Optional(Type.String()),
    /** Cohorte's own table, not the engine's subscription flag (§3.7) */
    billing: Type.Union([Type.Literal('plan-limits'), Type.Literal('metered'), Type.Literal('unknown')]),
    caveat: Type.Optional(Type.String()),
  },
  strict,
);
export type ProviderAuthStatus = Static<typeof ProviderAuthStatus>;
