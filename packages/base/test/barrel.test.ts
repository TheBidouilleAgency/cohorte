import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as base from '../src/index.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const sources = readdirSync(SRC).filter((name) => name.endsWith('.ts'));

describe('@cohorte/base barrel', () => {
  test('exports every runtime name of DESIGN 2.1 / 2.8 and PLAN U0.02', () => {
    const expected = [
      // ids.ts
      'ID_PATTERN',
      'parseId',
      // ports.ts
      'systemClock',
      'createUuidV7IdSource',
      // canonical.ts
      'canonicalJson',
      'sha256Hex',
      // hmac.ts
      'hmacSha256Hex',
      'computeAnchorMac',
      // errors (2.8, PLAN PC-1)
      'CohorteError',
      'toErrorInfo',
      'NotImplemented',
      'ERROR_CATALOGUE',
      'errorOf',
      // [S] schemas, each under the name of its type
      'ModelCapability',
      'ModelRef',
      'ThinkingLevel',
      'AuthMode',
      'MonetaryCost',
      'TokenUsage',
      'QuotaInfo',
      'QuotaWindow',
      'BudgetCounters',
      'Redaction',
      'ErrorClass',
      'ErrorInfo',
      // JsonValue is a type only in DESIGN 2.1; its schema has a name of its own (see json.ts)
      'JsonValueSchema',
    ];
    for (const name of expected) expect(Object.keys(base), name).toContain(name);
  });

  test('re-exports every source file', () => {
    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8');
    for (const file of sources.filter((name) => name !== 'index.ts')) {
      expect(barrel, file).toContain(`'./${file}'`);
    }
  });
});

describe('@cohorte/base is a leaf (DESIGN 1.1: "No I/O except node:crypto")', () => {
  test.for(sources)('%s imports only typebox, node:crypto and its siblings', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^(?:typebox|typebox\/[a-z]+|node:crypto|\.\/[a-z0-9-]+\.ts)$/);
    }
  });
});
