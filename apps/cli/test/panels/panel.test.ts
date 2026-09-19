import { describe, expect, test } from 'vitest';
import { createRenderer } from '../../src/render/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('panels', () => {
  test('status panel renders the current runs', async () => {
    const ctx = fakeCliContext({
      openStore: async () => ({ listRuns: async () => [], close: async () => {} }) as never,
    });
    expect(await createRenderer().panel('status', ctx)).toBe(0);
  });

  test('status panel reads and closes the store', async () => {
    const out = captureStream();
    let closed = false;
    const ctx = fakeCliContext({
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
      openStore: async () =>
        ({
          listRuns: async () => [{ runId: 'run_1', state: 'IDLE' }],
          close: async () => {
            closed = true;
          },
        }) as never,
    });
    expect(await createRenderer().panel('status', ctx)).toBe(0);
    expect(out.text()).toContain('run_1 IDLE');
    expect(closed).toBe(true);
  });
});
