import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { installDogfood } from '../../scripts/dogfood-install.ts';
import { runCliAt, waitForRun } from '../e2e/support/cli.ts';
import { copyWorkingTree, gitFixture } from './support.ts';

describe('dogfood D3: snapshot immutability', () => {
  test('keeps the run on pinned config and prompt bytes after source mutation', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');

    const source = process.cwd();
    const root = await mkdtemp(join(tmpdir(), 'cohorte-d3-'));
    const home = await mkdtemp(join(tmpdir(), 'cohorte-d3-home-'));
    try {
      await copyWorkingTree(source, root);
      await gitFixture(root);
      const installDir = installDogfood({ build: resolve(process.env.COHORTE_E2E_BUILD_DIR), home, linkDeps: true });
      await runCliAt(installDir, root, home, ['init']);
      await writeFile(
        join(root, '.cohorte', 'ownership.yaml'),
        'surfaces:\n  apps: { paths: [apps/**], owners: [implementer], reviewers: [reviewer] }\n',
        'utf8',
      );
      expect((await runCliAt(installDir, root, home, ['config', 'trust', '--grant'])).code).toBe(0);
      const script = join(root, 'd3.yaml');
      await writeFile(script, await readFile(join(source, 'fixtures/scripts/dogfood/d3-immutability.yaml')));

      const started = runCliAt(installDir, root, home, ['run', '--runtime', 'fake', '--script', script]);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const startDeadline = Date.now() + 15_000;
      let snapshotSeen = false;
      while (Date.now() < startDeadline) {
        const observed = await runCliAt(installDir, root, home, ['status', '--json']);
        if (observed.code === 0 && observed.stdout.trim() && JSON.parse(observed.stdout)[0]?.snapshotDigest) {
          snapshotSeen = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!snapshotSeen) {
        const failedStart = await started;
        const observedTail = await runCliAt(installDir, root, home, ['status', '--json']);
        throw new Error(
          `D3 snapshot was not captured: ${failedStart.stdout}\n${failedStart.stderr}\n${observedTail.stdout}\n${observedTail.stderr}`,
        );
      }
      await writeFile(
        join(installDir, 'assets', 'prompts', 'agents', 'implementer.md'),
        'tampered prompt must not be served\n',
        'utf8',
      );
      const startResult = await started;
      expect([0, 4], `${startResult.stdout}\n${startResult.stderr}`).toContain(startResult.code);

      const status = await waitForRun(root, home);
      expect(status, JSON.stringify(status)).toMatchObject({ state: 'COMPLETED' });
      expect(status.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
      const tail = await runCliAt(installDir, root, home, ['tail', status.runId, '--json']);
      expect(tail.code).toBe(0);
      expect(tail.stdout).not.toContain('tampered prompt must not be served');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
