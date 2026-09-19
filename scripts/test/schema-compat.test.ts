// Gate G0 (PLAN U0.G) — the two checks of DESIGN 7.6's `schema-compat` job that need only THIS release. ajv is a
// second implementation on purpose: it is what a schema-only client (AC-07) runs, so a schema TypeBox's own compiler
// tolerates but ajv strict refuses must be red here, not in Wave 5.
//
// Ownership note: `scripts/test/**` is U0.01's owned path; the G0 integrator adds files to it (PLAN §5 rule 2,
// recorded in docs/v3/gates/G0.md).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { fileNameOf, SCHEMA_NAMES } from '../gen-schemas.ts';
import { SELF_FIXTURE_VERSION, schemaNameForFixture, selfCheck } from '../schema-compat.ts';
import { REPO_ROOT, test } from './support/tree.ts';

const FIXTURES = join(REPO_ROOT, 'fixtures/schema-compat', SELF_FIXTURE_VERSION);

/** A temp repository root carrying the real `schemas/` and the real golden fixtures. */
function mirror(root: string): void {
  mkdirSync(join(root, 'schemas'), { recursive: true });
  cpSync(join(REPO_ROOT, 'schemas'), join(root, 'schemas'), { recursive: true });
  mkdirSync(join(root, 'fixtures/schema-compat', SELF_FIXTURE_VERSION), { recursive: true });
  cpSync(FIXTURES, join(root, 'fixtures/schema-compat', SELF_FIXTURE_VERSION), { recursive: true });
}

describe('--self on this tree', () => {
  test('every schema compiles under ajv 2020 strict and every golden instance validates', () => {
    const result = selfCheck({ repoRoot: REPO_ROOT });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.schemasChecked).toBe(SCHEMA_NAMES.length);
    expect(result.fixturesChecked).toBeGreaterThanOrEqual(99);
  });
});

describe('a fixture file name names its schema', () => {
  test.for([
    ['event.agent.spawned.json', 'events'],
    ['command.start.json', 'commands'],
    ['document.run-state.json', 'run-state'],
    ['document.command-result.completed.json', 'command-result'],
    ['document.inspect.artifact.json', 'inspect'],
    ['document.auth-status.json', 'auth-status'],
    // Fix round 1: the last resort is SCHEMA_NAMES, not the seven protocol documents. `agent-output` is one of the
    // six of spec 4 AND a schema the AC-07 client reads; before this it could not have a golden instance at all.
    ['document.agent-output.json', 'agent-output'],
    ['schema.agent-output.json', 'agent-output'],
    ['schema.config.json', 'config'],
    ['schema.tool-catalogue.json', 'tool-catalogue'],
    ['schema.run-snapshot-manifest.json', 'run-snapshot-manifest'],
    ['schema.policy-verdict.first-refusal.json', 'policy-verdict'],
  ] as const)('%s -> %s', ([file, expected]) => {
    expect(schemaNameForFixture(file)).toBe(expected);
  });

  test('every published schema is addressable by a golden instance (DESIGN 7.6 checks 3 and 5)', () => {
    for (const name of SCHEMA_NAMES) {
      expect(schemaNameForFixture(`schema.${name}.json`), name).toBe(name);
      expect(schemaNameForFixture(`document.${name}.json`), name).toBe(name);
    }
  });

  test.for([
    'README.md',
    'golden.json',
    'document.not-a-document.json',
    'schema.not-a-schema.json',
    'other.thing.json',
  ])('%s names no schema', (file) => {
    expect(schemaNameForFixture(file)).toBeUndefined();
  });

  test('a fixture named for a schema that is no protocol document is validated, not refused', ({ tree }) => {
    mirror(tree.root);
    const dir = join(tree.root, 'fixtures/schema-compat', SELF_FIXTURE_VERSION);
    // `auth-status` is a protocol document under both spellings; the point here is the `schema.` kind itself, and a
    // real golden instance keeps the assertion about the whole pipeline (resolve -> compile -> validate).
    cpSync(join(dir, 'document.auth-status.json'), join(dir, 'schema.auth-status.json'));

    const baseline = selfCheck({ repoRoot: REPO_ROOT });
    const result = selfCheck({ repoRoot: tree.root });
    expect(result.problems).toEqual([]);
    expect(result.fixturesChecked).toBe(baseline.fixturesChecked + 1);
  });
});

