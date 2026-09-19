import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@cohorte/config/schema';
import { FixedClock } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { deriveDesiredState } from '../../src/desired/index.ts';
import { applyReconcile, planReconcile } from '../../src/reconcile/index.ts';
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
      expect(plan.applyAvailable).toBe(true);
      expect(plan.operations.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('applies generated drift, keeps human files, and writes a journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-reconcile-apply-'));
    try {
      const clock = new FixedClock();
      const model = await scanRepository(root, { clock, toolVersion: 'test' });
      const desired = deriveDesiredState({ model, config: DEFAULT_CONFIG, cohorteVersion: '3.0.0', skills: {} });
      const plan = await planReconcile({ root, scan: async () => model, cohorteVersion: '3.0.0', clock });
      const result = await applyReconcile({ root, plan, desired, backup: true, clock });
      expect(result.applied).toContain('project.yaml');
      await expect(readFile(join(root, '.cohorte', 'project.yaml'), 'utf8')).resolves.toContain('schemaVersion: 1');
      await expect(readFile(result.journal, 'utf8')).resolves.toContain('project.yaml');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a generated file that changes after planning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-reconcile-race-'));
    try {
      const clock = new FixedClock();
      const model = await scanRepository(root, { clock, toolVersion: 'test' });
      const desired = deriveDesiredState({ model, config: DEFAULT_CONFIG, cohorteVersion: '3.0.0', skills: {} });
      const plan = await planReconcile({ root, scan: async () => model, cohorteVersion: '3.0.0', clock });
      await mkdir(join(root, '.cohorte'), { recursive: true });
      await writeFile(join(root, '.cohorte', 'project.yaml'), 'changed after plan\n');
      await expect(applyReconcile({ root, plan, desired, clock })).rejects.toThrow('conflict/reconcile-race');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
