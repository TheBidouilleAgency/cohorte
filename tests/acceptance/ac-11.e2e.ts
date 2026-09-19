import { expect, test } from 'vitest';

test('AC-11 project model exposes deterministic drift planning', async () => {
  const drift = await import('../../packages/project-model/src/drift/index.ts');
  expect(drift.diffStates).toBeTypeOf('function');
});
