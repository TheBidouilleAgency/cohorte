import { describe, expect, test } from 'vitest';
import { createGitFixture, initAndTrust, runCli, waitForRun, writeHappyFakeScript } from '../support/cli.ts';

describe('built CLI happy path', () => {
  test('runs a fake-runtime fixture through the immutable build', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
    const fixture = await createGitFixture();
    try {
      await initAndTrust(fixture.root, fixture.home);
      const script = await writeHappyFakeScript(fixture.root);
      const started = await runCli(fixture.root, fixture.home, [
        'run',
        '--wait',
        '2',
        '--runtime',
        'fake',
        '--script',
        script,
      ]);
      expect([0, 4]).toContain(started.code);
      const status = await waitForRun(fixture.root, fixture.home);
      expect(status.state).toBe('COMPLETED');
      expect(status.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(status.runtimePin?.digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
