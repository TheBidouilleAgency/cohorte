// I3 (DESIGN 0.2, 2.6.6): arguments containing `; && | $()` and newlines reach the program as literal argv through
// the ulimit wrapper — the only shell in the product never re-parses them. The same file pins the ONE shape the
// wrapper cannot carry: a program path containing `=`, which `/usr/bin/env` would eat as a variable assignment.
import { mkdirSync, existsSync as pathExists, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '@cohorte/base';
import { fakeRedactor, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import { createExecutor } from '../../src/exec/index.ts';
import { canonical, fakePidRegistry, nodeRequest } from './support.ts';

const HOSTILE_ARGS = ['a; rm -rf /', 'b && echo pwned', 'c | cat /etc/passwd', '$(whoami)', '`id`', 'line1\nline2'];
const ECHO_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

describe('I3: hostile argv reaches the program literally, never a shell', () => {
  // THROUGH the wrapper: this is the path where a `/bin/sh` really exists, so it is the one I3 is about. Every
  // limit value and every argument is a positional parameter of a compile-time-constant script — never text
  // interpolated into it.
  test('; && | $() and newlines survive unparsed through the ulimit wrapper', async ({ tempDir }) => {
    const req = nodeRequest(canonical(tempDir), ECHO_ARGV, {
      args: ['-e', ECHO_ARGV, ...HOSTILE_ARGS],
      limits: { cpuSeconds: 30, openFiles: 256 },
    });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(0);
    const received = JSON.parse(result.tail) as string[];
    // `node -e <script> <args...>` sets `process.argv` to `[execPath, ...args]` (no extra placeholder for `-e`):
    // the script already slices off `execPath`, so what comes back is exactly the hostile args, verbatim.
    expect(received).toEqual(HOSTILE_ARGS);
  }, 10_000);

  // Without a rlimit there is no wrapper at all — `spawn(file, args)` with `shell: false`. Same literal argv, one
  // process less, and I3 holds because nothing ever parses a line.
  test('; && | $() and newlines survive unparsed on the direct-spawn path too', async ({ tempDir }) => {
    const req = nodeRequest(canonical(tempDir), ECHO_ARGV, { args: ['-e', ECHO_ARGV, ...HOSTILE_ARGS] });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.tail)).toEqual(HOSTILE_ARGS);
  }, 10_000);

  // An ARGUMENT containing `=` is safe and must stay safe: `/usr/bin/env` stops scanning operands at the first one
  // WITHOUT a `=` — which is the program — and hands everything after it through untouched.
  test('an argument that looks like a variable assignment is an argument, not an assignment', async ({ tempDir }) => {
    const script = 'process.stdout.write(JSON.stringify({argv: process.argv.slice(1), env: process.env.INJECTED}))';
    const req = nodeRequest(canonical(tempDir), script, {
      args: ['-e', script, 'INJECTED=pwned', 'PATH=/nowhere'],
      // Only the wrapper puts an `/usr/bin/env` between the shell and the program, so only a limits-bearing
      // request exercises the operand-scanning rule this test is about.
      limits: { openFiles: 256 },
    });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    const received = JSON.parse(result.tail) as { argv: string[]; env: string | undefined };
    expect(received.argv).toEqual(['INJECTED=pwned', 'PATH=/nowhere']);
    expect(received.env).toBeUndefined();
  });
});

/**
 * The program path is the ONE operand `/usr/bin/env` inspects, and it treats any operand containing `=` as a
 * variable assignment (POSIX; BSD and GNU alike — `--` does not protect it, assignments are operands, not options).
 * Left alone, a program under a directory named `a=b` would be consumed as an assignment and `env` would exec the
 * NEXT argv element — a model-influenced argument — as the program. The wrapper therefore fails closed (I2) — and
 * only where the wrapper is: a request that asks for no rlimit never builds one, so it never meets `env` either.
 */
describe('a program path `/usr/bin/env` would swallow is REFUSED, never mis-executed', () => {
  test('under a requested rlimit, a program in a directory named `a=b` refuses and no argument runs in its place', async ({
    tempDir,
  }) => {
    const dir = join(tempDir, 'a=b');
    mkdirSync(dir);
    const program = join(dir, 'prog.sh');
    writeFileSync(program, '#!/bin/sh\necho REAL-PROGRAM-RAN\n', { mode: 0o755 });
    const canary = join(tempDir, 'attacker.canary');
    const attacker = join(tempDir, 'attacker.sh');
    writeFileSync(attacker, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(canary)}\n`, { mode: 0o755 });
    const pids = fakePidRegistry();
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), '', {
        file: canonical(program),
        args: [attacker],
        limits: { openFiles: 256 },
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('error');
    expect(result.exitCode).toBeNull();
    expect(result.outputBytes).toBe(0);
    expect(result.tail).toBe('');
    // The whole point: the attacker-chosen argv element was NOT executed in the program's place.
    expect(pathExists(canary)).toBe(false);
    expect(pids.entries.size).toBe(0);
    // Loud, not silent: the refusal says which path it refused and why.
    expect(result.guarantees.notes.join(' ')).toContain(program);
  }, 10_000);

  // The refusal is the price of the wrapper, and nothing else may pay it. A request with empty `limits` has no
  // wrapper — no `/bin/sh`, no `/usr/bin/env`, no operand to misread — so the same program simply runs. Otherwise a
  // worktree whose path merely contains `=` could execute no command at all at L0 (U1.04 request R4).
  test('with no rlimit requested there is no wrapper, so the very same program runs normally', async ({ tempDir }) => {
    const dir = join(tempDir, 'a=b');
    mkdirSync(dir);
    const program = join(dir, 'prog.sh');
    writeFileSync(program, '#!/bin/sh\necho "REAL-PROGRAM-RAN:$1"\n', { mode: 0o755 });
    const pids = fakePidRegistry();
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), '', { file: canonical(program), args: ['kept; literal'] }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.tail.trim()).toBe('REAL-PROGRAM-RAN:kept; literal');
    expect(result.guarantees.notes).toEqual([]);
  }, 10_000);

  test('the same program under a `=`-free directory runs, with its argv intact (control)', async ({ tempDir }) => {
    const dir = join(tempDir, 'ab');
    mkdirSync(dir);
    const program = join(dir, 'prog.sh');
    writeFileSync(program, '#!/bin/sh\necho "REAL-PROGRAM-RAN:$1"\n', { mode: 0o755 });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), '', { file: canonical(program), args: ['kept; literal'] }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.tail.trim()).toBe('REAL-PROGRAM-RAN:kept; literal');
  }, 10_000);
});
