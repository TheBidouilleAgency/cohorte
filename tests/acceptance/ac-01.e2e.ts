import { expect, test } from 'vitest';
import { completedFixture } from './support.ts';

test('AC-01 fixture runs through build/test/review gate chain', async ({ skip }) => {
  if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the immutable build');
  const fixture = await completedFixture('review');
  try {
    expect(fixture.root).toContain('cohorte-e2e-');
  } finally {
    await fixture.dispose();
  }
});
