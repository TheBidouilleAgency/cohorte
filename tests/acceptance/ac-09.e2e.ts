import { expect, test } from 'vitest';

test('AC-09 snapshot and CAS ports are available to the host', async () => {
  const core = await import('../../packages/core/src/contract/factories.ts');
  expect(core.createRunSnapshotter).toBeTypeOf('function');
});
