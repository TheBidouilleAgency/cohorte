import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import brainstorm from '../../src/commands/brainstorm/index.ts';
import config from '../../src/commands/config/index.ts';
import gc from '../../src/commands/gc/index.ts';
import init from '../../src/commands/init/index.ts';
import migrate from '../../src/commands/migrate/index.ts';
import policy from '../../src/commands/policy/index.ts';
import spec from '../../src/commands/spec/index.ts';
import update from '../../src/commands/update/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('project commands', () => {
  test('brainstorm creates a draft V3 spec from an idea without overwriting existing work', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-brainstorm-'));
    try {
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(
        await brainstorm.run(ctx, {
          positionals: ['Ajouter un calendrier équipe'],
          options: {},
          json: true,
        }),
      ).toBe(0);
      const result = JSON.parse(out.text()) as { id: string; path: string; status: string };
      expect(result).toMatchObject({ id: 'ajouter-un-calendrier-equipe', status: 'draft' });
      await expect(readFile(result.path, 'utf8')).resolves.toContain('status: draft');
      await expect(
        readFile(join(cwd, 'specs', 'reports', 'ajouter-un-calendrier-equipe-brainstorm.md'), 'utf8'),
      ).resolves.toContain('## Perspectives');

      await expect(
        brainstorm.run(ctx, {
          positionals: ['Ajouter un calendrier équipe'],
          options: {},
          json: true,
        }),
      ).rejects.toThrow('refusing to overwrite');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('brainstorm --run delegates the panel to the native Pi BRAINSTORM phase', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-brainstorm-run-'));
    try {
      const out = captureStream();
      const calls: unknown[] = [];
      const ctx = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        controller: {
          send: async (_command: string, payload: unknown) => {
            calls.push(payload);
            return { status: 'pending', result: { runId: 'run_brainstorm' } };
          },
        } as never,
        hostSpawner: { spawnDetached: async () => ({ pid: 1 }) } as never,
      });
      expect(
        await brainstorm.run(ctx, {
          positionals: ['Préparer le lancement', '--run'],
          options: {},
          json: true,
        }),
      ).toBe(4);
      expect(calls[0]).toMatchObject({
        runtime: 'pi',
        phases: ['BRAINSTORM', 'SPEC', 'PREFLIGHT', 'BUILD', 'TEST', 'REVIEW', 'FIX', 'TEST', 'REVIEW', 'SHIP'],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('spec validate and freeze resolve legacy-compatible markdown specs by feature id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-spec-md-'));
    try {
      await mkdir(join(cwd, 'specs'), { recursive: true });
      await writeFile(join(cwd, 'specs', 'calendar.md'), '---\nstatus: draft\n---\n\n# Calendar\n');
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(await spec.run(ctx, { subVerb: 'validate', positionals: ['calendar'], options: {}, json: true })).toBe(0);
      expect(await spec.run(ctx, { subVerb: 'freeze', positionals: ['calendar'], options: {}, json: true })).toBe(0);
      await expect(readFile(join(cwd, 'specs', 'calendar.md'), 'utf8')).resolves.toContain('status: frozen');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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

  test('runs the real V2 export, preview, import and rollback CLI flow', async () => {
    const source = await mkdtemp(join(tmpdir(), 'cohorte-cli-v2-source-'));
    const bundle = await mkdtemp(join(tmpdir(), 'cohorte-cli-v2-bundle-'));
    const target = await mkdtemp(join(tmpdir(), 'cohorte-cli-v3-target-'));
    try {
      await mkdir(join(source, 'specs'), { recursive: true });
      await writeFile(join(source, 'PIPELINE.md'), '# Project\n\nversion: 2.10.0\n');
      await writeFile(join(source, 'cohorte.config.yaml'), 'pipeline:\n  name: demo\n');
      await writeFile(join(source, 'specs', 'feature.md'), '# Feature\n');

      const exportOut = captureStream();
      const sourceCtx = fakeCliContext({
        cwd: source,
        stdio: { stdout: exportOut.stream, stderr: exportOut.stream, stdin: process.stdin },
      });
      expect(await init.run(sourceCtx, { positionals: ['--export-v2', bundle], options: {}, json: false })).toBe(0);
      expect(JSON.parse(exportOut.text()).manifest.format).toBe('cohorte-v2-export');

      const previewOut = captureStream();
      const targetCtx = fakeCliContext({
        cwd: target,
        stdio: { stdout: previewOut.stream, stderr: previewOut.stream, stdin: process.stdin },
      });
      expect(await init.run(targetCtx, { positionals: ['--from-v2', bundle], options: {}, json: false })).toBe(0);
      expect(JSON.parse(previewOut.text()).conflicts).toEqual([]);
      await expect(readFile(join(target, '.cohorte', 'manifest.yaml'))).rejects.toThrow();

      const importOut = captureStream();
      const importCtx = fakeCliContext({
        cwd: target,
        stdio: { stdout: importOut.stream, stderr: importOut.stream, stdin: process.stdin },
      });
      expect(await init.run(importCtx, { positionals: ['--from-v2', bundle, '--yes'], options: {}, json: false })).toBe(
        0,
      );
      const report = JSON.parse(importOut.text()) as { reportId: string };
      await expect(readFile(join(target, '.cohorte', 'specs', 'feature.yaml'), 'utf8')).resolves.toContain(
        'title: Feature',
      );

      const rollbackOut = captureStream();
      const rollbackCtx = fakeCliContext({
        cwd: target,
        stdio: { stdout: rollbackOut.stream, stderr: rollbackOut.stream, stdin: process.stdin },
      });
      expect(
        await migrate.run(rollbackCtx, {
          positionals: ['--rollback', report.reportId],
          options: {},
          json: false,
        }),
      ).toBe(0);
      expect(JSON.parse(rollbackOut.text())).toMatchObject({ reportId: report.reportId, status: 'rolled-back' });
      await expect(readFile(join(target, '.cohorte', 'project.yaml'))).rejects.toThrow();
    } finally {
      await Promise.all([
        rm(source, { recursive: true, force: true }),
        rm(bundle, { recursive: true, force: true }),
        rm(target, { recursive: true, force: true }),
      ]);
    }
  });
});
