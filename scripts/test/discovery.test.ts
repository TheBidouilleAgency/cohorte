import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REPO_ROOT } from './support/tree.ts';

// DESIGN 7.0: one canary per root, and `vitest list` must find every one of them. A suite directory
// that vitest does not collect is a suite that silently never runs.
//
// This file stays in the `unit` project for the life of the repository, so it only ever LISTS
// (`vitest list --filesOnly` collects with the same include / exclude / filter logic as `vitest run`
// and executes nothing). Running a suite directory from here would execute, inside a unit test,
// whatever later waves put there: tests/packaging ends up building, packing and `npm i`-ing a tarball.

const VITEST = join(REPO_ROOT, 'node_modules/vitest/vitest.mjs');

interface Listed {
  file: string;
  projectName?: string;
}

function list(...args: string[]): string[] {
  const done = spawnSync(process.execPath, [VITEST, 'list', ...args, '--filesOnly', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, COHORTE_VITEST_CACHE_DIR: join(REPO_ROOT, '.build/.vitest/discovery') },
  });
  expect(done.status, done.stderr).toBe(0);
  const files: Listed[] = JSON.parse(done.stdout);
  return files.map((f) => `${f.projectName ?? '-'} ${f.file.slice(REPO_ROOT.length + 1)}`).sort();
}

const CANARIES: ReadonlyArray<readonly [project: string, file: string]> = [
  ['unit', 'packages/base/test/canary.test.ts'],
  ['unit', 'packages/core/test/canary.edges.test.ts'],
  ['unit', 'apps/cli/test/canary.test.ts'],
  ['integration', 'tests/integration/canary.itest.ts'],
  ['e2e', 'tests/e2e/canary.e2e.ts'],
  ['e2e', 'tests/security/canary.e2e.ts'],
  ['e2e', 'tests/crash/canary.e2e.ts'],
  ['e2e', 'tests/dogfood/canary.e2e.ts'],
  ['e2e', 'tests/packaging/canary.e2e.ts'],
  ['e2e', 'tests/acceptance/canary.e2e.ts'],
];

// A canary by its exact file name. `vitest list canary` is a SUBSTRING filter: it also returns files
// that later units own, such as packages/runtime-pi/test/auth/auth-canary.itest.ts (PLAN U4.08).
const CANARY_FILE = /(^|\/)canary(\.edges)?\.(test|itest|e2e)\.ts$/;

/** `tests/packaging/canary.e2e.ts` -> `tests/packaging`; `apps/cli/test/canary.test.ts` -> `apps/cli`. */
const rootOf = (file: string) => (file.startsWith('tests/') ? dirname(file) : file.split('/').slice(0, 2).join('/'));

describe('test discovery', () => {
  test('`vitest list` finds every canary, each in the project its suffix selects', { timeout: 120_000 }, () => {
    const canaries = list('canary').filter((entry) => CANARY_FILE.test(entry));
    expect(canaries).toEqual(CANARIES.map(([project, file]) => `${project} ${file}`).sort());
  });

  test('the canary pattern is exact: a file that merely contains the word is not a canary', () => {
    expect(CANARY_FILE.test('integration packages/runtime-pi/test/auth/auth-canary.itest.ts')).toBe(false);
    expect(CANARY_FILE.test('unit packages/base/test/canary-helpers.test.ts')).toBe(false);
    for (const [project, file] of CANARIES) expect(CANARY_FILE.test(`${project} ${file}`), file).toBe(true);
  });

  test('the live canary is collected by the live config only', { timeout: 120_000 }, () => {
    expect(list('--config', 'vitest.live.config.ts').filter((entry) => entry.endsWith('canary.live.ts'))).toEqual([
      'live tests/live/canary.live.ts',
    ]);
    expect(list().filter((entry) => entry.endsWith('.live.ts'))).toEqual([]);
  });

  // The failure the delivery judge reproduced: `vitest run tests/packaging` and `vitest run apps/cli`
  // ended in "No test files found". A directory filter must select at least the directory's canary.
  test.for(CANARIES.map(([project, file]) => [rootOf(file), `${project} ${file}`] as const))(
    'the directory filter `%s` selects test files, its canary among them',
    { timeout: 120_000 },
    ([directory, canary]) => {
      const selected = list(directory);
      expect(selected.length).toBeGreaterThanOrEqual(1);
      expect(selected).toContain(canary);
    },
  );

  test('nothing is collected from legacy/, .build/, .cohorte/, dist/ or node_modules/', { timeout: 120_000 }, () => {
    const offending = list().filter((entry) =>
      /^\S+ ((legacy|\.build|\.cohorte)\/|(.*\/)?(dist|node_modules)\/)/.test(entry),
    );
    expect(offending).toEqual([]);
  });
});
