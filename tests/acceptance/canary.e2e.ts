import { expect, test } from 'vitest';

test('canary: tests/acceptance is collected by the "e2e" project', ({ task }) => {
  expect(task.file.projectName).toBe('e2e');
});
