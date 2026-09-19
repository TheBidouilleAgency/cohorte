import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { installDogfood } from '../../scripts/dogfood-install.ts';
import { createGitFixture, runCliAt, waitForRun, writeHappyFakeScript } from '../e2e/support/cli.ts';

describe('dogfood: published CLI', () => {
  test('the packaged CLI can initialize and complete a fixture from scratch', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
    const fixture = await createGitFixture();
    try {
      const installDir = installDogfood({
        build: resolve(process.env.COHORTE_E2E_BUILD_DIR),
        home: fixture.home,
        linkDeps: true,
      });
      expect((await runCliAt(installDir, fixture.root, fixture.home, ['init', '--json', fixture.root])).code).toBe(0);
      expect((await runCliAt(installDir, fixture.root, fixture.home, ['config', 'trust', '--grant'])).code).toBe(0);
      const script = await writeHappyFakeScript(fixture.root);
      const result = await runCliAt(installDir, fixture.root, fixture.home, [
        'run',
        '--runtime',
        'fake',
        '--script',
        script,
      ]);
      expect([0, 4]).toContain(result.code);
      expect((await waitForRun(fixture.root, fixture.home)).state).toBe('COMPLETED');
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
