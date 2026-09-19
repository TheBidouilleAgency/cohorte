import { expect, test } from 'vitest';

// Discovery canary (DESIGN 7.0): proves that vitest collects this root, in the project its file
// suffix selects. scripts/test/discovery.test.ts asserts that `vitest list` finds every canary.
test('canary: tests/security is collected by the "e2e" project', ({ task }) => {
  expect(task.file.projectName).toBe('e2e');
});
