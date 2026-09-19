import { expect, test } from 'vitest';

test('AC-05 protocol catalogue exposes observable event fields', async () => {
  const { EVENT_TYPES } = await import('../../packages/protocol/src/catalogue.ts');
  expect(EVENT_TYPES.length).toBeGreaterThan(0);
  expect(EVENT_TYPES).toContain('run.state.changed');
});
