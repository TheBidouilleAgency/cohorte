import { defineConfig } from 'vitest/config';

// Discovery is by FILE SUFFIX (DESIGN 7.0): helpers and data tables under test/ are never collected,
// and no unit ever edits this file.
const EXCLUDE = ['.cohorte/**', '.build/**', '**/dist/**', '**/node_modules/**'];

// scripts/unit-check.ts gives every unit a private cache directory, so parallel unit checks in one
// working tree never write the same files.
const cacheDir = process.env.COHORTE_VITEST_CACHE_DIR;

export default defineConfig({
  ...(cacheDir ? { cacheDir } : {}),
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{packages,apps}/*/{src,test}/**/*.test.ts', 'scripts/test/**/*.test.ts'],
          exclude: EXCLUDE,
          environment: 'node',
          pool: 'threads',
          // Several contract tests intentionally spawn the packaged CLI and
          // rebuild mirrored trees. Under the complete unit matrix those
          // operations exceed Vitest's 5s default even when they are healthy.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['{packages,apps}/*/test/**/*.itest.ts', 'tests/integration/**/*.itest.ts'],
          exclude: EXCLUDE,
          environment: 'node',
          pool: 'forks',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/{e2e,security,crash,dogfood,packaging,acceptance}/**/*.e2e.ts'],
          exclude: EXCLUDE,
          environment: 'node',
          pool: 'forks',
          testTimeout: 120_000,
        },
      },
    ],
  },
});
