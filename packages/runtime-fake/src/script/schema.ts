// The `[S]` schema of DESIGN 3.10. Strict: a script is an input a human writes, a typo must not pass as a no-op.
import { ERROR_CODE_PATTERN, ErrorClass, JsonValueSchema, QuotaInfo, TokenUsage } from '@cohorte/base';
import { type Static, type TUnsafe, Type } from 'typebox';
import type { FakeScript } from './index.ts';

const strict = { additionalProperties: false } as const;
const count = () => Type.Integer({ minimum: 0 });

const PartialTokenUsage = Type.Object(
  {
    input: Type.Optional(count()),
    output: Type.Optional(count()),
    cacheRead: Type.Optional(count()),
    cacheWrite: Type.Optional(count()),
    total: Type.Optional(count()),
  },
  strict,
);

const FakeScriptCyclic = Type.Cyclic(
  {
    FakeStep: Type.Union([
      Type.Object(
        { do: Type.Literal('say'), text: Type.String(), chunks: Type.Optional(Type.Integer({ minimum: 1 })) },
        strict,
      ),
      Type.Object({ do: Type.Literal('think'), text: Type.String() }, strict),
      Type.Object(
        {
          do: Type.Literal('tool'),
          tool: Type.String(),
          input: JsonValueSchema,
          expect: Type.Optional(
            Type.Object({ isError: Type.Optional(Type.Boolean()), textIncludes: Type.Optional(Type.String()) }, strict),
          ),
          onDenied: Type.Optional(Type.Array(Type.Ref('FakeStep'))),
        },
        strict,
      ),
      Type.Object({ do: Type.Literal('submit'), output: JsonValueSchema }, strict),
      Type.Object({ do: Type.Literal('usage'), tokens: PartialTokenUsage }, strict),
      Type.Object({ do: Type.Literal('await-message'), timeoutMs: Type.Optional(Type.Number({ minimum: 0 })) }, strict),
      Type.Object(
        {
          do: Type.Literal('fail'),
          error: Type.Object(
            {
              class: ErrorClass,
              code: Type.String({ pattern: ERROR_CODE_PATTERN }),
              retryable: Type.Boolean(),
              retryAfterMs: Type.Optional(Type.Number({ minimum: 0 })),
            },
            strict,
          ),
        },
        strict,
      ),
      Type.Object(
        { do: Type.Literal('hang'), ms: Type.Union([Type.Number({ minimum: 0 }), Type.Literal('forever')]) },
        strict,
      ),
      Type.Object(
        {
          do: Type.Literal('crash'),
          at: Type.Union([Type.Literal('before-next-step'), Type.Literal('during-tool')]),
        },
        strict,
      ),
      Type.Object({ do: Type.Literal('stop-without-result') }, strict),
      Type.Object(
        {
          do: Type.Literal('model-request'),
          status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
          quota: Type.Optional(QuotaInfo),
          authSource: Type.Optional(Type.Union([Type.Literal('oauth'), Type.Literal('api-key'), Type.Literal('none')])),
          baseUrl: Type.Optional(Type.String()),
        },
        strict,
      ),
    ]),
    FakeScript: Type.Object(
      {
        version: Type.Literal(1),
        agents: Type.Array(
          Type.Object(
            {
              match: Type.Object(
                {
                  role: Type.Optional(Type.String()),
                  agentId: Type.Optional(Type.String()),
                  incarnation: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal('any')])),
                  attempt: Type.Optional(Type.Integer({ minimum: 1 })),
                },
                strict,
              ),
              steps: Type.Array(Type.Ref('FakeStep')),
            },
            strict,
          ),
        ),
        defaults: Type.Optional(
          Type.Object({ usagePerTurn: Type.Optional(TokenUsage), model: Type.Optional(Type.String()) }, strict),
        ),
      },
      strict,
    ),
  },
  'FakeScript',
);

/**
 * Not named `FakeScript` like its type, and explicitly annotated: Biome 2.5.14 overflows its stack when it has to
 * infer a TypeBox const that shares its name with a recursive type (docs/v3/requests/U0.02.md R1); `FakeStep` is one.
 */
export const FakeScriptSchema: TUnsafe<FakeScript> = Type.Unsafe<FakeScript>(FakeScriptCyclic);

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _FakeScriptMatchesItsSchema = Assert<MutuallyAssignable<Static<typeof FakeScriptCyclic>, FakeScript>>;
