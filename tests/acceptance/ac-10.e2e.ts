import { expect, test } from 'vitest';

test('AC-10 worktree and integration services are exposed by core', async () => {
  const core = await import('../../packages/core/src/contract/factories.ts');
  expect(core.createWorktreeService).toBeTypeOf('function');
  expect(core.createIntegrationService).toBeTypeOf('function');
});
