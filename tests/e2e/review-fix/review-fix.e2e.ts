import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { commitFixture, createGitFixture, initAndTrust, runCli, waitForRun } from '../support/cli.ts';

describe('built CLI review and fix path', () => {
  test('reaches a terminal clean review through the built CLI', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
    const fixture = await createGitFixture();
    try {
      await initAndTrust(fixture.root, fixture.home);
      await mkdir(join(fixture.root, 'backend'), { recursive: true });
      await writeFile(join(fixture.root, 'backend', 'index.ts'), 'export const value = 1;\n');
      await writeFile(
        join(fixture.root, '.cohorte', 'ownership.yaml'),
        'surfaces:\n  backend: { paths: [backend/**], owners: [implementer], reviewers: [reviewer] }\n',
      );
      const script = join(fixture.root, 'review-fix.yaml');
      await copyFile(new URL('../../../fixtures/scripts/review-fix.yaml', import.meta.url), script);
      await commitFixture(fixture.root, 'review fixture', [
        'backend/index.ts',
        '.cohorte/ownership.yaml',
        'review-fix.yaml',
      ]);
      expect((await runCli(fixture.root, fixture.home, ['config', 'trust', '--grant'])).code).toBe(0);
      const started = await runCli(fixture.root, fixture.home, [
        'run',
        '--profile',
        'review',
        '--runtime',
        'fake',
        '--script',
        script,
      ]);
      expect([0, 4]).toContain(started.code);
      expect((await waitForRun(fixture.root, fixture.home)).state).toBe('COMPLETED');
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
