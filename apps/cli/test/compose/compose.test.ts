import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { composeCliContext } from '../../src/compose/index.ts';

describe('CLI composition', () => {
  test('shares one store opener and pins new runs to the installed bundle', async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const ctx = await composeCliContext({
      cwd: process.cwd(),
      env: { HOME: process.cwd() },
      stdio: { stdout: sink, stderr: sink, stdin: process.stdin },
    });
    expect(ctx.install.installDir()).toBeTypeOf('string');
    expect(ctx.hostSpawner).toBeDefined();
    expect(ctx.hostRunner).toBeDefined();
    expect(ctx.openStore).toBeDefined();
  });
});
