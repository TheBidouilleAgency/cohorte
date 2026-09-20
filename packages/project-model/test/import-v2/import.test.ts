import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CohorteConfig, Ownership, Spec } from '@cohorte/config/schema';
import { FixedClock } from '@cohorte/testkit';
import { Compile } from 'typebox/compile';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  applyV2Import,
  exportV2,
  planV2Import,
  rollbackV2Import,
  V2_IMPORT_FAULT_POINTS,
} from '../../src/import-v2/index.ts';
import { scanRepository } from '../../src/scan/index.ts';

async function fixture(): Promise<{ root: string; destination: string; backup: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cohorte-v2-root-'));
  const destination = await mkdtemp(join(tmpdir(), 'cohorte-v2-bundle-'));
  const backup = await mkdtemp(join(tmpdir(), 'cohorte-v2-backup-'));
  await mkdir(join(root, 'specs', 'reports'), { recursive: true });
  await writeFile(join(root, 'PIPELINE.md'), '# Project\n\nversion: 2.10.0\n');
  await writeFile(join(root, 'cohorte.config.yaml'), 'pipeline:\n  name: demo\nkanban:\n  enabled: true\n');
  await writeFile(join(root, 'specs', 'feature.md'), '# Feature\n');
  await writeFile(join(root, 'specs', 'reports', 'review.md'), '# Review\n');
  await writeFile(join(root, '.env'), 'TOKEN=must-not-export\n');
  return { root, destination, backup };
}

describe('V2 export and V3 import', () => {
  test('exports safe files and excludes credentials', async () => {
    const paths = await fixture();
    try {
      const result = await exportV2({
        root: paths.root,
        destination: paths.destination,
        now: '2026-09-20T00:00:00.000Z',
      });
      expect(result.manifest.format).toBe('cohorte-v2-export');
      expect(result.manifest.files.map((file) => file.path)).toContain('specs/feature.md');
      expect(result.manifest.excluded).toContainEqual({ path: '.env', reason: 'sensitive-path' });
      await expect(readFile(join(paths.destination, 'files', '.env'))).rejects.toThrow();
    } finally {
      await Promise.all([
        rm(paths.root, { recursive: true, force: true }),
        rm(paths.destination, { recursive: true, force: true }),
        rm(paths.backup, { recursive: true, force: true }),
      ]);
    }
  });

  test('previews, applies and rolls back without deleting V2 sources', async () => {
    const paths = await fixture();
    try {
      const exported = await exportV2({
        root: paths.root,
        destination: paths.destination,
        now: '2026-09-20T00:00:00.000Z',
      });
      const model = await scanRepository(paths.root, { clock: new FixedClock(), toolVersion: 'test' });
      const plan = await planV2Import(paths.destination, paths.root, { model });
      expect(plan.conflicts).toEqual([]);
      const report = await applyV2Import(plan, {
        confirm: true,
        backupRoot: paths.backup,
        now: '2026-09-20T00:00:00.000Z',
      });
      expect(report.files).toEqual(
        expect.arrayContaining([
          '.cohorte/manifest.yaml',
          '.cohorte/project.yaml',
          '.cohorte/config.yaml',
          '.cohorte/specs/feature.yaml',
          '.cohorte/artifacts/v2-history/review.md',
        ]),
      );
      await expect(readFile(join(paths.root, '.cohorte', 'specs', 'feature.yaml'), 'utf8')).resolves.toContain(
        'title: Feature',
      );
      const importedConfig = parse(await readFile(join(paths.root, '.cohorte', 'config.yaml'), 'utf8'));
      const importedOwnership = parse(await readFile(join(paths.root, '.cohorte', 'ownership.yaml'), 'utf8'));
      const importedSpec = parse(await readFile(join(paths.root, '.cohorte', 'specs', 'feature.yaml'), 'utf8'));
      expect(Compile(CohorteConfig).Check(importedConfig)).toBe(true);
      expect(Compile(Ownership).Check(importedOwnership)).toBe(true);
      expect(Compile(Spec).Check(importedSpec)).toBe(true);
      await expect(
        readFile(join(paths.root, '.cohorte', 'artifacts', 'v2-history', 'review.md'), 'utf8'),
      ).resolves.toBe('# Review\n');
      await expect(readFile(join(paths.root, 'PIPELINE.md'), 'utf8')).resolves.toContain('version: 2.10.0');
      await rollbackV2Import(report);
      await expect(readFile(join(paths.root, '.cohorte', 'project.yaml'))).rejects.toThrow();
      expect(exported.manifest.projectRootDigest).toBe(plan.sourceDigest);
    } finally {
      await Promise.all([
        rm(paths.root, { recursive: true, force: true }),
        rm(paths.destination, { recursive: true, force: true }),
        rm(paths.backup, { recursive: true, force: true }),
      ]);
    }
  });

  test('refuses a changed project after preview', async () => {
    const paths = await fixture();
    try {
      await exportV2({ root: paths.root, destination: paths.destination });
      const plan = await planV2Import(paths.destination, paths.root);
      await writeFile(join(paths.root, 'new-file.txt'), 'changed\n');
      await expect(applyV2Import(plan, { confirm: true, backupRoot: paths.backup })).rejects.toThrow(
        'import-project-changed',
      );
    } finally {
      await Promise.all([
        rm(paths.root, { recursive: true, force: true }),
        rm(paths.destination, { recursive: true, force: true }),
        rm(paths.backup, { recursive: true, force: true }),
      ]);
    }
  });

  test.each(V2_IMPORT_FAULT_POINTS)('restores the project after fault injection at %s', async (faultPoint) => {
    const paths = await fixture();
    try {
      await exportV2({ root: paths.root, destination: paths.destination, now: '2026-09-20T00:00:00.000Z' });
      const plan = await planV2Import(paths.destination, paths.root);
      await expect(
        applyV2Import(plan, {
          confirm: true,
          backupRoot: paths.backup,
          now: '2026-09-20T00:00:00.000Z',
          fault: (point) => {
            if (point === faultPoint) throw new Error(`fault:${point}`);
          },
        }),
      ).rejects.toThrow(`fault:${faultPoint}`);
      await expect(readFile(join(paths.root, 'PIPELINE.md'), 'utf8')).resolves.toContain('version: 2.10.0');
      await expect(readFile(join(paths.root, '.cohorte', 'manifest.yaml'))).rejects.toThrow();
      await expect(readFile(join(paths.root, '.cohorte', 'config.yaml'))).rejects.toThrow();
      await expect(readFile(join(paths.root, '.cohorte', 'import-reports'))).rejects.toThrow();
    } finally {
      await Promise.all([
        rm(paths.root, { recursive: true, force: true }),
        rm(paths.destination, { recursive: true, force: true }),
        rm(paths.backup, { recursive: true, force: true }),
      ]);
    }
  });
});
