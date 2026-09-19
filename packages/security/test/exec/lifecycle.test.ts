// What the executor promises around a run that is NOT killed: the verified canonical cwd (nothing is spawned when
// it does not verify), the `(pgid, startToken)` round trip through the `PidRegistry` port (DESIGN 4.4 step 5), the
// stream-drain timeout, and the `outcome` of a program that simply failed.
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type Clock, systemClock } from '@cohorte/base';
import { fakeRedactor, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import { createExecutor } from '../../src/exec/index.ts';
import { canonical, ENV_BIN, fakePidRegistry, isProcessAlive, nodeRequest } from './support.ts';

describe('the cwd must still be its own realpath at spawn time', () => {
  test('a cwd reached through a symlink is refused, and nothing is spawned', async ({ tempDir }) => {
    const real = join(tempDir, 'real');
    const link = join(tempDir, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    const pids = fakePidRegistry();
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(link), 'process.stdout.write("SHOULD-NOT-RUN")'),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('error');
    expect(result.exitCode).toBeNull();
    expect(result.tail).toBe('');
    expect(result.outputBytes).toBe(0);
    expect(pids.entries.size).toBe(0);
  });

  test('a cwd that no longer exists is refused the same way', async ({ tempDir }) => {
    const gone = join(tempDir, 'gone');
    mkdirSync(gone);
    rmSync(gone, { recursive: true });
    const pids = fakePidRegistry();
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(gone), 'process.stdout.write("SHOULD-NOT-RUN")'),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('error');
    expect(result.exitCode).toBeNull();
    expect(pids.entries.size).toBe(0);
  });
});

describe('a signal that is already aborted is a cancellation, not an executor error', () => {
  // The same signal aborting one millisecond later — after the spawn — is `killed` (see escalate('killed')). One
  // cause must have one spelling, or every dependant special-cases the pre-abort: `error` is reserved for a run
  // that could not produce a usable process (U1.04 request R3).
  test('outcome is "killed", nothing is spawned and nothing is recorded', async ({ tempDir }) => {
    const pids = fakePidRegistry();
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.run(
      nodeRequest(canonical(tempDir), 'process.stdout.write("SHOULD-NOT-RUN")'),
      controller.signal,
    );

    expect(result.outcome).toBe('killed');
    expect(result.exitCode).toBeNull();
    expect(result.outputBytes).toBe(0);
    expect(pids.entries.size).toBe(0);
  });
});

describe('the PidRegistry records the group while it runs and removes it at exit', () => {
  test('one entry, keyed by the reported pgid and carrying the reported startToken, then none', async ({ tempDir }) => {
    // The sample is taken INSIDE `record()` — the one moment the entry provably exists — instead of from an
    // `onChunk` callback, which can only observe the registry if the child happens to still be alive when its first
    // chunk is delivered. Gate G0 widened that window (a program that keeps writing for 400 ms); it did not close
    // it, and the test still failed in a full-suite run while passing in isolation (lead note L8). A test that is
    // green alone and red in the suite makes every later gate flicker, so this reads the invariant where it cannot
    // race: recorded while the group runs (here), gone at exit (`entries.size` below).
    let duringRun: Array<[number, string]> = [];
    const pids = fakePidRegistry({
      onRecord: (registry) => {
        if (duringRun.length === 0) duringRun = [...registry].map(([pgid, entry]) => [pgid, entry.startToken]);
      },
    });
    const req = nodeRequest(canonical(tempDir), 'process.stdout.write("RUNNING");');
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(duringRun).toEqual([[result.pgid, result.startToken]]);
    expect(pids.entries.size).toBe(0);
  }, 10_000);
});

describe('a program that ran to completion is `ok`, whatever its exit code', () => {
  test('exit 7 is reported as outcome "ok" with exitCode 7', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(nodeRequest(canonical(tempDir), 'process.exit(7)'), new AbortController().signal);

    // `outcome` describes how the EXECUTOR ended the process, not how the program judged itself: a non-zero exit
    // is `tool-terminal/nonzero-exit` for the caller, never `error` here. Pinned because dependants build on it.
    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeUndefined();
  }, 10_000);
});

// A program can finish before the executor has finished setting itself up — `/usr/bin/env` and friends exit in
// about a millisecond, well inside the `ps` fork that mints the start token. Node hands `'exit'` to whoever listens
// when it reaps the child and discards a `stdout` that was never resumed, so anything wired after an `await` is
// wired too late: the output vanishes and the run waits for an exit that already happened.
describe('a program that exits before the executor finishes wiring itself up', () => {
  test('its output is reported in full and the run ends at once, not at the timeout', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      {
        ...nodeRequest(canonical(tempDir), ''),
        file: ENV_BIN,
        args: [],
        env: { MARKER: 'FAST-PROGRAM' },
        timeoutMs: 30_000,
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.tail).toContain('MARKER=FAST-PROGRAM');
    expect(result.outputBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeLessThan(5_000);
  }, 40_000);

  test('the same holds on the wrapper path, where a shell and an `env` precede the program', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      {
        ...nodeRequest(canonical(tempDir), ''),
        file: ENV_BIN,
        args: [],
        env: { MARKER: 'FAST-PROGRAM' },
        timeoutMs: 30_000,
        limits: { openFiles: 256 },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.tail).toContain('MARKER=FAST-PROGRAM');
    expect(result.durationMs).toBeLessThan(5_000);
  }, 40_000);
});

// `Clock.sleep(ms, signal?)` leaves the signal OPTIONAL (@cohorte/base ports.ts). A clock that ignores it is
// therefore conforming, and `outcome` may not depend on it: cancelling the timer is an optimisation, and the fact
// that the program has already exited is the correctness condition.
describe('the timeout verdict does not depend on the Clock honouring the abort signal', () => {
  test('a Clock that ignores the signal still reports a program that exited in milliseconds as `ok`', async ({
    tempDir,
  }) => {
    const deafClock: Clock = {
      now: () => systemClock.now(),
      monotonicMs: () => systemClock.monotonicMs(),
      // The signal is simply dropped — exactly what the port permits.
      sleep: (ms: number) => systemClock.sleep(ms),
    };
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: deafClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), 'process.stdout.write("FAST")', { timeoutMs: 400 }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.tail).toBe('FAST');
  }, 15_000);
});

describe('the stream-drain timeout bounds a run whose pipes outlive the leader', () => {
  test('run() resolves even though an escapee still holds the inherited stdout open', async ({ tempDir }) => {
    const script = [
      'const cp = require("child_process").spawn(process.execPath,',
      '  ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", 1, "ignore"] });',
      'cp.unref();',
      'process.stdout.write("LEADER-DONE:" + cp.pid);',
      // Long enough for the descendant tracker to observe the escapee before the leader is reaped (S-22).
      'setTimeout(() => process.exit(0), 250);',
    ].join('\n');
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    // Without the drain timeout this never resolves: the grandchild holds the write end of the pipe forever.
    const result = await executor.run(
      nodeRequest(canonical(tempDir), script, { timeoutMs: 30_000 }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    const match = /LEADER-DONE:(\d+)/.exec(result.tail);
    expect(match).not.toBeNull();
    expect(result.durationMs).toBeLessThan(20_000);
    expect(result.escapees).toBeGreaterThanOrEqual(1);
    expect(isProcessAlive(Number(match?.[1]))).toBe(false);
  }, 30_000);
});