describe('--self fails loudly rather than quietly', () => {
  test('a schema ajv strict cannot compile is a `compile` problem', ({ tree }) => {
    mirror(tree.root);
    const path = join(tree.root, 'schemas', fileNameOf('spec'));
    const schema = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // ajv strict refuses a keyword it does not know — exactly what a schema-only client would hit.
    schema['x-not-a-keyword'] = { nested: true };
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');

    const result = selfCheck({ repoRoot: tree.root });
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === 'compile' && problem.subject === 'spec')).toBe(true);
  });

  // Fix round 2: the two `JSON.parse` calls used to sit outside their try, so a half-written `schemas/` or fixture
  // directory — exactly what an interrupted regeneration leaves — aborted `--self` with a raw SyntaxError that named
  // no file at all.
  test('a truncated schema file is a `compile` problem naming it, not a raw SyntaxError', ({ tree }) => {
    mirror(tree.root);
    writeFileSync(join(tree.root, 'schemas', fileNameOf('spec')), '{ "type": "object", ', 'utf8');

    const result = selfCheck({ repoRoot: tree.root });
    expect(result.ok).toBe(false);
    const problem = result.problems.find((candidate) => candidate.subject === 'spec');
    expect(problem?.check).toBe('compile');
    expect(problem?.detail).toMatch(/JSON/i);
  });

  test('a truncated golden instance is a `fixture` problem naming it', ({ tree }) => {
    mirror(tree.root);
    const dir = join(tree.root, 'fixtures/schema-compat', SELF_FIXTURE_VERSION);
    writeFileSync(join(dir, 'document.auth-status.json'), '{ "documentVersion": ', 'utf8');

    const baseline = selfCheck({ repoRoot: REPO_ROOT });
    const result = selfCheck({ repoRoot: tree.root });
    expect(result.ok).toBe(false);
    const problem = result.problems.find((candidate) => candidate.subject === 'document.auth-status.json');
    expect(problem?.check).toBe('fixture');
    expect(problem?.detail).toMatch(/JSON/i);
    // The unreadable file is not counted as checked, and every other fixture still is.
    expect(result.fixturesChecked).toBe(baseline.fixturesChecked - 1);
  });

  test('a missing schema file is a `compile` problem naming it', ({ tree }) => {
    mirror(tree.root);
    rmSync(join(tree.root, 'schemas', fileNameOf('events')));

    const result = selfCheck({ repoRoot: tree.root });
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({
      check: 'compile',
      subject: 'events',
      detail: 'no such file; run `pnpm gen:schemas`',
    });
  });

  test('a golden instance that violates its schema is a `fixture` problem', ({ tree }) => {
    mirror(tree.root);
    const path = join(tree.root, 'fixtures/schema-compat', SELF_FIXTURE_VERSION, 'document.auth-status.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // A published schema is OPEN — an added field proves nothing. A required field of the wrong type does.
    document.documentVersion = 'one';
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    const result = selfCheck({ repoRoot: tree.root });
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.subject === 'document.auth-status.json')).toBe(true);
  });

  test('a fixture whose name names no schema is a problem, never a silent skip', ({ tree }) => {
    mirror(tree.root);
    writeFileSync(
      join(tree.root, 'fixtures/schema-compat', SELF_FIXTURE_VERSION, 'stray.json'),
      '{"anything": true}\n',
      'utf8',
    );

    const result = selfCheck({ repoRoot: tree.root });
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({
      check: 'fixture',
      subject: 'stray.json',
      detail: 'no schema is named by this file name',
    });
  });

  test('a missing fixture directory is a problem', ({ tree }) => {
    mkdirSync(join(tree.root, 'schemas'), { recursive: true });
    cpSync(join(REPO_ROOT, 'schemas'), join(tree.root, 'schemas'), { recursive: true });

    const result = selfCheck({ repoRoot: tree.root });
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.check === 'fixture')).toBe(true);
  });
});
