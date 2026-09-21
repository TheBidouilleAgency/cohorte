import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { checkLayers, loadLayers, type RuleId, scanImports, validateLayers } from '../check-layers.ts';
import { REPO_ROOT, test } from './support/tree.ts';

const LAYERS_PATH = join(REPO_ROOT, 'layers.json');
const layers = loadLayers(LAYERS_PATH);

/** A tree in which every rule has something legal to look at. */
const CLEAN_TREE: Readonly<Record<string, string>> = {
  'packages/base/src/index.ts': "import { Type } from 'typebox';\nexport const T = Type.String();\n",
  'packages/protocol/src/index.ts': "export type { BudgetCounters } from '@cohorte/base';\n",
  'packages/tools/src/journal.ts': [
    "import type { EffectRecord } from '@cohorte/persistence/contract';",
    "import { resolve } from '@cohorte/security/decide/paths';",
    'export const x = (r: EffectRecord) => resolve(String(r));',
    '',
  ].join('\n'),
  'packages/core/src/engine.ts': [
    "import { join } from 'node:path';",
    "import type { StateStore } from '@cohorte/persistence';",
    "import { nextStep } from './pipeline/next.ts';",
    '// a comment may say import("x") and as Sealed without being code',
    'export const text = \'import { x } from "@cohorte/runtime-pi"\';',
    'export const run = (s: StateStore) => join(String(s), String(nextStep), import.meta.dirname);',
    '',
  ].join('\n'),
  'packages/core/src/pipeline/next.ts': 'export const nextStep = 1;\n',
  'packages/core/test/engine.test.ts': [
    "import { createMemoryStateStore } from '@cohorte/persistence/memory';",
    "import { createFakeRuntimeProvider } from '@cohorte/runtime-fake';",
    "import { fixedClock } from '@cohorte/testkit';",
    "import { test } from 'vitest';",
    'test("x", async () => { await import("../src/engine.ts"); void createMemoryStateStore; void createFakeRuntimeProvider; void fixedClock; });',
    '',
  ].join('\n'),
  // Rule g is about shipped code: a test may load lazily, under either name.
  'packages/git/test/load.test.ts': [
    "import { createRequire } from 'node:module';",
    'const load = createRequire(import.meta.url);',
    'void [load(`yaml`), await import(`node:fs`)];',
    '',
  ].join('\n'),
  'packages/core/src/colocated.test.ts': "import { fixedClock } from '@cohorte/testkit';\nvoid fixedClock;\n",
  'packages/core/src/colocated.itest.ts': "import { fixedClock } from '@cohorte/testkit';\nvoid fixedClock;\n",
  // A rename in a specifier list is not the cast of rule f.
  'packages/core/src/brand.ts': [
    "import type { Sealed as SealedBrand } from '@cohorte/base';",
    "import * as SealedNamespace from '@cohorte/base';",
    "export type { Sealed as SealedAlias } from '@cohorte/base';",
    "export * as SealedAll from '@cohorte/base';",
    'export type Brand = SealedBrand<string>;',
    'void SealedNamespace;',
    '',
  ].join('\n'),
  'packages/runtime-contract/src/conformance/index.ts':
    "import { describe } from 'vitest';\nexport const d = describe;\n",
  'packages/runtime-pi/src/child/load-pi.ts':
    "export const loadPi = () => import('@earendil-works/pi-coding-agent');\n",
  'packages/runtime-pi/src/child/entry.ts':
    "import type { AgentSession } from '@earendil-works/pi-coding-agent';\nexport type S = AgentSession;\n",
  'packages/runtime-pi/test/tripwires/tw-api.itest.ts': "import * as pi from '@earendil-works/pi-ai';\nvoid pi;\n",
  'packages/security/src/redact/seal.ts': 'export const seal = (s: string) => s as Sealed<string>;\n',
  'packages/testkit/src/fake-redactor/index.ts': [
    "import { test } from 'vitest';",
    'export const fake = (s: string) => s as SealedText;',
    "export const lazy = () => import('node:fs');",
    'void test;',
    '',
  ].join('\n'),
  'apps/cli/src/lazy.ts': "export const loadRun = () => import('./commands/run/index.ts');\n",
  'apps/cli/src/commands/run/index.ts':
    "import { Command } from 'commander';\nimport { x } from '@cohorte/core';\nexport const c = [Command, x];\n",
};

