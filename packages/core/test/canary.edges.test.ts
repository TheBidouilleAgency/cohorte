import * as persistence from '@cohorte/persistence';
import * as runtimeFake from '@cohorte/runtime-fake';
import * as testkit from '@cohorte/testkit';
import { expect, test } from 'vitest';

// PLAN PC-9: core's tests drive the FakeRuntime and the MemoryStateStore, so `@cohorte/runtime-fake`,
// `@cohorte/persistence` and `@cohorte/testkit` are declared for `core` as TEST-ONLY edges
// (devDependencies + `dev` in layers.json). This canary proves the three names load from
// packages/core/test under vitest. It does NOT prove they are declared: the root declares every
// @cohorte/* package, so any of them resolves from here by walking up; the declaration itself is
// proven by scripts/test/resolve-edges.test.ts (links in packages/core/node_modules). Nothing but
// check-layers rule d stops the same imports under packages/core/src — `tsc -b` lets them through
// (scripts/test/reference-net.test.ts).
test("canary: core's test-only workspace edges resolve", ({ task }) => {
  for (const namespace of [persistence, runtimeFake, testkit]) {
    expect(typeof namespace).toBe('object');
  }
  expect(task.file.projectName).toBe('unit');
});
