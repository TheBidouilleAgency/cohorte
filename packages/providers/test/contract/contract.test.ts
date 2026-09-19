import type { ErrorInfo, ModelRef, MonetaryCost, QuotaInfo, Result, TokenUsage } from '@cohorte/base';
import { DEFAULT_CONFIG } from '@cohorte/config/schema';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type {
  AuthDecision,
  AuthPolicy,
  BilledLeg,
  BillingRow,
  CostOf,
  ParseQuotaHeaders,
  ResolvedModel,
  ResolveModel,
} from '../../src/contract.ts';
import * as barrel from '../../src/index.ts';
import { costOf, createAuthPolicy, parseQuotaHeaders, resolveModel } from '../../src/index.ts';

const USAGE: TokenUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };

describe('the providers contract', () => {
  test('the stubs carry the contract signatures', () => {
    expectTypeOf(resolveModel).toEqualTypeOf<ResolveModel>();
    expectTypeOf(costOf).toEqualTypeOf<CostOf>();
    expectTypeOf(parseQuotaHeaders).toEqualTypeOf<ParseQuotaHeaders>();
    expectTypeOf(createAuthPolicy).returns.toEqualTypeOf<AuthPolicy>();
  });

  test('resolution is a Result: an unroutable tier fails closed, it never falls back', () => {
    expectTypeOf<ReturnType<ResolveModel>>().toEqualTypeOf<Result<ResolvedModel, ErrorInfo>>();
    expectTypeOf<ResolvedModel['ref']>().toEqualTypeOf<ModelRef>();
    expectTypeOf<ResolvedModel['baseUrl']>().toEqualTypeOf<string>();
    expectTypeOf<ReturnType<AuthPolicy['decide']>>().toEqualTypeOf<Result<AuthDecision, ErrorInfo>>();
  });

  test('the three rows of DESIGN 3.7 are expressible, and a metered row has a cost basis', () => {
    const rows: BillingRow[] = [
      {
        provider: 'openai-codex',
        access: 'pi-oauth',
        authMode: 'subscription',
        billing: 'plan-limits',
        monetaryCost: 'not_applicable',
      },
      { provider: 'anthropic', access: 'pi-oauth', authMode: 'api', billing: 'metered', monetaryCost: 'estimate' },
      { provider: '*', access: 'api-key', authMode: 'api', billing: 'metered', monetaryCost: 'catalogue' },
    ];
    expect(rows.filter((row) => row.billing === 'metered' && row.monetaryCost === 'not_applicable')).toEqual([]);
    expectTypeOf<BilledLeg['monetaryCost']>().toEqualTypeOf<MonetaryCost>();
    expectTypeOf<ReturnType<ParseQuotaHeaders>['quota']>().toEqualTypeOf<QuotaInfo>();
  });
});

describe('the Wave-0 frozen barrel of @cohorte/providers', () => {
  test('the public API of DESIGN 1.1 exists (`AuthPolicy` is the type; its factory is createAuthPolicy)', () => {
    expect(Object.keys(barrel).sort()).toEqual(['costOf', 'createAuthPolicy', 'parseQuotaHeaders', 'resolveModel']);
  });

  test('the first static routing and billing rows are executable', () => {
    expect(resolveModel({ role: 'implementer' }, DEFAULT_CONFIG)).toMatchObject({
      ok: true,
      value: { tier: 'coding', access: 'pi-oauth' },
    });
    expect(createAuthPolicy(DEFAULT_CONFIG).decide('openai-codex')).toMatchObject({
      ok: true,
      value: { metered: false },
    });
    expect(costOf({ provider: 'openai-codex', model: 'gpt-5.5', access: 'pi-oauth', usage: USAGE })).toEqual({
      authMode: 'subscription',
      billing: 'plan-limits',
      monetaryCost: 'not_applicable',
    });
    expect(parseQuotaHeaders('openai-codex', { 'retry-after': '3' }, new Date(0)).retryAfterMs).toBe(3000);
  });
});
