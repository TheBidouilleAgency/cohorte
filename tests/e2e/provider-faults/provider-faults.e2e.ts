import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { commitFixture, createGitFixture, initAndTrust, runCli, waitForRun } from '../support/cli.ts';

const CASES = [
  { name: 'timeout', file: 'timeout.yaml', state: 'FAILED', code: 'timeout/agent' },
  { name: 'quota', file: 'quota.yaml', state: 'QUOTA_EXCEEDED', code: 'provider/rate-limit' },
  { name: 'auth', file: 'auth.yaml', state: 'AUTH_REQUIRED', code: 'provider/unauthorized' },
] as const;

describe('provider faults', () => {
  for (const fault of CASES) {
    test(`${fault.name} is classified without a provider fallback`, async ({ skip }) => {
      if (!process.env.COHORTE_E2E_BUILD_DIR) return skip('requires the integrated immutable gate build');
      const fixture = await createGitFixture();
      try {
        await initAndTrust(fixture.root, fixture.home);
        const script = join(process.cwd(), 'fixtures', 'scripts', 'faults', fault.file);
        const fixtureScript = join(fixture.root, fault.file);
        await writeFile(fixtureScript, await readFile(script));
        await writeFile(
          join(fixture.root, '.cohorte', 'ownership.yaml'),
          'surfaces:\n  backend: { paths: [backend/**], owners: [implementer], reviewers: [reviewer] }\n',
        );
        await mkdir(join(fixture.root, 'backend'));
        await writeFile(join(fixture.root, 'backend', 'index.ts'), 'export const fixture = true;\n');
        await commitFixture(fixture.root, `fault fixture ${fault.name}`, [
          fault.file,
          '.cohorte/ownership.yaml',
          'backend/index.ts',
        ]);
        expect((await runCli(fixture.root, fixture.home, ['config', 'trust', '--grant'])).code).toBe(0);
        const started = await runCli(fixture.root, fixture.home, [
          'run',
          '--runtime',
          'fake',
          '--script',
          fixtureScript,
        ]);
        expect([0, 4, 14, 18]).toContain(started.code);
        const status = await waitForRun(fixture.root, fixture.home);
        expect(status.state).toBe(fault.state);
        const observed = JSON.parse((await runCli(fixture.root, fixture.home, ['status', '--json'])).stdout) as [
          { lastError?: { code?: string } },
        ];
        expect(observed[0]?.lastError?.code).toBe(fault.code);
      } finally {
        await fixture.dispose();
      }
    }, 30_000);
  }
});
