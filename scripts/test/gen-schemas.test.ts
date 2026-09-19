// Gate G0 (PLAN U0.G). The published schemas ARE the contract a schema-only client reads (DESIGN 0.1 C3, 7.5
// AC-07), so what is pinned here is: the generator is total over the list DESIGN names, `--check` is a real byte
// comparison in both directions, and no PROTOCOL schema names the engine.
//
// Ownership note: `scripts/test/**` is U0.01's owned path; the G0 integrator adds files to it (PLAN §5 rule 2,
// recorded in docs/v3/gates/G0.md) because a script's tests live beside the other script tests.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import {
  fileNameOf,
  generateSchemas,
  openDocument,
  PROTOCOL_SCHEMA_NAMES,
  SCHEMA_NAMES,
  SCHEMA_SOURCES,
  schemaId,
  serialize,
} from '../gen-schemas.ts';
import { REPO_ROOT, test } from './support/tree.ts';

const SCHEMAS_DIR = join(REPO_ROOT, 'schemas');

const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(SCHEMAS_DIR, fileNameOf(name)), 'utf8')) as Record<string, unknown>;

/** A temp repository root holding a copy of the real `schemas/`: `--check` there sees exactly what it sees here. */
async function mirrorSchemas(root: string): Promise<void> {
  mkdirSync(join(root, 'schemas'), { recursive: true });
  cpSync(SCHEMAS_DIR, join(root, 'schemas'), { recursive: true });
}

describe('the generated set is the one DESIGN names', () => {
  test('every schema of PLAN U0.G is generated, and nothing else', () => {
    // The six of spec 4, the protocol documents, and the standalone [S] shapes of DESIGN 2.6/2.9/2.10, plus
    // `fake-script` — the [S] shape of DESIGN 3.10, added at gate G1 (PLAN U1.INT: "gen-schemas adds
    // fake-script.schema.json"; docs/v3/requests/U1.06.md R5).
    expect([...SCHEMA_NAMES].sort()).toEqual([
      'agent-output',
      'auth-status',
      'command-result',
      'commands',
      'config',
      'doctor-report',
      'events',
      'fake-script',
      'inspect',
      'manifest',
      'ownership',
      'policy-verdict',
      'project-model',
      'project-status',
      'reconcile-plan',
      'run-diff',
      'run-snapshot-manifest',
      'run-state',
      'runtime-capabilities',
      'sandbox-capabilities',
      'skill',
      'spec',
      'tool-catalogue',
      'trust-record',
    ]);
  });

  test('every source builds a 2020-12 document with its own stable $id and a title', () => {
    for (const source of SCHEMA_SOURCES) {
      const built = source.build() as Record<string, unknown>;
      expect(built.$schema, source.name).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(built.$id, source.name).toBe(schemaId(source.name));
      expect(typeof built.title, source.name).toBe('string');
    }
  });

  // Fix round 1: `{ $schema, $id, title, ...open }` let an authored `title` win silently — and only `$schema` and
  // `$id` were asserted per source above, so nobody would have noticed. The generator owns all three.
  test('an authored $schema, $id or title never wins over the published one, and the key order is unchanged', () => {
    const built = openDocument('spec', 'the title the generator assigns', {
      $schema: 'https://example.invalid/authored-dialect',
      $id: 'urn:authored',
      title: 'a title the author assigned',
      type: 'object',
      properties: { a: { type: 'string' } },
    }) as Record<string, unknown>;

    expect(built.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(built.$id).toBe(schemaId('spec'));
    expect(built.title).toBe('the title the generator assigns');
    expect(Object.keys(built).slice(0, 3)).toEqual(['$schema', '$id', 'title']);
  });

  test('the files on disk are exactly what the sources build', () => {
    const files = readdirSync(SCHEMAS_DIR).sort();
    expect(files).toEqual(SCHEMA_NAMES.map(fileNameOf).sort());
    for (const source of SCHEMA_SOURCES) {
      expect(readFileSync(join(SCHEMAS_DIR, fileNameOf(source.name)), 'utf8'), source.name).toBe(
        serialize(source.build()),
      );
    }
  });

  test('a published document is OPEN: no closed object, and an open enum lost its `enum`', () => {
    const openEnumsKeepNoEnum = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      if (Array.isArray(node)) {
        for (const member of node) openEnumsKeepNoEnum(member);
        return;
      }
      const record = node as Record<string, unknown>;
      expect(record.additionalProperties).not.toBe(false);
      if ('x-cohorte-known' in record) expect('enum' in record).toBe(false);
      for (const value of Object.values(record)) openEnumsKeepNoEnum(value);
    };
    for (const name of SCHEMA_NAMES) openEnumsKeepNoEnum(read(name));
  });
});