/** One planted violation per rule: [rule, file, content, fragment expected in the message]. */
const PLANTS: ReadonlyArray<readonly [RuleId, string, string, string]> = [
  ['a', 'packages/git/src/bad.ts', "import { x } from '@cohorte/security';\nvoid x;\n", '@cohorte/security'],
  [
    'a',
    'packages/git/src/bad.ts',
    "import { x } from '@cohorte/security/decide/paths';\nvoid x;\n",
    '@cohorte/security',
  ],
  ['a', 'packages/protocol/src/bad.ts', "export * from '@cohorte/runtime-contract';\n", '@cohorte/runtime-contract'],
  ['a', 'packages/base/src/bad.ts', "import { parse } from 'yaml';\nvoid parse;\n", 'yaml'],
  ['a', 'packages/runtime-contract/src/bad.ts', "import { test } from 'vitest';\nvoid test;\n", 'vitest'],
  ['a', 'packages/git/src/bad.ts', "import { x } from '../../security/src/index.ts';\nvoid x;\n", 'leaves'],
  ['a', 'packages/git/test/bad.test.ts', "import { x } from '@cohorte/core';\nvoid x;\n", '@cohorte/core'],
  [
    'b',
    'packages/runtime-pi/src/parent/bad.ts',
    "import type { A } from '@earendil-works/pi-ai';\nexport type B = A;\n",
    '@earendil-works/',
  ],
  [
    'b',
    'apps/cli/src/bad.ts',
    "import * as pi from '@earendil-works/pi-coding-agent';\nvoid pi;\n",
    '@earendil-works/',
  ],
  // Rule b has no scope: the suites, the scripts and the fixtures are not packages, and still may not name the engine.
  ['b', 'tests/e2e/bad.e2e.ts', "import * as pi from '@earendil-works/pi-ai';\nvoid pi;\n", '@earendil-works/'],
  [
    'b',
    'scripts/bad.ts',
    "const pi = await import('@earendil-works/pi-coding-agent');\nvoid pi;\n",
    '@earendil-works/',
  ],
  [
    'b',
    'fixtures/repos/demo/build.ts',
    "import type { A } from '@earendil-works/pi-agent-core';\nexport type B = A;\n",
    '@earendil-works/',
  ],
  // apps/cli declares Pi, so these three RESOLVE from its tests: the scanner is the only thing in the way.
  // A template without `${}` is a string literal, and createRequire is `require` under another name.
  [
    'b',
    'apps/cli/test/bad.test.ts',
    'const pi = await import(`@earendil-works/pi-ai`);\nvoid pi;\n',
    '@earendil-works/',
  ],
  [
    'b',
    'apps/cli/test/bad.test.ts',
    "import { createRequire } from 'node:module';\nconst pi = createRequire(import.meta.url)('@earendil-works/pi-ai');\nvoid pi;\n",
    '@earendil-works/',
  ],
  [
    'b',
    'apps/cli/test/bad.test.ts',
    "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst pi = load('@earendil-works/pi-ai');\nvoid pi;\n",
    '@earendil-works/',
  ],
  ['c', 'packages/core/src/bad.ts', "import { readFileSync } from 'node:fs';\nvoid readFileSync;\n", 'node:fs'],
  // Under src/ only *.test.ts and *.itest.ts are test scope, exactly what the package tsconfigs exclude:
  // `tsc -b` compiles src/x.live.ts and src/x.e2e.ts as shipped code, so the shipped-code rules apply.
  ['c', 'packages/core/src/probe.live.ts', "import { readFileSync } from 'node:fs';\nvoid readFileSync;\n", 'node:fs'],
  ['c', 'packages/core/src/bad.ts', "import { spawn } from 'child_process';\nvoid spawn;\n", 'child_process'],
  ['c', 'packages/core/src/bad.ts', "import type { Socket } from 'node:net';\nexport type S = Socket;\n", 'node:net'],
  [
    'c',
    'packages/core/src/bad.ts',
    "import { setTimeout } from 'node:timers/promises';\nvoid setTimeout;\n",
    'node:timers/promises',
  ],
  [
    'd',
    'packages/git/src/bad.ts',
    "import { fixedClock } from '@cohorte/testkit';\nvoid fixedClock;\n",
    '@cohorte/testkit',
  ],
  [
    'd',
    'packages/tools/src/bad.ts',
    "import { EffectRecord } from '@cohorte/persistence/contract';\nvoid EffectRecord;\n",
    'import type',
  ],
  [
    'd',
    'packages/tools/src/bad.ts',
    "import { type EffectRecord } from '@cohorte/persistence/contract';\nexport type E = EffectRecord;\n",
    'import type',
  ],
  [
    'd',
    'packages/tools/src/bad.ts',
    "import type { StateStore } from '@cohorte/persistence';\nexport type S = StateStore;\n",
    './contract',
  ],
  [
    'd',
    'packages/core/src/bad.ts',
    "import { createMemoryStateStore } from '@cohorte/persistence/memory';\nvoid createMemoryStateStore;\n",
    'import type',
  ],
  [
    'e',
    'packages/runtime-pi/src/child/bad.ts',
    'export const t = (s: { readStoredCredential(): string }) => s.readStoredCredential();\n',
    'readStoredCredential',
  ],
  [
    'd',
    'packages/core/src/probe.e2e.ts',
    "import { fixedClock } from '@cohorte/testkit';\nvoid fixedClock;\n",
    '@cohorte/testkit',
  ],
  ['a', 'packages/base/src/probe.live.ts', "import { test } from 'vitest';\nvoid test;\n", 'vitest'],
  ['e', 'apps/cli/src/bad.ts', "export const flag = '--print-bearer-token';\n", 'print-bearer-token'],
  ['e', 'tests/e2e/bad.e2e.ts', '// pi auth print-api-key would leak the key\nexport const a = 1;\n', 'print-api-key'],
  [
    'e',
    'packages/runtime-pi/src/parent/bad.ts',
    'export const t = (m: { getAuth(): string }) => m.getAuth();\n',
    '.getAuth(',
  ],
  ['f', 'packages/core/src/bad.ts', 'export const s = (x: string) => x as Sealed<string>;\n', 'as Sealed'],
  ['f', 'packages/core/test/bad.test.ts', 'export const s = (x: string) => x as SealedText;\n', 'as Sealed'],
  ['g', 'packages/core/src/bad.ts', "export const l = () => import('./pipeline/next.ts');\n", 'import('],
  ['g', 'apps/cli/src/commands/run/bad.ts', 'export const l = (p: string) => import(p);\n', 'import('],
  ['g', 'packages/core/src/probe.live.ts', "export const l = () => import('./pipeline/next.ts');\n", 'import('],
  // The same escape hatch under its CommonJS name: a module loaded at a moment and from a place the bundler never saw.
  [
    'g',
    'apps/cli/src/commands/run/bad.ts',
    "import { createRequire } from 'node:module';\nexport const load = createRequire(import.meta.url);\n",
    'createRequire',
  ],
  [
    'g',
    'packages/security/src/bad.ts',
    "import * as nodeModule from 'node:module';\nexport const load = nodeModule.createRequire(import.meta.url);\n",
    'createRequire',
  ],
  ['h', 'apps/cli/src/compose/bad.ts', 'export const o = { entryOverride: "/tmp/x" };\n', 'entryOverride'],
];

