// S-24 (DESIGN 2.6.6, 7.4): the rlimits of the constant `ulimit` wrapper are really applied — and where the kernel
// refuses one, that is REPORTED, never silently skipped. `ulimit -u` is a per-USER, system-wide limit, so the fork
// bomb's bound is set relative to what is already running for this user rather than a fixed number, to stay
// meaningful (and non-flaky) on a busy development machine.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '@cohorte/base';
import { fakeRedactor, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { ExecRequest } from '../../src/contract/index.ts';
import { createExecutor } from '../../src/exec/index.ts';
import { canonical, fakePidRegistry, nodeRequest } from './support.ts';

const SH_BIN = canonical('/bin/sh');

function currentUserProcessCount(): number {
  const out = execFileSync('ps', ['-U', userInfo().username, '-o', 'pid='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.trim().length > 0).length;
}

/** Does this kernel refuse `ulimit -u <value>` outright? (It does on macOS for a value above the hard limit.) */
function kernelRefusesProcessLimit(value: number): boolean {
  return spawnSync('/bin/sh', ['-c', `ulimit -u ${value}`], { stdio: 'ignore' }).status !== 0;
}

function currentUserProcessHardLimit(): number | undefined {
  const out = spawnSync('/bin/sh', ['-c', 'ulimit -Hu'], { encoding: 'utf8' });
  if (out.status !== 0) return undefined;
  const value = Number.parseInt(out.stdout.trim(), 10);
  return Number.isFinite(value) ? value : undefined;
}

// Spawns up to ATTEMPTS children as fast as possible; each one exits immediately. Reports how many succeeded vs.
// failed to fork (EAGAIN once the ulimit is hit), so an enforced bound is REPORTED rather than silently absorbed.
const forkBombScript = (attempts: number): string =>
  [
    `const attempts = ${attempts};`,
    'let spawned = 0, failed = 0, pending = attempts;',
    'const { spawn } = require("child_process");',
    'const done = () => { if (--pending === 0) process.stdout.write(JSON.stringify({ spawned, failed })); };',
    'for (let i = 0; i < attempts; i++) {',
    '  try {',
    '    const cp = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });',
    '    cp.once("error", () => { failed++; done(); });',
    '    cp.once("exit", () => { spawned++; done(); });',
    '  } catch { failed++; done(); }',
    '}',
  ].join('\n');

describe('S-24: fork bomb bounded where processes is enforced, reported otherwise', () => {
  test('limits.processes bounds the number of successful forks, and the count is reported', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });
    const attempts = 30;

    const unbounded = await executor.run(
      nodeRequest(canonical(tempDir), forkBombScript(attempts), { timeoutMs: 15_000 }),
      new AbortController().signal,
    );
    expect(unbounded.outcome).toBe('ok');
    const unboundedReport = JSON.parse(unbounded.tail) as { spawned: number; failed: number };
    expect(unboundedReport.spawned + unboundedReport.failed).toBe(attempts);

    const hardLimit = currentUserProcessHardLimit();
    const bound = Math.min(hardLimit ?? Number.MAX_SAFE_INTEGER, currentUserProcessCount() + 16);
    const bounded = await executor.run(
      nodeRequest(canonical(tempDir), forkBombScript(attempts), {
        timeoutMs: 15_000,
        limits: { processes: bound },
      }),
      new AbortController().signal,
    );
    expect(bounded.outcome).toBe('ok');
    const boundedReport = JSON.parse(bounded.tail) as { spawned: number; failed: number };
    // Bounded and REPORTED: never silently fewer attempts, never silently ignored failures.
    expect(boundedReport.spawned + boundedReport.failed).toBe(attempts);
    expect(boundedReport.spawned).toBeLessThan(unboundedReport.spawned);
  }, 30_000);
});

