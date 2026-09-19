import { expect, test } from 'vitest';

// Discovery canary (DESIGN 7.0): proves that vitest collects this root, in the project its file
// suffix selects. scripts/test/discovery.test.ts asserts that `vitest list` finds every canary.
test('canary: tests/live is collected by the "live" project', ({ task }) => {
  expect(task.file.projectName).toBe('live');
});

test('live smoke is opt-in and never reads credential files', async ({ skip }) => {
  if (process.env.COHORTE_LIVE !== '1') {
    skip('COHORTE_LIVE=1 is required; live provider calls are human-operated and budgeted');
  }
  const { access } = await import('node:fs/promises');
  const fixture = new URL('../../fixtures/repos/ts-monorepo/', import.meta.url);
  await expect(access(fixture)).resolves.toBeUndefined();
});
