import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { installDogfood } from '../../scripts/dogfood-install.ts';
import { commitFixture, runCliAt, runCliAtWithEnv, waitForRun, writeHappyFakeScript } from '../e2e/support/cli.ts';
import { copyWorkingTree, gitFixture } from './support.ts';

describe('dogfood D4: pinned install', () => {
  test('refuses a tampered host install, then resumes after restoration', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');

    const source = process.cwd();
    const root = await mkdtemp(join(tmpdir(), 'cohorte-d4-'));
    const home = await mkdtemp(join(tmpdir(), 'cohorte-d4-home-'));
    try {
      await copyWorkingTree(source, root);
      await gitFixture(root);
      const installDir = installDogfood({ build: resolve(process.env.COHORTE_E2E_BUILD_DIR), home, linkDeps: true });
      expect((await runCliAt(installDir, root, home, ['init'])).code).toBe(0);
      expect((await runCliAt(installDir, root, home, ['config', 'trust', '--grant'])).code).toBe(0);
      const script = await writeHappyFakeScript(root);
      await commitFixture(root, 'dogfood d4', ['fake-script.yaml']);

      const started = await runCliAtWithEnv(
        installDir,
        root,
        home,
        ['run', '--json', '--runtime', 'fake', '--script', script],
        { COHORTE_CRASH_AT: 'host.after-lease' },
      );
      expect([0, 4]).toContain(started.code);
      const runId = (JSON.parse(started.stdout) as { result?: { runId?: string } }).result?.runId;
      expect(runId).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const hostPath = join(installDir, 'dist', 'agent-host.mjs');
      const original = await readFile(hostPath);
      await writeFile(hostPath, Buffer.concat([original, Buffer.from('\n// D4 tamper\n')]));
      const refused = await runCliAt(installDir, root, home, ['__host', '--run', runId as string]);
      expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/runtime-pin-mismatch|security\//i);

      await writeFile(hostPath, original);
      const resumed = await runCliAt(installDir, root, home, ['__host', '--run', runId as string]);
      expect([0, 1]).toContain(resumed.code);
      expect((await waitForRun(root, home)).state).toBe('COMPLETED');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