describe('all four rlimits of DESIGN 2.6.6 reach the program', () => {
  test('the child reads back exactly the -t/-f/-n/-u values that were asked for', async ({ tempDir }) => {
    const req: ExecRequest = {
      ...nodeRequest(canonical(tempDir), ''),
      file: SH_BIN,
      args: ['-c', 'ulimit -t; ulimit -f; ulimit -n; ulimit -u'],
      limits: {
        cpuSeconds: 30,
        fileSizeBytes: 8 * 1024,
        openFiles: 64,
        processes: Math.min(currentUserProcessHardLimit() ?? 128, 128),
      },
    };
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    // `ulimit -f` is counted in 1 KiB blocks, which is why `fileSizeBytes` is rounded up to whole blocks.
    expect(result.tail.trim().split('\n')).toEqual([
      '30',
      '8',
      '64',
      String(Math.min(currentUserProcessHardLimit() ?? 128, 128)),
    ]);
  }, 10_000);

  // `fileSizeBytes: 0` is a request, not an absence: "this command may create no file at all" is precisely what
  // `ulimit -f 0` exists for. Rounding it up to one block would hand the caller 1024 writable bytes while
  // `guarantees` still claims the limit was applied.
  test('fileSizeBytes: 0 reaches the program as `ulimit -f 0`, not as one block', async ({ tempDir }) => {
    const req: ExecRequest = {
      ...nodeRequest(canonical(tempDir), ''),
      file: SH_BIN,
      args: ['-c', 'ulimit -f'],
      limits: { fileSizeBytes: 0 },
    };
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(result.tail.trim()).toBe('0');
  }, 10_000);

  test('fileSizeBytes: 0 really forbids creating a file', async ({ tempDir }) => {
    const target = join(tempDir, 'forbidden.bin');
    const script = `try { require("fs").writeFileSync(${JSON.stringify(target)}, "x"); } catch (e) { process.stdout.write("REFUSED:" + e.code); }`;
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), script, { limits: { fileSizeBytes: 0 } }),
      new AbortController().signal,
    );

    // Either the write is refused (EFBIG) or the kernel kills the writer with SIGXFSZ; never a file with bytes in it.
    expect(existsSync(target) && statSync(target).size > 0).toBe(false);
    expect(result.tail.includes('REFUSED') || result.signal === 'SIGXFSZ').toBe(true);
  }, 10_000);

  test('cpuSeconds is what licenses `cpuTime: "enforced"`: a busy loop dies of SIGXCPU', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), 'for (;;) Math.sqrt(Math.random());', {
        timeoutMs: 60_000,
        limits: { cpuSeconds: 1 },
      }),
      new AbortController().signal,
    );

    expect(result.signal).toBe('SIGXCPU');
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(30_000);
  }, 60_000);

  test('fileSizeBytes truncates a write at the rounded block boundary', async ({ tempDir }) => {
    const target = join(tempDir, 'big.bin');
    const script = `require("fs").writeFileSync(${JSON.stringify(target)}, Buffer.alloc(64 * 1024));`;
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), script, { limits: { fileSizeBytes: 8 * 1024 } }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.exitCode).not.toBe(0);
    expect(result.tail).toContain('EFBIG');
    expect(statSync(target).size).toBe(8 * 1024);
  }, 10_000);
});

describe('a rlimit the kernel refuses is never reported as an enforced, successful run', () => {
  test('an unattainable `processes` limit fails the run instead of running unlimited', async ({ tempDir }) => {
    const unattainable = 9_999_999;
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), 'process.stdout.write("RAN")', { limits: { processes: unattainable } }),
      new AbortController().signal,
    );

    if (kernelRefusesProcessLimit(unattainable)) {
      // Fail closed: the wrapper refuses to `exec` the program rather than run it without the limit it promised.
      expect(result.outcome).toBe('error');
      expect(result.tail).not.toContain('RAN');
    } else {
      // This kernel really can grant it; then the run is legitimately `ok` and the limit is genuinely in force.
      expect(result.outcome).toBe('ok');
      expect(result.tail).toBe('RAN');
    }
    // Either way: never "ok, with the limit silently dropped".
    expect(result.guarantees.processes).toBe('enforced');
  }, 10_000);
});
