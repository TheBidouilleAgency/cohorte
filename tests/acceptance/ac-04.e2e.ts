import { expect, test } from 'vitest';

test('AC-04 crash recovery surface is present', async () => {
  const { CRASHPOINTS } = await import('../../packages/core/src/durability/crashpoints.ts');
  expect(Object.keys(CRASHPOINTS).length).toBeGreaterThan(0);
});
