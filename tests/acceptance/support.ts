import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createGitFixture, initAndTrust, runCli, waitForRun, writeHappyFakeScript } from '../e2e/support/cli.ts';

export async function completedFixture(profile = 'feature'): Promise<Awaited<ReturnType<typeof createGitFixture>>> {
  const fixture = await createGitFixture();
  await initAndTrust(fixture.root, fixture.home);
  const script = await writeHappyFakeScript(fixture.root);
  const start = await runCli(fixture.root, fixture.home, [
    'run',
    '--profile',
    profile,
    '--runtime',
    'fake',
    '--script',
    script,
  ]);
  expect([0, 4]).toContain(start.code);
  const status = await waitForRun(fixture.root, fixture.home);
  expect(status.state).toBe('COMPLETED');
  expect(status.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(status.runtimePin?.digest).toMatch(/^[0-9a-f]{64}$/);
  return fixture;
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export const repoRoot = process.cwd();
export const schemaPath = (name: string): string => join(repoRoot, 'schemas', `${name}.schema.json`);
