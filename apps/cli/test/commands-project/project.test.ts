import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import config from '../../src/commands/config/index.ts';
import gc from '../../src/commands/gc/index.ts';
import migrate from '../../src/commands/migrate/index.ts';
import policy from '../../src/commands/policy/index.ts';
import update from '../../src/commands/update/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('project commands', () => {
  test('config validates the generated project configuration', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-project-'));
    await mkdir(join(cwd, '.cohorte'), { recursive: true });
    await writeFile(join(cwd, '.cohorte', 'config.yaml'), 'schemaVersion: 1\n');
    const out = captureStream();
    const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
    expect(await config.run(ctx, { positionals: [], options: {}, json: false, subVerb: 'validate' })).toBe(0);
    expect(out.text()).toContain('valid');
    expect(
      await config.run(ctx, { positionals: ['policy.mode', 'strict'], options: {}, json: false, subVerb: 'set' }),
    ).toBe(0);
    expect(out.text()).toContain('updated policy.mode');
  });

  test('config trust grants, shows and revokes a project policy', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-trust-project-'));
    const home = await mkdtemp(join(tmpdir(), 'cohorte-trust-home-'));
    await mkdir(join(cwd, '.cohorte'), { recursive: true });
    await writeFile(join(cwd, '.cohorte', 'config.yaml'), 'schemaVersion: 1\npolicy:\n  dangerousCommands: []\n');
    const out = captureStream();
    const ctx = fakeCliContext({
      cwd,
      env: { HOME: home, USER: 'test-user' },
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
    });
    expect(await config.run(ctx, { positionals: ['--grant'], options: {}, json: false, subVerb: 'trust' })).toBe(0);
    expect(await config.run(ctx, { positionals: ['--show'], options: {}, json: false, subVerb: 'trust' })).toBe(0);
    expect(out.text()).toContain('"trusted":true');
    expect(await config.run(ctx, { positionals: ['--revoke'], options: {}, json: false, subVerb: 'trust' })).toBe(0);
    expect(out.text()).toContain('"revoked":true');
  });

  test('policy explain runs the real offline gate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-policy-project-'));
    const out = captureStream();
    const ctx = fakeCliContext({
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
    });
    expect(
      await policy.run(ctx, { positionals: ['node', '--version'], options: {}, json: false, subVerb: 'explain' }),
    ).toBe(0);
    expect(JSON.parse(out.text())).toMatchObject({ decision: 'deny', stage: 'command' });
  });

  test('migrate delegates to the store and update only supports --check', async () => {
    const out = captureStream();
    let mode = '';
    const ctx = fakeCliContext({
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
      openStore: async () =>
        ({
          migrate: async (value: string) => {
            mode = value;
            return { ok: true, pending: [] };
          },
          listRuns: async () => [],
          close: async () => {},
        }) as never,
      install: { installDir: () => '/dist', bundleManifest: async () => [] },
    });
    expect(await migrate.run(ctx, { positionals: [], options: {}, json: false })).toBe(0);
    expect(mode).toBe('check');
    expect(await update.run(ctx, { positionals: ['--check'], options: {}, json: false })).toBe(0);
    expect(await gc.run(ctx, { positionals: ['--dry-run'], options: {}, json: false })).toBe(0);
  });

  test('migrate prefers the pre-open migration store when one is supplied', async () => {
    const out = captureStream();
    let selected: 'regular' | 'migration' | undefined;
    const ctx = fakeCliContext({
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
      openStore: async () => {
        selected = 'regular';
        return { migrate: async () => ({ pending: [] }), close: async () => {} } as never;
      },
      openMigrationStore: async () => {
        selected = 'migration';
        return { migrate: async () => ({ pending: [] }), close: async () => {} } as never;
      },
    });
    expect(await migrate.run(ctx, { positionals: ['--apply'], options: {}, json: false })).toBe(0);
    expect(selected).toBe('migration');
  });

  test('migrate check returns 3 while migrations are pending', async () => {
    const ctx = fakeCliContext({
      openStore: async () => ({ migrate: async () => ({ pending: [{ id: 2 }] }), close: async () => {} }) as never,
    });
    expect(await migrate.run(ctx, { positionals: ['--check'], options: {}, json: false })).toBe(3);
  });
});
