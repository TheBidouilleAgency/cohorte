import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { installDogfood } from '../../scripts/dogfood-install.ts';
import { runCliAt } from '../e2e/support/cli.ts';
import { copyWorkingTree, gitFixture } from './support.ts';

describe('dogfood D1: working-tree copy', () => {
  test('initializes the copied repository and finds no reconcile drift', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');

    const source = process.cwd();
    const root = await mkdtemp(join(tmpdir(), 'cohorte-d1-'));
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    try {
      await copyWorkingTree(source, root);
      await gitFixture(root);
      const installDir = installDogfood({
        build: resolve(process.env.COHORTE_E2E_BUILD_DIR),
        home,
        linkDeps: true,
      });

      const init = await runCliAt(installDir, root, home, ['init']);
      expect(init.code).toBe(0);
      const trust = await runCliAt(installDir, root, home, ['config', 'trust', '--grant']);
      expect(trust.code).toBe(0);
      const planned = await runCliAt(installDir, root, home, ['reconcile', '--plan', '--json']);
      expect(planned.code).toBe(0);
      const plan = JSON.parse(planned.stdout) as { operations?: readonly unknown[] };
      expect(plan.operations).toEqual([]);

      await writeFile(join(root, '.cohorte', 'config.yaml'), 'schemaVersion: 1\nchecks: {}\n');
      const afterEdit = await runCliAt(installDir, root, home, ['reconcile', '--plan', '--json']);
      expect(afterEdit.code).toBe(0);
      expect(JSON.parse(afterEdit.stdout)).toMatchObject({
        operations: expect.arrayContaining([expect.objectContaining({ op: 'ask', target: 'config.yaml' })]),
      });
      await writeFile(
        join(root, '.cohorte', 'project.yaml'),
        `${await readFile(join(root, '.cohorte', 'project.yaml'), 'utf8')}\n`,
      );
      const conflict = await runCliAt(installDir, root, home, ['reconcile', '--plan', '--json']);
      expect(JSON.parse(conflict.stdout)).toMatchObject({
        conflicts: expect.arrayContaining(['project.yaml']),
      });
      await expect(readFile(join(root, '.cohorte', 'project.yaml'), 'utf8')).resolves.toContain('schemaVersion');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