describe('scanImports', () => {
  test('classifies static, type-only, re-exported, side-effect and dynamic imports', () => {
    const found = scanImports(
      [
        "import a, { b } from 'value-mod';",
        "import type { C } from 'type-mod';",
        "import { type D } from 'inline-type-mod';",
        "import 'side-effect-mod';",
        "export * from 'reexport-all';",
        "export { e as f } from 'reexport-named';",
        "export type { G } from 'reexport-type';",
        "const h = await import('dynamic-mod');",
        'const i = await import(variable);',
        "import {\n  j,\n  k,\n} from 'multi-line-mod';",
        "const req = require('required-mod');",
        'const t = await import(`template-mod`);',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the scanned SOURCE contains a template literal
        'const u = await import(`computed-${name}`);',
        "const direct = createRequire(import.meta.url)('create-require-mod');",
        'const load = createRequire(join(root, "package.json"));',
        "const aliased = load('aliased-require-mod');",
        "const path = load.resolve('resolved-only');",
      ].join('\n'),
    );
    expect(found.map((r) => [r.specifier, r.kind, r.line])).toEqual([
      ['value-mod', 'value', 1],
      ['type-mod', 'type', 2],
      ['inline-type-mod', 'value', 3],
      ['side-effect-mod', 'value', 4],
      ['reexport-all', 'value', 5],
      ['reexport-named', 'value', 6],
      ['reexport-type', 'type', 7],
      ['dynamic-mod', 'dynamic', 8],
      [null, 'dynamic', 9],
      ['multi-line-mod', 'value', 10],
      ['required-mod', 'value', 14],
      ['template-mod', 'dynamic', 15],
      [null, 'dynamic', 16],
      ['create-require-mod', 'value', 17],
      ['aliased-require-mod', 'value', 19],
    ]);
  });

  test('ignores comments, strings, templates, regular expressions, import.meta and member names', () => {
    const found = scanImports(
      [
        "// import x from 'line-comment';",
        "/* import y from 'block-comment'; import('z') */",
        'const s = "import q from \'in-string\'";',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the scanned SOURCE contains a template literal
        "const t = `import('in-template') ${'import w from \"nested\"'}`;",
        "const p = `import('in-plain-template')\nimport z from 'still-in-template'`;",
        "const r = /import\\('in-regex'\\)/;",
        'const d = import.meta.dirname;',
        "const m = loader.import('member-call');",
        'export const local = 1;',
        'export { s, t };',
      ].join('\n'),
    );
    expect(found).toEqual([]);
  });
});

