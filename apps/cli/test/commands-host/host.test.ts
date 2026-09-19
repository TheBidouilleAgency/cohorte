import { describe, expect, test } from 'vitest';
import host from '../../src/commands/__host/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('__host', () => {
  test('requires exactly one run id and delegates to the injected host runner', async () => {
    const out = captureStream();
    const calls: string[] = [];
    const code = await host.run(
      fakeCliContext({
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        hostRunner: {
          run: async (runId) => {
            calls.push(runId);
            return { reason: 'review-clean', detail: 'done', resumable: false };
          },
        },
      }),
      { positionals: ['--run', 'run_123'], options: {}, json: false },
    );
    expect(code).toBe(0);
    expect(calls).toEqual(['run_123']);
    expect(out.text()).toContain('review-clean');
  });

  test('rejects a missing run id before touching the runner', async () => {
    await expect(host.run(fakeCliContext(), { positionals: ['--run'], options: {}, json: false })).resolves.toBe(2);
  });
});
