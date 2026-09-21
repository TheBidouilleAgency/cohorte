import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { REPO_ROOT, type TempTree, test } from './support/tree.ts';

// PLAN PC-10: `tsc -b` covers src/ only and vitest does not typecheck, so tsconfig.tests.json is the
// ONLY thing that keeps a type-level test (expectTypeOf, @ts-expect-error) alive after its wave.
// These tests run the REAL tsconfig.tests.json and tsconfig.base.json over a temp copy.

const TSC = join(REPO_ROOT, 'node_modules/typescript/bin/tsc');

const typeLevelTest = (expected: 'string' | 'number') =>
  [
    "import { expectTypeOf, test } from 'vitest';",
    '',
    "test('type-level', () => {",
    `  expectTypeOf<string>().toEqualTypeOf<${expected}>();`,
    '});',
    '',
  ].join('\n');

async function typecheck(tree: TempTree, files: Readonly<Record<string, string>>) {
  // Without a module-type package.json a .ts file is CommonJS, and verbatimModuleSyntax rejects its imports.
  await tree.write({ 'package.json': '{ "private": true, "type": "module" }\n', ...files });
  await tree.linkNodeModules();
  for (const config of ['tsconfig.base.json', 'tsconfig.tests.json'])
    copyFileSync(join(REPO_ROOT, config), join(tree.root, config));
  return spawnSync(process.execPath, [TSC, '-p', 'tsconfig.tests.json', '--pretty', 'false'], {
    cwd: tree.root,
    encoding: 'utf8',
  });
}

/** One file per include root of tsconfig.tests.json. */
const ROOTS = [
  'packages/alpha/test/types.test.ts',
  'packages/alpha/src/colocated.test.ts',
  'apps/cli/test/types.test.ts',
  'tests/integration/types.itest.ts',
  'tests/acceptance/types.e2e.ts',
  'scripts/test/types.test.ts',
  'packages/testkit/src/types.test.ts',
  'fixtures/repos/demo/build.ts',
  // Config files that no composite project includes (their `include` is src only).
  'vitest.config.ts',
  'vitest.live.config.ts',
  'apps/cli/tsdown.config.ts',
] as const;

describe('tsconfig.tests.json', () => {
  test.for(ROOTS)(
    'a failing expectTypeOf planted in %s fails the typecheck',
    { timeout: 60_000 },
    async (file, { tree }) => {
      const done = await typecheck(tree, { [file]: typeLevelTest('number') });
      expect(done.status).not.toBe(0);
      expect(done.stdout).toContain(`${file}(`);
    },
  );

  test('the same tree without the planted error passes', { timeout: 60_000 }, async ({ tree }) => {
    const done = await typecheck(tree, Object.fromEntries(ROOTS.map((file) => [file, typeLevelTest('string')])));
    expect(done.stdout).toBe('');
    expect(done.status).toBe(0);
  });

  test('excluded trees are not typechecked', { timeout: 60_000 }, async ({ tree }) => {
    const done = await typecheck(tree, {
      'tests/e2e/ok.e2e.ts': typeLevelTest('string'),
      '.cohorte/state/tests/bad.test.ts': typeLevelTest('number'),
      '.build/u/tests/bad.test.ts': typeLevelTest('number'),
      '.cohorte/worktrees/w/tests/bad.test.ts': typeLevelTest('number'),
      'tests/e2e/dist/bad.e2e.ts': typeLevelTest('number'),
    });
    expect(done.stdout).toBe('');
    expect(done.status).toBe(0);
  });

  test('is a non-composite, non-emitting project over the base config', () => {
    const config = JSON.parse(
      String(
        spawnSync(process.execPath, [TSC, '-p', 'tsconfig.tests.json', '--showConfig'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }).stdout,
      ),
    );
    expect(config.compilerOptions).toMatchObject({
      noEmit: true,
      composite: false,
      strict: true,
      isolatedDeclarations: false,
      skipLibCheck: true,
    });
  });

  test('`pnpm typecheck` and `pnpm verify` run it next to `tsc -b`', () => {
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
    expect(scripts.typecheck).toBe('tsc -b && tsc -p tsconfig.tests.json');
    expect(scripts.verify).toContain('tsc -b && tsc -p tsconfig.tests.json');
  });
});
