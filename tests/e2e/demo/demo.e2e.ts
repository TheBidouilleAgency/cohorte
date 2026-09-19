import { describe, expect, test } from 'vitest';
import { createGitFixture, initAndTrust, runCli, waitForRun, writeHappyFakeScript } from '../support/cli.ts';

describe('built CLI detached demo', () => {
  test('tails and completes a detached fake run', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
    const fixture = await createGitFixture();
    try {
      await initAndTrust(fixture.root, fixture.home);
      const script = await writeHappyFakeScript(fixture.root);
      const started = await runCli(fixture.root, fixture.home, ['run', '--runtime', 'fake', '--script', script]);
      expect([0, 4]).toContain(started.code);
      const status = await waitForRun(fixture.root, fixture.home);
      expect(status.state).toBe('COMPLETED');
      const tail = await runCli(fixture.root, fixture.home, ['tail', status.runId, '--json']);
      expect(tail.code).toBe(0);
      expect(tail.stdout.trim()).not.toBe('');
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
