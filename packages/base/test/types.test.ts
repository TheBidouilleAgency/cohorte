import type { Static } from 'typebox';
import { describe, expectTypeOf, test } from 'vitest';
import {
  type AgentId,
  type AuthMode,
  type Brand,
  type BudgetCounters,
  type Clock,
  ERROR_CATALOGUE,
  type ErrorClass,
  type ErrorCode,
  type ErrorInfo,
  type EventId,
  errorOf,
  type IdSource,
  type IsoInstant,
  type JsonValue,
  type JsonValueSchema,
  type ModelCapability,
  type ModelRef,
  type MonetaryCost,
  parseId,
  type QuotaInfo,
  type QuotaWindow,
  type Redaction,
  type Redactor,
  type Result,
  type RunId,
  type Sealed,
  type SealedJson,
  type SealedText,
  type Sha256,
  type ThinkingLevel,
  type TokenUsage,
} from '../src/index.ts';

// Named in type positions only (instantiation expressions): nothing reads them at run time.
declare const ids: IdSource;
declare const redactor: Redactor;

// These assertions are compile-time only: vitest runs the file, `tsc -p tsconfig.tests.json` (and the
// unit's own tsconfig.checks project) is what makes a wrong one fail. DESIGN 0.2 I7, 7.0.

describe('Brand', () => {
  test('a plain string is not an id', () => {
    expectTypeOf<string>().not.toExtend<RunId>();
    expectTypeOf<'run_1'>().not.toExtend<RunId>();
  });

  test('an id is still a string', () => {
    expectTypeOf<RunId>().toExtend<string>();
  });

  test("Brand<string,'RunId'> is not an AgentId, in either direction", () => {
    expectTypeOf<Brand<string, 'RunId'>>().toEqualTypeOf<RunId>();
    expectTypeOf<RunId>().not.toExtend<AgentId>();
    expectTypeOf<AgentId>().not.toExtend<RunId>();
    expectTypeOf<Sha256>().not.toExtend<IsoInstant>();
  });

  test('parseId mints exactly the brand it is asked for', () => {
    expectTypeOf(parseId('RunId', 'x')).toEqualTypeOf<Result<RunId, ErrorInfo>>();
    expectTypeOf(parseId('AgentId', 'x')).toEqualTypeOf<Result<AgentId, ErrorInfo>>();
    expectTypeOf(parseId('GrantId', 'x')).toEqualTypeOf<Result<Brand<string, 'GrantId'>, ErrorInfo>>();
  });

  test('IdSource.next mints the brand the caller names', () => {
    expectTypeOf<ReturnType<IdSource['next']>>().toExtend<string>();
    expectTypeOf<ReturnType<typeof ids.next<'EventId'>>>().toEqualTypeOf<EventId>();
  });

  test('the id schemas derive the branded type', () => {
    expectTypeOf<Static<typeof RunId>>().toEqualTypeOf<RunId>();
    expectTypeOf<Static<typeof EventId>>().toEqualTypeOf<EventId>();
    expectTypeOf<Static<typeof Sha256>>().toEqualTypeOf<Sha256>();
    expectTypeOf<Static<typeof IsoInstant>>().toEqualTypeOf<IsoInstant>();
  });
});

describe('Sealed (I7)', () => {
  test('a string is not assignable to SealedText', () => {
    expectTypeOf<string>().not.toExtend<SealedText>();
    expectTypeOf<'literal'>().not.toExtend<SealedText>();
  });

  test('a JsonValue is not assignable to SealedJson', () => {
    expectTypeOf<JsonValue>().not.toExtend<SealedJson>();
    expectTypeOf<{ a: number }>().not.toExtend<Sealed<{ a: number }>>();
  });

  test('a sealed value is still usable as the value it wraps', () => {
    expectTypeOf<SealedText>().toExtend<string>();
    expectTypeOf<SealedJson>().toExtend<JsonValue>();
    expectTypeOf<Sealed<{ a: number }>>().toExtend<{ a: number }>();
  });

  test('sealing one type does not seal another', () => {
    expectTypeOf<SealedText>().not.toExtend<Sealed<number>>();
  });

  test('only a Redactor hands out sealed values', () => {
    expectTypeOf<ReturnType<Redactor['sealText']>['text']>().toEqualTypeOf<SealedText>();
    expectTypeOf<ReturnType<typeof redactor.sealJson<{ a: number }>>['value']>().toEqualTypeOf<Sealed<{ a: number }>>();
    expectTypeOf<Parameters<Redactor['registerSecret']>>().toEqualTypeOf<[value: string, id: string]>();
  });
});

