import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { commitFixture, createGitFixture, runCli, waitForRun, writeHappyFakeScript } from '../e2e/support/cli.ts';

test('AC-03 ownership zones are isolated in the built pipeline', async ({ skip }) => {
  if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the immutable build');
  const fixture = await createGitFixture();
  try {
    expect((await runCli(fixture.root, fixture.home, ['init', '--json', fixture.root])).code).toBe(0);
    await writeFile(
      join(fixture.root, '.cohorte', 'ownership.yaml'),
      'surfaces:\n  frontend: { paths: [frontend/**], owners: [implementer], reviewers: [reviewer] }\n  backend: { paths: [backend/**], owners: [implementer], reviewers: [reviewer] }\n',
    );
    const script = await writeHappyFakeScript(fixture.root);
    await commitFixture(fixture.root, 'acceptance ownership', ['.cohorte/ownership.yaml', 'fake-script.yaml']);
    expect((await runCli(fixture.root, fixture.home, ['config', 'trust', '--grant'])).code).toBe(0);
    const start = await runCli(fixture.root, fixture.home, ['run', '--runtime', 'fake', '--script', script]);
    expect([0, 4]).toContain(start.code);
    const status = await waitForRun(fixture.root, fixture.home);
    expect(status.state).toBe('COMPLETED');
    expect(status.zones).toEqual(['backend', 'frontend']);
  } finally {
    await fixture.dispose();
  }
});
