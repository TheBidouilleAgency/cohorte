import { defineConfig } from 'vitest/config';

// Live provider tests: a separate config so that no default run, and no CI job, ever collects them.
// A human runs `pnpm test:live` with COHORTE_LIVE=1 (PLAN rule 10).
export default defineConfig({
  test: {
    name: 'live',
    include: ['tests/live/**/*.live.ts'],
    exclude: ['.cohorte/**', '.build/**', '**/dist/**', '**/node_modules/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 300_000,
  },
});