describe('[S] types are exactly the listings of DESIGN 2.1', () => {
  test('model.ts', () => {
    expectTypeOf<ModelCapability>().toEqualTypeOf<'fast' | 'coding' | 'reasoning' | 'vision' | 'cheap'>();
    expectTypeOf<ModelRef>().toEqualTypeOf<{ provider: string; model: string; capability?: ModelCapability }>();
    expectTypeOf<ThinkingLevel>().toEqualTypeOf<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>();
    expectTypeOf<AuthMode>().toEqualTypeOf<'subscription' | 'api'>();
    expectTypeOf<MonetaryCost>().toEqualTypeOf<
      | 'not_applicable'
      | { currency: 'USD'; amount: number; basis: 'catalogue' | 'estimate'; priceCatalogVersion: string }
    >();
  });

  test('usage.ts', () => {
    expectTypeOf<TokenUsage>().toEqualTypeOf<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    }>();
    expectTypeOf<QuotaWindow>().toEqualTypeOf<{
      name: string;
      usedPercent?: number;
      resetsAt?: IsoInstant;
      limitLabel?: string;
    }>();
    expectTypeOf<QuotaInfo>().toEqualTypeOf<
      | { known: false }
      | {
          known: true;
          source: 'response-headers' | 'error';
          provider: string;
          windows: QuotaWindow[];
          observedAt: IsoInstant;
        }
    >();
    expectTypeOf<BudgetCounters>().toEqualTypeOf<{
      tokens?: number;
      modelRequests?: number;
      toolCalls?: number;
      wallClockMs?: number;
      retries?: number;
      fixRounds?: number;
      contextTokens?: number;
      concurrentAgents?: number;
      estimatedQuotaPercent?: number;
    }>();
  });

  test('redaction.ts', () => {
    expectTypeOf<Redaction>().toEqualTypeOf<{
      path: string;
      reason: 'secret-value' | 'secret-pattern' | 'env-value' | 'private-key' | 'sensitive-path' | 'size';
      detector: string;
      sha256?: Sha256;
    }>();
  });

  test('errors.ts', () => {
    interface DesignErrorInfo {
      code: string;
      class: ErrorClass;
      message: string;
      impact: string;
      retryable: boolean;
      retryAfterMs?: number;
      remediation: string;
      cause?: DesignErrorInfo;
      details?: Record<string, JsonValue>;
    }
    expectTypeOf<ErrorInfo>().toEqualTypeOf<DesignErrorInfo>();
    expectTypeOf<Static<typeof ErrorInfo>>().toEqualTypeOf<ErrorInfo>();
    expectTypeOf<ErrorClass>().toEqualTypeOf<
      | 'configuration'
      | 'validation'
      | 'permission'
      | 'security'
      | 'provider-transient'
      | 'provider-terminal'
      | 'tool-transient'
      | 'tool-terminal'
      | 'conflict'
      | 'budget'
      | 'timeout'
      | 'corruption'
      | 'human-required'
    >();
  });

  test('canonical.ts / json.ts', () => {
    type DesignJsonValue = null | boolean | number | string | DesignJsonValue[] | { [k: string]: DesignJsonValue };
    expectTypeOf<JsonValue>().toEqualTypeOf<DesignJsonValue>();
    expectTypeOf<Static<typeof JsonValueSchema>>().toEqualTypeOf<JsonValue>();
  });

  test('ports.ts', () => {
    expectTypeOf<Clock['now']>().toEqualTypeOf<() => IsoInstant>();
    expectTypeOf<Clock['sleep']>().toEqualTypeOf<(ms: number, signal?: AbortSignal) => Promise<void>>();
    expectTypeOf<Result<number, string>>().toEqualTypeOf<{ ok: true; value: number } | { ok: false; error: string }>();
  });
});

describe('error catalogue', () => {
  test('errorOf only takes a catalogue code', () => {
    expectTypeOf(errorOf).parameter(0).toEqualTypeOf<ErrorCode>();
    expectTypeOf<'security/symlink-escape'>().toExtend<ErrorCode>();
    expectTypeOf<'security/made-up'>().not.toExtend<ErrorCode>();
    expectTypeOf<string>().not.toExtend<ErrorCode>();
  });

  test('every class has its /unexpected code, so a fallback can be built from a class alone', () => {
    expectTypeOf<`${ErrorClass}/unexpected`>().toExtend<ErrorCode>();
  });

  test('the catalogue keeps the record type of DESIGN 2.8', () => {
    expectTypeOf(ERROR_CATALOGUE).toEqualTypeOf<
      Readonly<
        Record<string, { class: ErrorClass; retryable: boolean; impact: string; remediation: string; exit: number }>
      >
    >();
  });
});