describe('layers.json', () => {
  test('describes sixteen packages, two type-only edges, and testkit as a dev edge of every other package', () => {
    const names = Object.keys(layers.packages);
    expect(names).toHaveLength(16);
    const typeOnly = names.flatMap((n) => Object.keys(layers.packages[n]?.typeOnly ?? {}).map((to) => `${n} -> ${to}`));
    expect(typeOnly.sort()).toEqual([
      '@cohorte/core -> @cohorte/persistence',
      '@cohorte/tools -> @cohorte/persistence',
    ]);
    for (const name of names.filter((n) => n !== '@cohorte/testkit')) {
      expect(layers.packages[name]?.dev, name).toContain('@cohorte/testkit');
    }
    expect(layers.packages['@cohorte/core']?.dev).toEqual(
      expect.arrayContaining(['@cohorte/runtime-fake', '@cohorte/persistence']),
    );
  });

  test('forbids the edges DESIGN 1.2 calls out by name', () => {
    const edges = (n: string) => [
      ...(layers.packages[n]?.normal ?? []),
      ...Object.keys(layers.packages[n]?.typeOnly ?? {}),
    ];
    expect(edges('@cohorte/config')).not.toContain('@cohorte/security');
    expect(edges('@cohorte/config')).not.toContain('@cohorte/runtime-contract');
    expect(edges('@cohorte/security')).not.toContain('@cohorte/protocol');
    expect(edges('@cohorte/protocol')).not.toContain('@cohorte/runtime-contract');
    expect(edges('@cohorte/runtime-contract')).not.toContain('@cohorte/protocol');
    expect(edges('@cohorte/core')).not.toContain('@cohorte/runtime-pi');
    expect(edges('@cohorte/core')).not.toContain('@cohorte/runtime-fake');
    expect(layers.packages['@cohorte/tools']?.thirdParty).not.toContain('picomatch');
  });

  // DESIGN 1.2: nothing imports upward, L1 packages never import each other, same-layer edges exist only
  // inside L2, and the dev layer is reachable through dev edges alone. Computed here from the `layer`
  // field, independently of validateLayers, so that the data and the validator are both held to it.
  test('every normal and typeOnly edge of the real file goes down the layers of DESIGN 1.2', () => {
    const rank = (name: string) => ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].indexOf(layers.packages[name]?.layer ?? '');
    const offending: string[] = [];
    for (const [name, entry] of Object.entries(layers.packages)) {
      if (entry.layer !== 'dev') expect(rank(name), `${name} has the unknown layer ${entry.layer}`).not.toBe(-1);
      for (const target of [...entry.normal, ...Object.keys(entry.typeOnly)]) {
        const down = rank(target) !== -1 && (entry.layer === 'dev' || rank(target) < rank(name));
        const insideL2 = rank(name) === 2 && rank(target) === 2;
        if (!down && !insideL2) offending.push(`${name} -> ${target}`);
      }
    }
    expect(offending).toEqual([]);
    expect(validateLayers(layers)).toEqual([]);
  });

  test.for([
    ['an upward edge', '@cohorte/security', 'normal', '@cohorte/tools', /security \(L2\) -> @cohorte\/tools \(L3\)/],
    ['an upward typeOnly edge', '@cohorte/git', 'typeOnly', '@cohorte/core', /git \(L2\) -> @cohorte\/core \(L4\)/],
    ['an L1 -> L1 edge', '@cohorte/protocol', 'normal', '@cohorte/runtime-contract', /protocol \(L1\) -> .* \(L1\)/],
    ['a normal edge into the dev layer', '@cohorte/git', 'normal', '@cohorte/testkit', /testkit .*dev edge/],
    ['a typeOnly edge into the dev layer', '@cohorte/core', 'typeOnly', '@cohorte/testkit', /testkit .*dev edge/],
  ] as const)('validateLayers refuses %s', ([, from, kind, to, message]) => {
    const broken = structuredClone(layers);
    const entry = broken.packages[from];
    if (kind === 'normal') entry?.normal.push(to);
    else if (entry) entry.typeOnly[to] = ['.'];
    expect(validateLayers(broken).join('\n')).toMatch(message);
  });

  test('validateLayers accepts a new edge inside L2 and a new downward edge, and refuses an unknown layer', () => {
    const extended = structuredClone(layers);
    extended.packages['@cohorte/telemetry']?.normal.push('@cohorte/config');
    extended.packages['@cohorte/git']?.normal.push('@cohorte/protocol');
    expect(validateLayers(extended)).toEqual([]);

    const unknown = structuredClone(layers);
    const base = unknown.packages['@cohorte/base'];
    if (base) base.layer = 'L9';
    expect(validateLayers(unknown).join('\n')).toMatch(/@cohorte\/base: unknown layer L9/);
  });

  test('rejects a layers file with an edge to an unknown package', async ({ tree }) => {
    const broken = structuredClone(layers);
    broken.packages['@cohorte/base']?.normal.push('@cohorte/nowhere');
    await tree.write({ 'layers.json': JSON.stringify(broken) });
    expect(() => loadLayers(join(tree.root, 'layers.json'))).toThrow(/@cohorte\/nowhere/);
  });
});

