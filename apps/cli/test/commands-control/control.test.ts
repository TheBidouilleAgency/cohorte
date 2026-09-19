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
