import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  test('discovers package-sized surfaces in common workspace roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-scan-surfaces-'));
    try {
      await mkdir(join(root, 'apps', 'api'), { recursive: true });
      await mkdir(join(root, 'packages', 'shared-types'), { recursive: true });
      await mkdir(join(root, 'packages', 'modules', 'surveys'), { recursive: true });
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(join(root, 'apps', 'api', 'package.json'), '{"name":"api"}\n');
      await writeFile(join(root, 'packages', 'shared-types', 'package.json'), '{"name":"shared-types"}\n');
      await writeFile(join(root, 'packages', 'modules', 'surveys', 'package.json'), '{"name":"surveys"}\n');
      await writeFile(join(root, 'scripts', 'check.mjs'), 'export {};\n');

      const model = await scanRepository(root, { clock: new FixedClock(), toolVersion: 'test' });

      expect(Object.keys(model.surfaces)).toEqual([
        'apps-api',
        'packages-modules-surveys',
        'packages-shared-types',
        'scripts',
      ]);
      expect(model.surfaces['apps-api']?.paths.value).toEqual(['apps/api/**']);
      expect(model.surfaces['packages-modules-surveys']?.paths.value).toEqual(['packages/modules/surveys/**']);
      expect(model.surfaces.scripts?.paths.value).toEqual(['scripts/**']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
