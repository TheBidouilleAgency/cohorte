import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { describe, expect, test } from 'vitest';
import {
  AuthMode,
  BudgetCounters,
  ErrorClass,
  isJsonValue,
  JsonValueSchema,
  ModelCapability,
  ModelRef,
  MonetaryCost,
  QuotaInfo,
  QuotaWindow,
  Redaction,
  ThinkingLevel,
  TokenUsage,
} from '../src/index.ts';

const HEX64 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const INSTANT = '2026-09-18T10:20:30.123Z';

type Case = readonly [name: string, schema: TSchema, value: unknown];

const accepted: readonly Case[] = [
  ['ModelRef', ModelRef, { provider: 'openai-codex', model: 'gpt-5.5-codex' }],
  ['ModelRef with a capability', ModelRef, { provider: 'p', model: 'm', capability: 'reasoning' }],
  ['ModelCapability', ModelCapability, 'cheap'],
  ['ThinkingLevel', ThinkingLevel, 'xhigh'],
  ['AuthMode subscription', AuthMode, 'subscription'],
  ['AuthMode api', AuthMode, 'api'],
  ['MonetaryCost not_applicable', MonetaryCost, 'not_applicable'],
  [
    'MonetaryCost metered',
    MonetaryCost,
    { currency: 'USD', amount: 0.0123, basis: 'catalogue', priceCatalogVersion: '2026-09-01' },
  ],
  ['TokenUsage', TokenUsage, { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, total: 115 }],
  ['QuotaInfo unknown', QuotaInfo, { known: false }],
  [
    'QuotaInfo known',
    QuotaInfo,
    {
      known: true,
      source: 'response-headers',
      provider: 'openai-codex',
      windows: [{ name: 'primary', usedPercent: 42.5, resetsAt: INSTANT, limitLabel: '5h' }],
      observedAt: INSTANT,
    },
  ],
  ['QuotaWindow with a name only', QuotaWindow, { name: 'weekly' }],
  ['BudgetCounters empty', BudgetCounters, {}],
  [
    'BudgetCounters full',
    BudgetCounters,
    {
      tokens: 1,
      modelRequests: 2,
      toolCalls: 3,
      wallClockMs: 4.5,
      retries: 5,
      fixRounds: 6,
      contextTokens: 7,
      concurrentAgents: 8,
      estimatedQuotaPercent: 99.5,
    },
  ],
  ['Redaction', Redaction, { path: '/payload/output', reason: 'secret-value', detector: 'registered:npm-token' }],
  ['Redaction with a digest', Redaction, { path: '', reason: 'size', detector: 'cap', sha256: HEX64 }],
  ['ErrorClass', ErrorClass, 'human-required'],
  ['JsonValue', JsonValueSchema, { a: [1, 'x', null, true, { b: {} }] }],
];

const rejected: readonly Case[] = [
  ['ModelRef: thinking level is NOT part of it (spec 10)', ModelRef, { provider: 'p', model: 'm', thinking: 'high' }],
  ['ModelRef: no model', ModelRef, { provider: 'p' }],
  ['ModelCapability: unknown', ModelCapability, 'smart'],
  ['ThinkingLevel: unknown', ThinkingLevel, 'max'],
  ['AuthMode: exactly two values (spec 10)', AuthMode, 'oauth'],
  ['MonetaryCost: another sentinel', MonetaryCost, 'free'],
  [
    'MonetaryCost: another currency',
    MonetaryCost,
    { currency: 'EUR', amount: 1, basis: 'estimate', priceCatalogVersion: 'v' },
  ],
  ['MonetaryCost: no catalogue version', MonetaryCost, { currency: 'USD', amount: 1, basis: 'estimate' }],
  [
    'MonetaryCost: negative amount',
    MonetaryCost,
    { currency: 'USD', amount: -1, basis: 'estimate', priceCatalogVersion: 'v' },
  ],
  ['TokenUsage: missing total', TokenUsage, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
  ['TokenUsage: negative', TokenUsage, { input: -1, output: 1, cacheRead: 0, cacheWrite: 0, total: 0 }],
  ['TokenUsage: fractional tokens', TokenUsage, { input: 1.5, output: 1, cacheRead: 0, cacheWrite: 0, total: 2.5 }],
  ['QuotaInfo: known without its fields', QuotaInfo, { known: true }],
  ['QuotaInfo: unknown with fields', QuotaInfo, { known: false, provider: 'p' }],
  [
    'QuotaInfo: another source',
    QuotaInfo,
    { known: true, source: 'guess', provider: 'p', windows: [], observedAt: INSTANT },
  ],
  [
    'QuotaInfo: observedAt is not an IsoInstant',
    QuotaInfo,
    { known: true, source: 'error', provider: 'p', windows: [], observedAt: 'yesterday' },
  ],
  ['QuotaWindow: no name', QuotaWindow, { usedPercent: 1 }],
  ['BudgetCounters: unknown counter', BudgetCounters, { dollars: 1 }],
  ['BudgetCounters: negative', BudgetCounters, { tokens: -1 }],
  ['Redaction: unknown reason', Redaction, { path: '/a', reason: 'because', detector: 'd' }],
  ['Redaction: digest is not a Sha256', Redaction, { path: '/a', reason: 'size', detector: 'd', sha256: 'abc' }],
  ['Redaction: path is not a JSON pointer', Redaction, { path: 'payload.output', reason: 'size', detector: 'd' }],
  ['ErrorClass: unknown', ErrorClass, 'fatal'],
  ['JsonValue: undefined inside', JsonValueSchema, { a: undefined }],
  ['JsonValue: function', JsonValueSchema, { a: () => 1 }],
];

describe('[S] schemas of DESIGN 2.1', () => {
  test.for(accepted)('accepts %s', ([, schema, value]) => {
    expect([...Compile(schema).Errors(value)]).toEqual([]);
  });

  test.for(rejected)('rejects %s', ([, schema, value]) => {
    expect(Compile(schema).Check(value)).toBe(false);
  });

  test('objects are authored strict: the writer side rejects unknown keys (C3)', () => {
    for (const schema of [ModelRef, TokenUsage, QuotaWindow, BudgetCounters, Redaction]) {
      expect((schema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
  });

  test('every schema serialises to plain JSON Schema without undefined', () => {
    for (const [, schema] of accepted) {
      const text = JSON.stringify(schema);
      expect(text).not.toContain('undefined');
      expect(isJsonValue(JSON.parse(text))).toBe(true);
    }
  });
});

describe('isJsonValue', () => {
  test.for<readonly [string, unknown, boolean]>([
    ['null', null, true],
    ['nested', { a: [1, 'x', { b: null }] }, true],
    ['null-prototype object', Object.create(null), true],
    ['undefined', undefined, false],
    ['undefined property', { a: undefined }, false],
    ['NaN', Number.NaN, false],
    ['Infinity', [Number.POSITIVE_INFINITY], false],
    ['bigint', 1n, false],
    ['function', () => 1, false],
    ['Date', new Date(0), false],
    ['Map', new Map(), false],
    ['sparse array (a hole is not a value)', Object.assign([], { 0: 1, 2: 3 }), false],
  ])('%s -> %s', ([, value, expected]) => {
    expect(isJsonValue(value)).toBe(expected);
  });

  test('a cycle is not JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);
  });
});
