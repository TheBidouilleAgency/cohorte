import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { generateUnitChecks } from '../gen-unit-checks.ts';
import { createOwnedMatcher, parseTscOutput, runUnitCheck, SELF_TEST_UNIT, selfTestTree } from '../unit-check.ts';
import { REPO_ROOT, type TempTree, test } from './support/tree.ts';

const SLOW = 120_000;

async function plant(tree: TempTree, overrides: Readonly<Record<string, string>> = {}): Promise<void> {
  await tree.write({ ...selfTestTree(REPO_ROOT), ...overrides });
  await tree.linkNodeModules();
  generateUnitChecks({ root: tree.root });
}

const quiet = { write: () => {} };

describe('parseTscOutput', () => {
  test('reads file diagnostics, attaches continuation lines, and keeps global diagnostics', () => {
    const diagnostics = parseTscOutput(
      [
        "packages/a/src/x.ts(3,7): error TS2322: Type 'number' is not assignable to type 'string'.",
        "  Type 'number' has no properties in common.",
        'packages/b/src/y.ts(10,1): error TS2304: Cannot find name "z".',
        "error TS18003: No inputs were found in config file 'tsconfig.json'.",
        '',
      ].join('\n'),
    );
    expect(diagnostics).toEqual([
      {
        file: 'packages/a/src/x.ts',
        line: 3,
        column: 7,
        code: 'TS2322',
        message: "Type 'number' is not assignable to type 'string'.\n  Type 'number' has no properties in common.",
      },
      { file: 'packages/b/src/y.ts', line: 10, column: 1, code: 'TS2304', message: 'Cannot find name "z".' },
      {
        file: null,
        line: 0,
        column: 0,
        code: 'TS18003',
        message: "No inputs were found in config file 'tsconfig.json'.",
      },
    ]);
  });
});

describe('createOwnedMatcher', () => {
  const owned = createOwnedMatcher([
    'packages/core/src/engine/**',
    'packages/*/package.json',
    'apps/cli/src/commands/*/index.ts',
    'packages/runtime-pi/test/tripwires/tw-*.itest.ts',
    'scripts/checkpoint.ts',
  ]);

  test.for([
    ['packages/core/src/engine/loop.ts', true],
    ['packages/core/src/engine/deep/er/x.ts', true],
    ['packages/core/src/engineering/x.ts', false],
    ['packages/core/src/resume/x.ts', false],
    ['packages/base/package.json', true],
    ['packages/base/nested/package.json', false],
    ['apps/cli/src/commands/run/index.ts', true],
    ['apps/cli/src/commands/run/impl.ts', false],
    ['packages/runtime-pi/test/tripwires/tw-api.itest.ts', true],
    ['packages/runtime-pi/test/tripwires/probe-p1.itest.ts', false],
    ['scripts/checkpoint.ts', true],
    ['scripts/checkpoint.test.ts', false],
  ] as const)('%s -> %s', ([path, expected]) => {
    expect(owned(path)).toBe(expected);
  });
});

