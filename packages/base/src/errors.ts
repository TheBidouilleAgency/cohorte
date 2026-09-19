import { type Static, type TUnsafe, Type } from 'typebox';
import { type JsonValue, JsonValueSchema } from './json.ts';

/** Spec 24, in spec order. Closed: a fourteenth class would be a MAJOR of both frontiers. */
export const ERROR_CLASSES = [
  'configuration',
  'validation',
  'permission',
  'security',
  'provider-transient',
  'provider-terminal',
  'tool-transient',
  'tool-terminal',
  'conflict',
  'budget',
  'timeout',
  'corruption',
  'human-required',
] as const;

export const ErrorClass = Type.Union([
  Type.Literal('configuration'),
  Type.Literal('validation'),
  Type.Literal('permission'),
  Type.Literal('security'),
  Type.Literal('provider-transient'),
  Type.Literal('provider-terminal'),
  Type.Literal('tool-transient'),
  Type.Literal('tool-terminal'),
  Type.Literal('conflict'),
  Type.Literal('budget'),
  Type.Literal('timeout'),
  Type.Literal('corruption'),
  Type.Literal('human-required'),
]);
export type ErrorClass = Static<typeof ErrorClass>;

/** `cause` is chained at most this deep below the top-level error (DESIGN 2.1). */
export const MAX_CAUSE_DEPTH = 5;

/** DESIGN 2.1, verbatim. */
export interface ErrorInfo {
  /** stable, "<class>/<slug>" */
  code: string;
  class: ErrorClass;
  /** redacted, single paragraph (the cause) */
  message: string;
  /** what this means for the run / the user (spec 21 "cause, impact, run, prochaine action") */
  impact: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** imperative next action */
  remediation: string;
  /** chained, max depth 5 */
  cause?: ErrorInfo;
  details?: Record<string, JsonValue>;
}

export const ERROR_CODE_PATTERN = '^[a-z]+(?:-[a-z]+)*/[a-z0-9]+(?:-[a-z0-9]+)*$';

const ErrorInfoCyclic = Type.Cyclic(
  {
    ErrorInfo: Type.Object(
      {
        code: Type.String({ pattern: ERROR_CODE_PATTERN }),
        class: ErrorClass,
        message: Type.String(),
        impact: Type.String(),
        retryable: Type.Boolean(),
        retryAfterMs: Type.Optional(Type.Number({ minimum: 0 })),
        remediation: Type.String(),
        cause: Type.Optional(Type.Ref('ErrorInfo')),
        details: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
      },
      { additionalProperties: false },
    ),
  },
  'ErrorInfo',
);

/**
 * The schema of {@link ErrorInfo}, under the name of its type ([S], DESIGN §2). The static type is the DESIGN
 * interface and the assertion below keeps it equal to what the schema derives: an `ErrorInfo` sits in dozens of
 * event payloads, and a derived recursive type would be re-expanded in each of them.
 *
 * KEEP THE EXPLICIT `TUnsafe<ErrorInfo>` ANNOTATION. Biome 2.5.14 is type-aware (nursery/noFloatingPromises) and
 * overflows its stack when it has to INFER this call for a const that shares its name with a recursive type, as
 * soon as a class extending Error holds that type — `CohorteError.info` does. Biome then exits 0: the lint looks
 * green while nothing was checked. With the annotation it has nothing to infer. See docs/v3/requests/U0.02.md R1.
 */
export const ErrorInfo: TUnsafe<ErrorInfo> = Type.Unsafe<ErrorInfo>(ErrorInfoCyclic);

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _ErrorInfoMatchesItsSchema = Assert<MutuallyAssignable<Static<typeof ErrorInfoCyclic>, ErrorInfo>>;
type _ErrorClassesMatchTheSchema = Assert<MutuallyAssignable<(typeof ERROR_CLASSES)[number], ErrorClass>>;