describe('checkLayers', () => {
  test('passes a clean tree', async ({ tree }) => {
    await tree.write(CLEAN_TREE);
    const result = checkLayers({ root: tree.root, layers });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBe(Object.keys(CLEAN_TREE).length);
  });

  test.for(PLANTS)('rule %s catches %s', async ([rule, file, content, fragment], { tree }) => {
    await tree.write({ ...CLEAN_TREE, [file]: content });
    const { violations } = checkLayers({ root: tree.root, layers });
    expect(violations.map((v) => `${v.rule} ${v.file}`)).toEqual([`${rule} ${file}`]);
    expect(violations[0]?.message).toContain(fragment);
    expect(violations[0]?.line).toBeGreaterThan(0);
  });

  // apps/cli declares Pi (the silent-inlining guard), so this load would WORK from the CLI's own sources.
  test('a Pi load through createRequire in shipped code trips the lazy-load rule and the confinement rule', async ({
    tree,
  }) => {
    await tree.write({
      ...CLEAN_TREE,
      'apps/cli/src/commands/run/bad.ts': [
        "import { createRequire } from 'node:module';",
        '',
        "export const pi = createRequire(import.meta.url)('@earendil-works/pi-ai');",
        '',
      ].join('\n'),
    });
    const { violations } = checkLayers({ root: tree.root, layers });
    expect(violations.map((v) => [v.rule, v.line, v.specifier])).toEqual([
      ['g', 1, undefined],
      ['b', 3, '@earendil-works/pi-ai'],
    ]);
  });

  test('rule f reports the cast and not the rename that brought the name in', async ({ tree }) => {
    await tree.write({
      ...CLEAN_TREE,
      'packages/core/src/bad.ts': [
        "import type { Sealed as SealedBrand } from '@cohorte/base';",
        '',
        'export const mint = (x: string) => x as SealedBrand<string>;',
        '',
      ].join('\n'),
    });
    const { violations } = checkLayers({ root: tree.root, layers });
    expect(violations.map((v) => [v.rule, v.file, v.line])).toEqual([['f', 'packages/core/src/bad.ts', 3]]);
  });

  test('every rule a-h has at least one planted violation', () => {
    expect([...new Set(PLANTS.map(([rule]) => rule))].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  test("core's test-only edges resolve from test/** and fail from src/**", async ({ tree }) => {
    const imports = [
      "import * as fake from '@cohorte/runtime-fake';",
      "import * as persistence from '@cohorte/persistence';",
      "import * as testkit from '@cohorte/testkit';",
      'void [fake, persistence, testkit];',
      '',
    ].join('\n');
    await tree.write({ 'packages/core/test/canary.edges.test.ts': imports });
    expect(checkLayers({ root: tree.root, layers }).violations).toEqual([]);

    await tree.write({ 'packages/core/src/planted.ts': imports });
    const { violations } = checkLayers({ root: tree.root, layers });
    expect(violations.map((v) => [v.rule, v.file, v.specifier])).toEqual([
      ['d', 'packages/core/src/planted.ts', '@cohorte/runtime-fake'],
      ['d', 'packages/core/src/planted.ts', '@cohorte/persistence'],
      ['d', 'packages/core/src/planted.ts', '@cohorte/testkit'],
    ]);
  });

  test('skips excluded directories', async ({ tree }) => {
    const bad = "import { x } from '@cohorte/core';\nvoid x;\n";
    await tree.write({
      'packages/base/src/index.ts': 'export {};\n',
      'packages/base/node_modules/dep/src/x.ts': bad,
      'packages/base/dist/x.ts': bad,
      'vendor/retired/packages/base/src/x.ts': bad,
      '.build/u/packages/base/src/x.ts': bad,
      '.cohorte/worktrees/w/packages/base/src/x.ts': bad,
    });
    const result = checkLayers({ root: tree.root, layers });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });
});

describe('command line', () => {
  const run = (root: string) =>
    spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/check-layers.ts'), '--root', root, '--layers', LAYERS_PATH], {
      encoding: 'utf8',
    });

  test('exits 0 on a clean tree', async ({ tree }) => {
    await tree.write(CLEAN_TREE);
    const done = run(tree.root);
    expect(done.stderr).toBe('');
    expect(done.status).toBe(0);
    expect(done.stdout).toContain('check-layers: OK');
  });

  test('exits 1 and names rule, file and line for each violation', async ({ tree }) => {
    await tree.write({
      ...CLEAN_TREE,
      'packages/core/src/bad.ts': "\nimport { readFileSync } from 'node:fs';\nvoid readFileSync;\n",
    });
    const done = run(tree.root);
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('packages/core/src/bad.ts:2');
    expect(done.stderr).toContain('[c]');
  });
});