describe('runUnitCheck', () => {
  test('a clean unit passes, with a private vitest cache directory', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree);
    const result = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(result.tsc).toMatchObject({ ran: true, errors: [], warnings: [] });
    expect(result.biome).toMatchObject({ ran: true, ok: true });
    expect(result.layers).toEqual({ ran: true, errors: [], warnings: [] });
    expect(result.vitest).toMatchObject({ ran: true, ok: true });
    expect(result.ok).toBe(true);
    // vitest.config.ts reads COHORTE_VITEST_CACHE_DIR: vitest itself wrote its results cache in there.
    expect(existsSync(join(tree.root, '.build/.vitest', SELF_TEST_UNIT, 'vitest'))).toBe(true);
    expect(existsSync(join(tree.root, 'packages/owned/dist-types'))).toBe(false);
  });

  test('a type error in a NON-owned file is a warning', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree, {
      'packages/foreign/src/index.ts':
        'export const foreign: number = 1;\nexport const halfWritten: string = 2; // a sibling is mid-edit\n',
    });
    const lines: string[] = [];
    const result = await runUnitCheck({
      root: tree.root,
      unitId: SELF_TEST_UNIT,
      out: { write: (s) => lines.push(s) },
    });
    expect(result.tsc.errors).toEqual([]);
    expect(result.tsc.warnings.map((d) => d.file)).toEqual(['packages/foreign/src/index.ts']);
    expect(result.ok).toBe(true);
    expect(lines.join('')).toMatch(/warning.*packages\/foreign\/src\/index\.ts/);
  });

  test('a type error in an owned file is a failure', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree, { 'packages/owned/src/extra.ts': "export const owned: number = 'wrong';\n" });
    const result = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(result.tsc.errors.map((d) => [d.file, d.code])).toEqual([['packages/owned/src/extra.ts', 'TS2322']]);
    expect(result.ok).toBe(false);
  });

  test('zero matched test files is a failure', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree);
    const plan = JSON.parse(readFileSync(join(tree.root, 'docs/v3/plan.json'), 'utf8'));
    plan.waves[0].units[0].testPaths = ['packages/owned/test/nothing-here'];
    await tree.write({ 'docs/v3/plan.json': JSON.stringify(plan) });
    const result = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(result.tsc.errors).toEqual([]);
    expect(result.vitest).toMatchObject({ ran: true, ok: false });
    expect(result.ok).toBe(false);
  });

  // `vitest run a b` is green as soon as ONE filter selects a file: a second test directory that was
  // never written would go unnoticed, and so would a canary that happens to live under a broad path.
  test('one of two test paths that selects no file is a failure, and the path is named', { timeout: SLOW }, async ({
    tree,
  }) => {
    await plant(tree);
    const plan = JSON.parse(readFileSync(join(tree.root, 'docs/v3/plan.json'), 'utf8'));
    plan.waves[0].units[0].testPaths = ['packages/owned/test', 'packages/owned/test/never-written'];
    await tree.write({ 'docs/v3/plan.json': JSON.stringify(plan) });
    const lines: string[] = [];
    const result = await runUnitCheck({
      root: tree.root,
      unitId: SELF_TEST_UNIT,
      out: { write: (s) => lines.push(s) },
    });
    // The tests that exist ran and passed: the guard alone makes the unit red.
    expect(result.vitest).toMatchObject({ ran: true, status: 0, emptyPaths: ['packages/owned/test/never-written'] });
    expect(result.vitest.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(lines.join('')).toMatch(/packages\/owned\/test\/never-written.*selects no test file/);
  });

  test('a test path may be a file-name prefix, exactly as vitest reads it', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree);
    const plan = JSON.parse(readFileSync(join(tree.root, 'docs/v3/plan.json'), 'utf8'));
    plan.waves[0].units[0].testPaths = ['packages/owned/test/own'];
    await tree.write({ 'docs/v3/plan.json': JSON.stringify(plan) });
    const result = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(result.vitest).toMatchObject({ ran: true, ok: true, emptyPaths: [] });
    expect(result.ok).toBe(true);
  });

  // Discovery is by file suffix AND location (vitest.config.ts): a test written in a place that no
  // project collects never runs, whatever it asserts.
  test('an uncollected test file is a failure when owned and a warning when foreign; a foreign suffix only warns', {
    timeout: SLOW,
  }, async ({ tree }) => {
    const red = "import { expect, test } from 'vitest';\n\ntest('never runs', () => {\n  expect(1).toBe(2);\n});\n";
    await plant(tree, {
      // The e2e project collects tests/<suite>/** only: under a package this file is dead.
      'packages/foreign/test/misplaced.e2e.ts': red,
      'packages/foreign/test/foreign.test.ts': "import { test } from 'vitest';\n\ntest('foreign', () => {});\n",
      // Not one of the repository's suffixes (PLAN §3 rule 9). It may be fixture data, so it only ever warns.
      'packages/owned/test/real.spec.ts': red,
      // Not test files: a helper, a live test (its own config collects it), anything under an excluded directory.
      'packages/owned/test/helpers.ts': 'export const helper = 1;\n',
      'packages/owned/test/probe.live.ts': red,
      'packages/owned/test/dist/built.e2e.ts': red,
    });
    const plan = JSON.parse(readFileSync(join(tree.root, 'docs/v3/plan.json'), 'utf8'));
    plan.waves[0].units[0].testPaths = ['packages/owned/test', 'packages/foreign'];
    await tree.write({ 'docs/v3/plan.json': JSON.stringify(plan) });
    const lines: string[] = [];
    const foreign = await runUnitCheck({
      root: tree.root,
      unitId: SELF_TEST_UNIT,
      out: { write: (s) => lines.push(s) },
    });
    expect(foreign.vitest.uncollected).toEqual({
      errors: [],
      warnings: ['packages/foreign/test/misplaced.e2e.ts', 'packages/owned/test/real.spec.ts'],
    });
    expect(foreign.ok).toBe(true);
    expect(lines.join('')).toMatch(/warning \(not owned by U9\.99\) packages\/foreign\/test\/misplaced\.e2e\.ts/);
    expect(lines.join('')).toMatch(/warning packages\/owned\/test\/real\.spec\.ts/);

    await tree.write({ 'packages/owned/test/misplaced.e2e.ts': red });
    const owned = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(owned.vitest.uncollected.errors).toEqual(['packages/owned/test/misplaced.e2e.ts']);
    // Every collected test passed: the dead file alone makes the unit red.
    expect(owned.vitest).toMatchObject({ ran: true, status: 0, emptyPaths: [], ok: false });
    expect(owned.ok).toBe(false);
  });

  test('a listing that fails is reported as such, never as an empty test path', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree, { 'vitest.config.ts': "throw new Error('this configuration cannot be loaded');\n" });
    const lines: string[] = [];
    const result = await runUnitCheck({
      root: tree.root,
      unitId: SELF_TEST_UNIT,
      out: { write: (s) => lines.push(s) },
    });
    expect(result.vitest).toMatchObject({ ran: true, ok: false, emptyPaths: [] });
    expect(result.vitest.uncollected).toEqual({ errors: [], warnings: [] });
    expect(result.ok).toBe(false);
    expect(lines.join('')).toMatch(/`vitest list packages\/owned\/test` failed \(exit [1-9]/);
  });

  test('a unit that declares no test path is a failure', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree);
    const plan = JSON.parse(readFileSync(join(tree.root, 'docs/v3/plan.json'), 'utf8'));
    plan.waves[0].units[0].testPaths = [];
    await tree.write({ 'docs/v3/plan.json': JSON.stringify(plan) });
    const result = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(result.vitest).toMatchObject({ ran: false, ok: false });
    expect(result.ok).toBe(false);
  });

  test('a failing test is a failure', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree, {
      'packages/owned/test/red.test.ts':
        "import { expect, test } from 'vitest';\n\ntest('red', () => {\n  expect(1).toBe(2);\n});\n",
    });
    const result = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(result.vitest).toMatchObject({ ran: true, ok: false });
    expect(result.ok).toBe(false);
  });

  test('a Biome finding in an owned file is a failure; the same finding in a foreign file is not seen', {
    timeout: SLOW,
  }, async ({ tree }) => {
    const sloppy = 'export const   sloppy = [1,2,3]\n';
    await plant(tree, { 'packages/foreign/src/sloppy.ts': sloppy });
    expect((await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet })).biome.ok).toBe(true);

    await tree.write({ 'packages/owned/src/sloppy.ts': sloppy });
    const result = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(result.biome).toMatchObject({ ran: true, ok: false });
    expect(result.ok).toBe(false);
  });

  // For an undeclared `@cohorte/*` import from src/**, check-layers is the only net (reference-net.test.ts):
  // a unit of a parallel wave has to see its own violations before the gate does.
  test('a layering violation in an owned file is a failure; the same violation in a foreign file is a warning', {
    timeout: SLOW,
  }, async ({ tree }) => {
    const mint =
      'type SealedText = string & { readonly sealed: true };\n\nexport const mint = (text: string): SealedText => text as SealedText;\n';
    await plant(tree, { 'packages/foreign/src/mint.ts': mint });
    const lines: string[] = [];
    const foreign = await runUnitCheck({
      root: tree.root,
      unitId: SELF_TEST_UNIT,
      out: { write: (s) => lines.push(s) },
    });
    expect(foreign.layers.errors).toEqual([]);
    expect(foreign.layers.warnings.map((v) => [v.rule, v.file])).toEqual([['f', 'packages/foreign/src/mint.ts']]);
    expect(foreign.ok).toBe(true);
    expect(lines.join('')).toMatch(/warning.*packages\/foreign\/src\/mint\.ts:3 \[f\]/);

    await tree.write({ 'packages/owned/src/mint.ts': mint });
    const owned = await runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet });
    expect(owned.layers.errors.map((v) => [v.rule, v.file, v.line])).toEqual([['f', 'packages/owned/src/mint.ts', 3]]);
    expect(owned).toMatchObject({ tsc: { errors: [] }, biome: { ok: true }, vitest: { ok: true }, ok: false });
  });

  test('a tree without layers.json skips the layering step and says so', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree);
    rmSync(join(tree.root, 'layers.json'));
    const lines: string[] = [];
    const result = await runUnitCheck({
      root: tree.root,
      unitId: SELF_TEST_UNIT,
      out: { write: (s) => lines.push(s) },
    });
    expect(result.layers).toEqual({ ran: false, errors: [], warnings: [] });
    expect(result.ok).toBe(true);
    expect(lines.join('')).toMatch(/layers skipped/);
  });

  test('an unknown unit and a missing generated tsconfig are refused with a message', { timeout: SLOW }, async ({
    tree,
  }) => {
    await plant(tree);
    await expect(runUnitCheck({ root: tree.root, unitId: 'U0.404', out: quiet })).rejects.toThrow(/U0\.404/);

    await tree.write({ 'tsconfig.checks/placeholder': '' });
    rmSync(join(tree.root, 'tsconfig.checks', `${SELF_TEST_UNIT}.json`));
    await expect(runUnitCheck({ root: tree.root, unitId: SELF_TEST_UNIT, out: quiet })).rejects.toThrow(
      /gen-unit-checks/,
    );
  });
});

