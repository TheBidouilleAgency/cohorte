// apps/cli/test/registry/json-outputs.test.ts — PLAN U0.10 test list: "every verb flagged --json has an entry in
// JSON_OUTPUTS whose schema exists in the protocol / project-model / security contracts".
import { describe, expect, test } from 'vitest';
import { JSON_OUTPUTS, resolveDocumentSchema, VERBS } from '../../src/contract/index.ts';

describe('JSON_OUTPUTS', () => {
  test('every JSON_OUTPUTS key names a real verb', () => {
    const verbNames = new Set(VERBS.map((verb) => verb.name));
    for (const key of Object.keys(JSON_OUTPUTS)) {
      expect(verbNames.has(key), `JSON_OUTPUTS has an entry for unknown verb "${key}"`).toBe(true);
    }
  });

  test('every JSON_OUTPUTS entry resolves to a real schema', () => {
    for (const [verb, refs] of Object.entries(JSON_OUTPUTS)) {
      expect(refs.length, `${verb} has an empty JSON_OUTPUTS entry`).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(() => resolveDocumentSchema(ref), `${verb}'s ${ref.source}/${ref.name} does not resolve`).not.toThrow();
      }
    }
  });

  test('resolveDocumentSchema throws for an unknown protocol document name', () => {
    expect(() => resolveDocumentSchema({ source: 'protocol', name: 'not-a-real-document' as never })).toThrow();
  });

  // The direction that actually freezes the invariant: `cli.ts` registers `--json` from `verb.json` alone, so a
  // verb flagged `--json` with no JSON_OUTPUTS entry would promise a machine output no schema backs — which is
  // precisely what a Wave-4 `--json validates` test reads this map for.
  test('the set of --json verbs equals the JSON_OUTPUTS key set', () => {
    const flagged = VERBS.filter((verb) => verb.json)
      .map((verb) => verb.name)
      .sort();
    expect(flagged).toEqual(Object.keys(JSON_OUTPUTS).sort());
  });

  test.for(['status', 'inspect', 'diff', 'doctor', 'reconcile', 'discover'])('%s is in JSON_OUTPUTS', (verb) => {
    expect(JSON_OUTPUTS[verb]).toBeDefined();
  });

  test('resolveDocumentSchema throws for an unknown project-model document name', () => {
    expect(() => resolveDocumentSchema({ source: 'project-model', name: 'not-a-real-document' as never })).toThrow();
  });
});
