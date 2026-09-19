import { describe, expect, test } from 'vitest';
import {
  commitFixture,
  createGitFixture,
  runCli,
  runCliWithEnv,
  waitForRun,
  writeHappyFakeScript,
} from '../e2e/support/cli.ts';

describe('real host crash recovery', () => {
  test('SIGKILLs a detached host at a named crash point and resumes the same run', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');

    const fixture = await createGitFixture();
    try {
      await runCli(fixture.root, fixture.home, ['init', '--json', fixture.root]);
      const script = await writeHappyFakeScript(fixture.root);
      await commitFixture(fixture.root, 'fixture crash recovery');
      expect((await runCli(fixture.root, fixture.home, ['config', 'trust', '--grant'])).code).toBe(0);

      const started = await runCliWithEnv(
        fixture.root,
        fixture.home,
        ['run', '--json', '--runtime', 'fake', '--script', script],
        { COHORTE_CRASH_AT: 'host.after-lease' },
      );
      expect([0, 4]).toContain(started.code);
      const document = JSON.parse(started.stdout) as { result?: { runId?: string } };
      const runId = document.result?.runId;
      expect(runId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 300));
      const resumed = await runCli(fixture.root, fixture.home, ['__host', '--run', runId as string]);
      expect([0, 1]).toContain(resumed.code);
      const status = await waitForRun(fixture.root, fixture.home);
      expect(status.state).toBe('COMPLETED');
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
