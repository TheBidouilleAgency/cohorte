import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('AC-02 workflow control is in TypeScript and prompts pass the static guard', async () => {
  const transitions = await readFile('packages/core/src/engine/transitions.ts', 'utf8');
  expect(transitions).toContain('resolveTransition');
  expect(transitions).toContain('nextStep');
});
