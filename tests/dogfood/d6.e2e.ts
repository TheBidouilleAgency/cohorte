import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { installDogfood } from '../../scripts/dogfood-install.ts';
import { runCliAt, waitForRun } from '../e2e/support/cli.ts';
import { copyWorkingTree, gitFixture } from './support.ts';

describe('dogfood D6: unauthorized writes', () => {
  test('denies five runtime/state writes and refuses an in-target host install', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');

    const source = process.cwd();
    const root = await mkdtemp(join(tmpdir(), 'cohorte-d6-'));
    const home = await mkdtemp(join(tmpdir(), 'cohorte-d6-home-'));
    const inTargetHome = join(root, 'host-home');
    await mkdir(inTargetHome, { recursive: true });
    try {
      await copyWorkingTree(source, root);
      await gitFixture(root);
      const installDir = installDogfood({
        build: resolve(process.env.COHORTE_E2E_BUILD_DIR),
        home,
        linkDeps: true,
      });
      await symlink(installDir, join(root, 'runtime-link'));
      const init = await runCliAt(installDir, root, home, ['init']);
      expect(init.code).toBe(0);
      await writeFile(
        join(root, '.cohorte', 'ownership.yaml'),
        'surfaces:\n  apps: { paths: [apps/**], owners: [implementer], reviewers: [reviewer] }\n',
        'utf8',
      );
      const trust = await runCliAt(installDir, root, home, ['config', 'trust', '--grant']);
      expect(trust.code).toBe(0);

      const script = await readFile(join(source, 'fixtures/scripts/dogfood/d6-unauthorized.yaml'), 'utf8');
      await writeFile(
        join(root, 'd6.yaml'),
        script.replaceAll('RUNTIME_INSTALL', `${installDir}/dist/cli.mjs`).replaceAll('TARGET_ROOT', root),
        'utf8',
      );
      const installBefore = await readFile(join(installDir, 'dist/cli.mjs'));
      const started = await runCliAt(installDir, root, home, [
        'run',
        '--runtime',
        'fake',
        '--script',
        join(root, 'd6.yaml'),
      ]);
      expect([0, 4]).toContain(started.code);
      const status = await waitForRun(root, home);
      const tail = await runCliAt(installDir, root, home, ['tail', status.runId, '--json']);
      const denied = tail.stdout
        .split('\n')
        .filter((line) => line.includes('"type":"tool.denied"'))
        .map((line) => JSON.parse(line) as { payload?: { overridable?: boolean } });
      expect(denied, `${JSON.stringify(status)}\n${tail.stdout}\n${tail.stderr}`).toHaveLength(5);
      expect(denied.every((event) => event.payload?.overridable === false)).toBe(true);
      expect(await readFile(join(installDir, 'dist/cli.mjs'))).toEqual(installBefore);
      expect(existsSync(join(root, '.cohorte', 'state', 'cohorte.db'))).toBe(true);

      const inTargetInstall = installDogfood({
        build: resolve(process.env.COHORTE_E2E_BUILD_DIR),
        home: inTargetHome,
        linkDeps: true,
      });
      const refused = await runCliAt(inTargetInstall, root, inTargetHome, ['run', '--runtime', 'fake']);
      expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/runtime-inside-target|outside-target|security\//i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
