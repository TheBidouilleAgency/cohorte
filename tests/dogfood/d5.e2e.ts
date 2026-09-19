import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { installDogfood } from '../../scripts/dogfood-install.ts';
import { runCliAt } from '../e2e/support/cli.ts';
import { copyWorkingTree, gitFixture } from './support.ts';

describe('dogfood D5: state migration', () => {
  test('applies N+1 through the migration verb and keeps the state store readable', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');

    const source = process.cwd();
    const root = await mkdtemp(join(tmpdir(), 'cohorte-d5-'));
    const home = await mkdtemp(join(tmpdir(), 'cohorte-d5-home-'));
    try {
      await copyWorkingTree(source, root);
      await gitFixture(root);
      const installDir = installDogfood({ build: resolve(process.env.COHORTE_E2E_BUILD_DIR), home, linkDeps: true });
      expect((await runCliAt(installDir, root, home, ['init'])).code).toBe(0);
      expect((await runCliAt(installDir, root, home, ['config', 'trust', '--grant'])).code).toBe(0);
      expect((await runCliAt(installDir, root, home, ['migrate', '--apply', '--json'])).code).toBe(0);
      await mkdir(join(installDir, 'assets', 'migrations', 'state'), { recursive: true });
      await writeFile(
        join(installDir, 'assets', 'migrations', 'state', '0002_dogfood_probe.sql'),
        "CREATE TABLE dogfood_d5_probe (id TEXT PRIMARY KEY, note TEXT NOT NULL) STRICT;\nINSERT INTO dogfood_d5_probe (id, note) VALUES ('seed', 'from d5');\n",
        'utf8',
      );

      const pending = await runCliAt(installDir, root, home, ['migrate', '--json']);
      expect(pending.code).toBe(3);
      expect(JSON.parse(pending.stdout)).toMatchObject({ current: 1, target: 2, pending: [{ id: 2 }] });

      let applied = await runCliAt(installDir, root, home, ['migrate', '--apply', '--json']);
      for (let attempt = 0; attempt < 12 && applied.code === 16; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        applied = await runCliAt(installDir, root, home, ['migrate', '--apply', '--json']);
      }
      expect(applied.code, `${applied.stdout}\n${applied.stderr}`).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({ current: 1, target: 2, applied: [{ id: 2 }] });

      const status = await runCliAt(installDir, root, home, ['status', '--json']);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
