import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import {
  generateUnitChecks,
  loadPlan,
  type Plan,
  PlanFileError,
  renderUnitCheckConfig,
  typeScriptIncludes,
} from '../gen-unit-checks.ts';
import { REPO_ROOT, test } from './support/tree.ts';

const PLAN: Plan = {
  waves: [
    {
      units: [
        {
          id: 'U9.01',
          ownedPaths: [
            'packages/alpha/src/area/**',
            'packages/alpha/test/area/**',
            'packages/alpha/src/contract.ts',
            'packages/*/src/index.ts',
            'fixtures/data/**',
            'docs/v3/notes.md',
            'package.json',
            'vendor/retired/**',
            '.github/workflows/ci.yml',
          ],
          testPaths: ['packages/alpha/test/area'],
        },
        { id: 'U9.02', ownedPaths: ['docs/v3/guide/**', 'README.md'], testPaths: [] },
      ],
    },
  ],
};

describe('typeScriptIncludes', () => {
  test('keeps what can hold TypeScript, relative to tsconfig.checks/, and drops the rest', () => {
    expect(typeScriptIncludes(PLAN.waves[0]?.units[0]?.ownedPaths ?? [])).toEqual([
      '../packages/alpha/src/area/**/*',
      '../packages/alpha/test/area/**/*',
      '../packages/alpha/src/contract.ts',
      '../packages/*/src/index.ts',
      '../fixtures/data/**/*',
    ]);
  });

  test('a unit that owns no TypeScript gets an empty list', () => {
    expect(typeScriptIncludes(['docs/v3/guide/**', 'README.md'])).toEqual([]);
  });
});

describe('renderUnitCheckConfig', () => {
  test('extends the base config, never emits, is not composite, and carries the shared exclusions', () => {
    const config = JSON.parse(renderUnitCheckConfig(PLAN.waves[0]?.units[0] ?? { id: '', ownedPaths: [] }));
    expect(config.extends).toBe('../tsconfig.base.json');
    expect(config.compilerOptions).toMatchObject({ composite: false, noEmit: true, incremental: false });
    expect(config.include).toContain('../packages/alpha/src/area/**/*');
    expect(config.exclude).toEqual([
      '../.cohorte/**',
      '../.build/**',
      '../**/dist/**',
      '../**/dist-types/**',
      '../**/node_modules/**',
    ]);
  });

  test('a unit without TypeScript gets `files: []` so that nothing is ever matched by accident', () => {
    const config = JSON.parse(renderUnitCheckConfig({ id: 'U9.02', ownedPaths: ['docs/v3/guide/**'] }));
    expect(config.files).toEqual([]);
    expect(config.include).toEqual([]);
  });
});

describe('generateUnitChecks', () => {
  test('writes one file per unit, removes stale ones, and --check detects drift', async ({ tree }) => {
    await tree.write({
      'docs/v3/plan.json': JSON.stringify(PLAN),
      'tsconfig.checks/U0.99.json': '{}',
      'tsconfig.checks/README.md': 'kept',
    });
    const first = generateUnitChecks({ root: tree.root });
    expect(first.written.sort()).toEqual(['tsconfig.checks/U9.01.json', 'tsconfig.checks/U9.02.json']);
    expect(first.removed).toEqual(['tsconfig.checks/U0.99.json']);
    expect(readdirSync(join(tree.root, 'tsconfig.checks')).sort()).toEqual(['README.md', 'U9.01.json', 'U9.02.json']);

    expect(generateUnitChecks({ root: tree.root, check: true }).stale).toEqual([]);
    await tree.write({ 'tsconfig.checks/U9.01.json': '{ "edited": true }' });
    expect(generateUnitChecks({ root: tree.root, check: true }).stale).toEqual(['tsconfig.checks/U9.01.json']);
    expect(readFileSync(join(tree.root, 'tsconfig.checks/U9.01.json'), 'utf8')).toBe('{ "edited": true }');
  });

  test('command line: --check exits 1 on drift and writes nothing', async ({ tree }) => {
    const script = join(REPO_ROOT, 'scripts/gen-unit-checks.ts');
    await tree.write({ 'docs/v3/plan.json': JSON.stringify(PLAN) });
    const drift = spawnSync(process.execPath, [script, '--root', tree.root, '--check'], { encoding: 'utf8' });
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain('tsconfig.checks/U9.01.json');

    const write = spawnSync(process.execPath, [script, '--root', tree.root], { encoding: 'utf8' });
    expect(write.status).toBe(0);
    const clean = spawnSync(process.execPath, [script, '--root', tree.root, '--check'], { encoding: 'utf8' });
    expect(clean.status).toBe(0);
  });

  test('command line: --plan takes an absolute path; a missing or broken plan file exits 2 without a stack trace', async ({
    tree,
  }) => {
    const script = join(REPO_ROOT, 'scripts/gen-unit-checks.ts');
    await tree.write({ 'elsewhere/plan.json': JSON.stringify(PLAN), 'elsewhere/broken.json': '{ "waves": [' });
    const run = (plan: string) =>
      spawnSync(process.execPath, [script, '--root', tree.root, '--plan', plan], { encoding: 'utf8' });

    const absolute = run(join(tree.root, 'elsewhere/plan.json'));
    expect(absolute.stderr).toBe('');
    expect(absolute.status).toBe(0);
    expect(readdirSync(join(tree.root, 'tsconfig.checks')).sort()).toEqual(['U9.01.json', 'U9.02.json']);
    expect(run('elsewhere/plan.json').status).toBe(0);

    for (const [plan, message] of [
      ['elsewhere/nowhere.json', /plan file not found: .*elsewhere\/nowhere\.json/],
      [join(tree.root, 'elsewhere/nowhere.json'), /plan file not found/],
      ['elsewhere/broken.json', /is not valid JSON/],
    ] as const) {
      const refused = run(plan);
      expect(refused.status, plan).toBe(2);
      expect(refused.stderr).toMatch(message);
      expect(refused.stderr).not.toMatch(/^\s+at /m);
    }
  });

  test('loadPlan resolves a relative plan path against the root and keeps an absolute one', async ({ tree }) => {
    await tree.write({ 'docs/v3/plan.json': JSON.stringify(PLAN) });
    expect(loadPlan(tree.root)).toEqual(PLAN);
    expect(loadPlan(tree.root, join(tree.root, 'docs/v3/plan.json'))).toEqual(PLAN);
    expect(() => loadPlan(tree.root, 'docs/v3/nowhere.json')).toThrow(PlanFileError);
  });

  test('the committed tsconfig.checks/ matches docs/v3/plan.json', () => {
    expect(generateUnitChecks({ root: REPO_ROOT, check: true }).stale).toEqual([]);
  });
});
