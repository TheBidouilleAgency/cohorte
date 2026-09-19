import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { scanRepository } from '../../src/scan/index.ts';

describe('repository scan', () => {
  test('records ambiguity instead of guessing between lockfiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-scan-'));
    try {
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await writeFile(join(root, 'yarn.lock'), '# yarn\n');
      const model = await scanRepository(root, { clock: new FixedClock(), toolVersion: 'test' });
      expect(model.stack.packageManager.value).toBeNull();
      expect(model.unknowns.map((unknown) => unknown.id)).toContain('package-manager');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
