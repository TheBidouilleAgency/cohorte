import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { applyInit, planInit, scanRepository } from '../../src/index.ts';

describe('project init', () => {
  test('plans and applies the generated directory idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-init-'));
    try {
      const model = await scanRepository(root, { clock: new FixedClock(), toolVersion: 'test' });
      const plan = await planInit({ root, model, cohorteVersion: '3.0.0' });
      await applyInit(plan);
      await expect(readFile(join(root, '.cohorte', 'generated', '.gitkeep'))).resolves.toHaveLength(0);
      expect(
        (await planInit({ root, model, cohorteVersion: '3.0.0' })).files.every(
          (file) => file.action === 'keep-existing',
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
