// S-23 (DESIGN 2.6.6, 7.4): the output cap KILLS on overflow, it does not merely stop reading.
import { systemClock } from '@cohorte/base';
import { fakeRedactor, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import { createExecutor } from '../../src/exec/index.ts';
import { canonical, fakePidRegistry, isProcessAlive, nodeRequest } from './support.ts';

describe('S-23: the output cap kills', () => {
  test('a process that never stops writing is killed once maxOutputBytes is exceeded', async ({ tempDir }) => {
    const script = 'setInterval(() => process.stdout.write("x".repeat(1024)), 5);';
    const req = nodeRequest(canonical(tempDir), script, { maxOutputBytes: 4_096, timeoutMs: 20_000 });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('output-capped');
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(4_096);
    expect(isProcessAlive(result.pgid)).toBe(false);
  }, 10_000);
});
