import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { commitFixture, createGitFixture, runCli, waitForRun, writeHappyFakeScript } from '../support/cli.ts';

describe('frontend/backend ownership', () => {
  test('records disjoint frontend and backend ownership zones', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
    const fixture = await createGitFixture();
    try {
      const init = await runCli(fixture.root, fixture.home, ['init', '--json', fixture.root]);
      expect(init.code).toBe(0);
      await writeFile(
        join(fixture.root, '.cohorte', 'ownership.yaml'),
        'surfaces:\n  frontend: { paths: [frontend/**], owners: [implementer], reviewers: [reviewer] }\n  backend: { paths: [backend/**], owners: [implementer], reviewers: [reviewer] }\n  shared: { paths: [contracts/**], owners: [implementer], reviewers: [reviewer], approval: human }\n',
      );
      const script = await writeHappyFakeScript(fixture.root);
      await commitFixture(fixture.root, 'fixture ownership', ['.cohorte/ownership.yaml', 'fake-script.yaml']);
      expect((await runCli(fixture.root, fixture.home, ['config', 'trust', '--grant'])).code).toBe(0);
      const start = await runCli(fixture.root, fixture.home, ['run', '--runtime', 'fake', '--script', script]);
      expect([0, 4]).toContain(start.code);
      const status = await waitForRun(fixture.root, fixture.home);
      const events =
        status.state === 'COMPLETED'
          ? ''
          : (await runCli(fixture.root, fixture.home, ['tail', status.runId, '--json'])).stdout;
      expect(status.state, `${JSON.stringify(status)}\n${events}`).toBe('COMPLETED');
      expect(status.zones).toEqual(['backend', 'frontend']);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