describe('--check is a byte comparison, never a `git diff` (PLAN F-2)', () => {
  test('the committed schemas/ is up to date', async () => {
    const result = await generateSchemas({ repoRoot: REPO_ROOT, check: true });
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // A TypeBox source that changes without regeneration moves the GENERATED side of that comparison; a hand-edited
  // file moves the DISK side. The check has no other input than those two, so either divergence is the same failure,
  // and only the second can be staged from a test.
  test('a schema that no longer matches its TypeBox source is reported as `different`', async ({ tree }) => {
    await mirrorSchemas(tree.root);
    const path = join(tree.root, 'schemas/events.schema.json');
    const tampered = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    tampered.title = 'a title the TypeBox source does not carry';
    writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    const result = await generateSchemas({ repoRoot: tree.root, check: true });
    expect(result.ok).toBe(false);
    expect(result.differences).toEqual([{ file: 'events.schema.json', reason: 'different' }]);
  });

  test('a deleted schema is `missing` and a stale one is `unexpected`', async ({ tree }) => {
    await mirrorSchemas(tree.root);
    rmSync(join(tree.root, 'schemas/spec.schema.json'));
    writeFileSync(join(tree.root, 'schemas/retired.schema.json'), '{}\n', 'utf8');

    const result = await generateSchemas({ repoRoot: tree.root, check: true });
    expect(result.ok).toBe(false);
    expect([...result.differences].sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: 'retired.schema.json', reason: 'unexpected' },
      { file: 'spec.schema.json', reason: 'missing' },
    ]);
  });

  test('write mode restores the tampered file and removes the stale one, then --check is green', async ({ tree }) => {
    await mirrorSchemas(tree.root);
    writeFileSync(join(tree.root, 'schemas/spec.schema.json'), '{}\n', 'utf8');
    writeFileSync(join(tree.root, 'schemas/retired.schema.json'), '{}\n', 'utf8');

    const written = await generateSchemas({ repoRoot: tree.root, check: false });
    expect(written.written).toEqual(['spec.schema.json']);
    expect(written.removed).toEqual(['retired.schema.json']);
    expect(await generateSchemas({ repoRoot: tree.root, check: true })).toMatchObject({ ok: true });
  });

  test('it generates into an empty tree', async ({ tree }) => {
    const result = await generateSchemas({ repoRoot: tree.root, check: false });
    expect(result.written).toHaveLength(SCHEMA_NAMES.length);
    expect(readdirSync(join(tree.root, 'schemas')).sort()).toEqual(SCHEMA_NAMES.map(fileNameOf).sort());
  });

  // Fix round 2: the flag was spelled `--out` and used as a repository ROOT, in a repository where
  // `scripts/build.ts --out` means an output directory. `--root` is what `scripts/schema-compat.ts` already calls it.
  describe('the CLI names the repository root `--root`', () => {
    const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/gen-schemas.ts'), ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };

    test('`--root <dir>` writes that tree, and `--root <dir> --check` then passes there', ({ tree }) => {
      const written = run('--root', tree.root);
      expect(written.stderr).toBe('');
      expect(written.status).toBe(0);
      expect(readdirSync(join(tree.root, 'schemas')).sort()).toEqual(SCHEMA_NAMES.map(fileNameOf).sort());

      const checked = run('--root', tree.root, '--check');
      expect(checked.status).toBe(0);
      expect(checked.stdout).toContain(`${SCHEMA_NAMES.length} schema(s) up to date`);
    });

    test('the old `--out` spelling is refused rather than silently ignored', ({ tree }) => {
      const result = run('--out', tree.root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--out');
      expect(readdirSync(tree.root)).toEqual([]);
    });
  });
});

// DESIGN 7.5 AC-07 / ADR-0005 item 7. The scan covers the schemas generated from `@cohorte/protocol` and
// `@cohorte/runtime-contract` and NOTHING else: `config.schema.json` legitimately carries `runtime.pi` and
// `authentication.anthropicSubscriptionViaPi`, so scanning `schemas/**` would make this gate red by construction.
describe('AC-07 seed: no engine identifier in a PROTOCOL schema', () => {
  const words = (text: string): string[] =>
    (text.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []).map((word) => word.toLowerCase());

  const enginePresence = (node: unknown, path: string, hits: string[]): void => {
    const look = (text: string, where: string): void => {
      const found = words(text);
      if (found.includes('pi') || found.includes('earendil')) hits.push(`${where}: ${JSON.stringify(text)}`);
    };
    if (typeof node === 'string') {
      look(node, path);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((member, index) => {
        enginePresence(member, `${path}/${index}`, hits);
      });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      look(key, `${path}/${key}`);
      enginePresence(value, `${path}/${key}`, hits);
    }
  };

  test('the scanned list is the protocol + runtime-contract set, and config is outside it', () => {
    expect([...PROTOCOL_SCHEMA_NAMES].sort()).toEqual([
      'agent-output',
      'auth-status',
      'command-result',
      'commands',
      'doctor-report',
      'events',
      'inspect',
      'project-status',
      'run-diff',
      'run-state',
      'runtime-capabilities',
    ]);
    expect(PROTOCOL_SCHEMA_NAMES).not.toContain('config');
  });

  test('the scan itself catches an engine identifier where one exists', () => {
    const hits: string[] = [];
    enginePresence({ runtime: { pi: { loadFrom: '@earendil-works/pi-coding-agent' } } }, '', hits);
    expect(hits.length).toBeGreaterThan(0);
  });

  for (const name of PROTOCOL_SCHEMA_NAMES) {
    test(`${name}.schema.json names no engine`, () => {
      const hits: string[] = [];
      enginePresence(read(name), '', hits);
      expect(hits).toEqual([]);
    });
  }
});