describe('command line', () => {
  const script = join(REPO_ROOT, 'scripts/unit-check.ts');

  test('exit code follows the result, and usage errors exit 2', { timeout: SLOW }, async ({ tree }) => {
    await plant(tree, { 'packages/owned/src/extra.ts': "export const owned: number = 'wrong';\n" });
    const red = spawnSync(process.execPath, [script, SELF_TEST_UNIT, '--root', tree.root], { encoding: 'utf8' });
    expect(red.status).toBe(1);
    expect(`${red.stdout}${red.stderr}`).toContain('packages/owned/src/extra.ts');

    const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage');
  });

  test('--plan takes an absolute path; a plan file that is missing or not JSON is a usage error, not a stack trace', {
    timeout: SLOW,
  }, async ({ tree }) => {
    await plant(tree);
    const run = (plan: string) =>
      spawnSync(process.execPath, [script, SELF_TEST_UNIT, '--root', tree.root, '--plan', plan], { encoding: 'utf8' });

    const absolute = run(join(tree.root, 'docs/v3/plan.json'));
    expect(absolute.stderr).toBe('');
    expect(absolute.status).toBe(0);

    await tree.write({ 'docs/v3/broken.json': '{ "waves": [' });
    for (const [plan, message] of [
      ['docs/v3/nowhere.json', /plan file not found: .*docs\/v3\/nowhere\.json/],
      [join(tree.root, 'docs/v3/nowhere.json'), /plan file not found/],
      ['docs/v3/broken.json', /is not valid JSON/],
    ] as const) {
      const refused = run(plan);
      expect(refused.status, plan).toBe(2);
      expect(refused.stderr).toMatch(message);
      expect(refused.stderr).not.toMatch(/^\s+at /m);
    }
  });
});
