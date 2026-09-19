import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { planReconcile } from '../../src/reconcile/index.ts';
import { scanRepository } from '../../src/scan/index.ts';

describe('reconcile plan', () => {
  test('is read-only and reports missing state files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-reconcile-'));
    try {
      const plan = await planReconcile({
        root,
        scan: (path) => scanRepository(path, { clock: new FixedClock(), toolVersion: 'test' }),
        cohorteVersion: '3.0.0',
        clock: new FixedClock(),
      });
      expect(plan.applyAvailable).toBe(false);
      expect(plan.operations.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
