import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildPermissionsSecrets } from '../../fixtures/repos/permissions-secrets/build.ts';
import { initAndTrust, runCli, waitForRun } from '../e2e/support/cli.ts';

describe('security permissions-secrets fixture', () => {
  test('denies a secret-file read and keeps the secret out of the event stream', async ({ skip }) => {
    if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
    const fixture = await buildPermissionsSecrets();
    const home = join(fixture.root, 'home');
    try {
      await initAndTrust(fixture.root, home);
      await copyFile(
        join(process.cwd(), 'fixtures', 'scripts', 'security', 'deny-secret.yaml'),
        join(fixture.root, 'deny-secret.yaml'),
      );
      const started = await runCli(fixture.root, home, [
        'run',
        '--runtime',
        'fake',
        '--script',
        join(fixture.root, 'deny-secret.yaml'),
      ]);
      expect([0, 4]).toContain(started.code);
      const status = await waitForRun(fixture.root, home);
      expect(status.zones).toContain('src');
      const tail = await runCli(fixture.root, home, ['tail', status.runId, '--json']);
      expect(tail.code).toBe(0);
      expect(tail.stdout).toContain('tool.denied');
      expect(tail.stdout).not.toContain(fixture.secret);
      expect(tail.stdout).not.toContain('TOKEN=');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);
});
