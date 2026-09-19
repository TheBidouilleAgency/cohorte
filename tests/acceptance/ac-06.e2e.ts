import { expect, test } from 'vitest';

test('AC-06 fake runtime remains a runtime-contract implementation', async () => {
  const { FAKE_CAPABILITIES } = await import('../../packages/runtime-fake/src/index.ts');
  expect(FAKE_CAPABILITIES.contractVersion).toBe('1');
});
