import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import cancel from '../../src/commands/cancel/index.ts';
import pause from '../../src/commands/pause/index.ts';
import resume from '../../src/commands/resume/index.ts';
import run from '../../src/commands/run/index.ts';
import { fakeCliContext } from '../registry/helpers.ts';

describe('run and control commands', () => {
  test('run starts a feature pipeline and asks the host spawner to detach', async () => {
    const calls: unknown[] = [];
    const ctx = fakeCliContext({
      controller: {
        send: async (...args: unknown[]) => {
          calls.push(args);
          return { status: 'pending', result: { runId: 'run_1' } } as never;
        },
      },
      hostSpawner: {
        spawnDetached: async (runId) => {
          calls.push(['spawn', runId]);
          return { pid: 1 };
        },
      },
    });
    expect(await run.run(ctx, { positionals: ['feature'], options: {}, json: true })).toBe(4);
    expect(calls).toEqual([
      ['start', { profile: 'feature', unattended: false }],
      ['spawn', 'run_1'],
    ]);
  });

  test('run keeps a brainstorm ticket in Brainstorm until BUILD actually starts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cohorte-run-obsidian-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-run-obsidian-project-'));
    const vault = await mkdtemp(join(tmpdir(), 'cohorte-run-obsidian-vault-'));
    try {
      await mkdir(join(home, '.cohorte'), { recursive: true });
      await writeFile(
        join(home, '.cohorte', 'config.yaml'),
        `schemaVersion: 1\nintegrations:\n  obsidian:\n    vaultPath: ${vault}\n    board: Tasks.md\n`,
      );
      await writeFile(join(vault, 'Tasks.md'), '## Ideas\n\n## Brainstorm\n- [ ] Draft #mf-001\n\n## Building\n');

      const ctx = fakeCliContext({
        cwd,
        env: { HOME: home },
        controller: {
          send: async () => ({ status: 'pending', result: { runId: 'run_brainstorm' } }) as never,
        },
        hostSpawner: { spawnDetached: async () => ({ pid: 1 }) },
      });

      expect(
        await run.run(ctx, {
          positionals: ['mf-001', '--phases', 'BRAINSTORM,SPEC,PREFLIGHT,BUILD,TEST,REVIEW,SHIP'],
          options: {},
          json: false,
        }),
      ).toBe(4);
      await expect(readFile(join(vault, 'Tasks.md'), 'utf8')).resolves.toContain('## Brainstorm\n- [ ] Draft #mf-001');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('control verbs route their run id and payload to the controller', async () => {
    const calls: unknown[] = [];
    const ctx = fakeCliContext({
      controller: {
        send: async (...args: unknown[]) => {
          calls.push(args);
          return { status: 'pending' } as never;
        },
      },
    });
    expect(await pause.run(ctx, { positionals: ['run_1', 'human'], options: {}, json: true })).toBe(4);
    expect(await cancel.run(ctx, { positionals: ['run_1'], options: {}, json: true })).toBe(4);
    expect(await resume.run(ctx, { positionals: ['run_1'], options: {}, json: true })).toBe(4);
    expect(calls).toEqual([
      ['pause', { reason: 'human' }, { runId: 'run_1' }],
      ['cancel', { keepWorktrees: false }, { runId: 'run_1' }],
      ['resume', {}, { runId: 'run_1' }],
    ]);
  });
});
