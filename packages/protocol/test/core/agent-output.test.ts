import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  AGENT_OUTPUT_MAX_FINDINGS,
  AGENT_OUTPUT_MAX_SUMMARY,
  AgentOutput,
  Finding,
  ReviewResult,
} from '../../src/agent-output.ts';
import { compileOpen, compileSchema, toOpenSchema } from '../../src/compile.ts';
import type { Severity } from '../../src/vocabulary.ts';

const finding = (over: Record<string, unknown> = {}) => ({
  severity: 'major',
  kind: 'spec-violation',
  rule: 'AC-03',
  location: { file: 'src/cart.ts', line: 12, endLine: 14, symbol: 'total' },
  reproduction: 'pnpm test cart',
  expected: 'the total includes VAT',
  actual: 'the total is net',
  confidence: 0.8,
  scope: 'in-scope',
  ...over,
});

const output = (over: Record<string, unknown> = {}) => ({
  status: 'completed',
  summary: 'implemented the cart total',
  artifacts: [{ path: 'src/cart.ts', kind: 'file' }],
  findings: [],
  checks: [{ name: 'unit', status: 'passed', command: 'pnpm test' }],
  questions: [],
  confidence: 0.9,
  ...over,
});

const keysOf = (node: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) for (const item of node) keysOf(item, found);
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      keysOf(value, found);
    }
  }
  return found;
};

describe('AgentOutput JSON Schema (it is submit_result.inputSchema)', () => {
  const schema = JSON.parse(JSON.stringify(AgentOutput)) as {
    type: string;
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };

  test('is flat: a plain object at the root, nothing to resolve anywhere', () => {
    expect(schema.type).toBe('object');
    for (const keyword of ['$ref', '$defs', 'definitions', 'oneOf', 'anyOf', 'allOf']) {
      expect(Object.keys(schema)).not.toContain(keyword);
    }
    const everywhere = keysOf(schema);
    for (const keyword of ['$ref', '$defs', 'definitions', 'oneOf', '$id']) expect(everywhere).not.toContain(keyword);
    expect(keysOf(toOpenSchema(AgentOutput))).not.toContain('$ref');
  });

  test('caps the findings at 30 and the summary at 2000', () => {
    expect(schema.properties.findings?.maxItems).toBe(30);
    expect(AGENT_OUTPUT_MAX_FINDINGS).toBe(30);
    expect(schema.properties.summary?.maxLength).toBe(2000);
    expect(AGENT_OUTPUT_MAX_SUMMARY).toBe(2000);
  });

  test('requires exactly the seven fields DESIGN 2.9 makes mandatory', () => {
    expect([...schema.required].sort()).toEqual(
      ['artifacts', 'checks', 'confidence', 'findings', 'questions', 'status', 'summary'].sort(),
    );
  });

  test('the findings are the Finding schema, inlined', () => {
    expect(schema.properties.findings?.items).toEqual(JSON.parse(JSON.stringify(Finding)));
  });
});

describe('AgentOutput values', () => {
  const check = compileSchema(AgentOutput);

  test.for([
    ['the minimal output', output()],
    ['an output with findings', output({ findings: [finding(), finding({ kind: 'security', severity: 'critical' })] })],
    [
      'an output with assumptions and addressed remediation',
      output({
        assumptions: [{ gap: 'currency', decision: 'EUR' }],
        remediationAddressed: [{ findingId: 'fnd_0123456789abcdef', how: 'added VAT' }],
      }),
    ],
    ['an artifact with a claimed digest', output({ artifacts: [{ path: 'a.diff', kind: 'diff', sha256: 'claimed' }] })],
    ['30 findings', output({ findings: Array.from({ length: 30 }, () => finding()) })],
    ['a 2000-character summary', output({ summary: 'x'.repeat(2000) })],
  ] as const)('accepts %s', ([, value]) => {
    expect(check(value)).toEqual({ ok: true, value });
  });

  test.for([
    ['31 findings', output({ findings: Array.from({ length: 31 }, () => finding()) })],
    ['a 2001-character summary', output({ summary: 'x'.repeat(2001) })],
    ['an unknown status', output({ status: 'done' })],
    ['a confidence above 1', output({ confidence: 1.5 })],
    ['a check status outside the claims', output({ checks: [{ name: 'unit', status: 'errored' }] })],
    ['an unknown key', output({ verdict: 'approved' })],
    ['a missing list', output({ questions: undefined })],
  ] as const)('rejects %s', ([, value]) => {
    expect(check(JSON.parse(JSON.stringify(value))).ok).toBe(false);
  });
});

describe('Finding', () => {
  const check = compileSchema(Finding);

  test('validates WITHOUT a location and without a reproduction: routing it to needsInvestigation is the job of core', () => {
    const { location: _location, reproduction: _reproduction, ...bare } = finding();
    expect(check(bare)).toEqual({ ok: true, value: bare });
    expect(compileSchema(AgentOutput)(output({ findings: [bare] })).ok).toBe(true);
  });

  test.for([
    ['a file-only location', finding({ location: { file: 'src/cart.ts' } })],
    ['an id assigned by Cohorte', finding({ id: 'fnd_0123456789abcdef' })],
    ['a deferred finding with its reason', finding({ scope: 'deferred', outOfScopeReason: 'not in this diff' })],
    ['a suggested fix', finding({ suggestedFix: 'multiply by 1.2' })],
  ] as const)('accepts %s', ([, value]) => {
    expect(check(value).ok).toBe(true);
  });

  test.for([
    ['an unknown severity', finding({ severity: 'blocker' })],
    ['an unknown kind', finding({ kind: 'style' })],
    ['a location without a file', finding({ location: { line: 3 } })],
    ['line 0', finding({ location: { file: 'a.ts', line: 0 } })],
    ['a malformed id', finding({ id: 'F-1' })],
    ['a negative confidence', finding({ confidence: -0.1 })],
    ['an unknown scope', finding({ scope: 'later' })],
  ] as const)('rejects %s', ([, value]) => {
    expect(check(value).ok).toBe(false);
  });
});

describe('ReviewResult', () => {
  const result = {
    verdict: 'findings',
    kept: [finding()],
    refuted: [],
    deferred: [],
    needsInvestigation: [],
    blocking: 0,
    blockingItems: [],
    fingerprint: '',
    unreviewed: ['frontend'],
    clean: false,
    counts: { critical: 0, major: 1, minor: 0, info: 0 },
  };

  test('validates, and counts every severity', () => {
    expect(compileSchema(ReviewResult)(result)).toEqual({ ok: true, value: result });
    expect(compileOpen(ReviewResult)(result).ok).toBe(true);
    expect(compileSchema(ReviewResult)({ ...result, counts: { critical: 0, major: 1, minor: 0 } }).ok).toBe(false);
    expect(compileSchema(ReviewResult)({ ...result, verdict: 'rejected' }).ok).toBe(false);
    expectTypeOf<ReviewResult['counts']>().toEqualTypeOf<Record<Severity, number>>();
  });

  test('the fingerprint is empty or 16 hex digits', () => {
    expect(compileSchema(ReviewResult)({ ...result, fingerprint: '0123456789abcdef' }).ok).toBe(true);
    expect(compileSchema(ReviewResult)({ ...result, fingerprint: 'abc' }).ok).toBe(false);
  });
});
