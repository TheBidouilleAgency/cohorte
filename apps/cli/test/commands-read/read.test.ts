import { describe, expect, test } from 'vitest';
import inspect from '../../src/commands/inspect/index.ts';
import logs from '../../src/commands/logs/index.ts';
import tail from '../../src/commands/tail/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('read commands', () => {
  test('logs, tail and inspect read through the store', async () => {
    const out = captureStream();
    const store = {
      readEvents: async () => [{ sequence: 1, type: 'run.created', payload: {} }],
      readRunTree: async () => ({ run: { runId: 'run_1', state: 'IDLE' }, phases: [], agents: [] }),
      close: async () => {},
    };
    const ctx = fakeCliContext({
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
      openStore: async () => store as never,
    });
    expect(await logs.run(ctx, { positionals: ['run_1'], options: {}, json: false })).toBe(0);
    expect(await tail.run(ctx, { positionals: ['run_1'], options: {}, json: false })).toBe(0);
    expect(await inspect.run(ctx, { positionals: ['run_1'], options: {}, json: true })).toBe(0);
    expect(out.text()).toContain('run.created');
    expect(out.text()).toContain('IDLE');
  });
});
