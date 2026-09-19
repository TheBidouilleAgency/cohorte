import { describe, expect, test } from 'vitest';
import { createGitFixture, runCli, waitForRun, writeHappyFakeScript } from '../e2e/support/cli.ts';

describe('security/project-policy-untrusted', () => {
  test('refuses a run before trust and allows it after an explicit grant', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
    const fixture = await createGitFixture();
    try {
      const init = await runCli(fixture.root, fixture.home, ['init', '--json', fixture.root]);
      expect(init.code).toBe(0);
      const script = await writeHappyFakeScript(fixture.root);

      const refused = await runCli(fixture.root, fixture.home, ['run', '--runtime', 'fake', '--script', script]);
      expect(refused.code).toBe(13);
      expect(`${refused.stdout}\n${refused.stderr}`).toContain('security/project-policy-untrusted');
      expect(JSON.parse((await runCli(fixture.root, fixture.home, ['status', '--json'])).stdout)).toEqual([]);

      expect((await runCli(fixture.root, fixture.home, ['config', 'trust', '--grant'])).code).toBe(0);
      const started = await runCli(fixture.root, fixture.home, ['run', '--runtime', 'fake', '--script', script]);
      expect([0, 4]).toContain(started.code);
      expect((await waitForRun(fixture.root, fixture.home)).state).toBe('COMPLETED');
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
