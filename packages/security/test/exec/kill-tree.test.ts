// S-21, S-22 and the "never kill a bare pid" invariant (DESIGN 2.6.6, 4.4 step 5). Real process timing: these tests
// spawn real OS processes and wait for real signals, so they use the real clock, not a fake one.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '@cohorte/base';
import { fakeRedactor, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import {
  killGroup,
  killGroupMembers,
  sweepTracked,
  type TrackedDescendants,
  trackDescendants,
} from '../../src/exec/identity.ts';
import { createExecutor, processStartToken, type SweepByTokenResult, sweepGroupByToken } from '../../src/exec/index.ts';
import { canonical, fakePidRegistry, isProcessAlive, NODE_BIN, nodeRequest, sleep } from './support.ts';

/** One poll of the real process table, exactly as the executor tracks: `pid -> start time`, for `rootPid`'s tree. */
async function trackOnce(rootPid: number): Promise<TrackedDescendants> {
  const seen: TrackedDescendants = new Map<number, string>();
  await trackDescendants(rootPid, seen, Promise.resolve(), (ms) => systemClock.sleep(ms), {
    initialMs: 10,
    maxMs: 10,
    rampAfterMs: 10,
  });
  return seen;
}

describe('S-21: timeout kills a grandchild that ignores SIGTERM', () => {
  test('both the leader and a SIGTERM-ignoring grandchild are dead once run() resolves', async ({ tempDir }) => {
    const script = [
      'const cp = require("child_process").spawn(process.execPath,',
      '  ["-e", "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"], {stdio:"ignore"});',
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("GRANDCHILD:" + cp.pid);',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const req = nodeRequest(canonical(tempDir), script, { timeoutMs: 200 });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('timed-out');
    const match = /GRANDCHILD:(\d+)/.exec(result.tail);
    expect(match).not.toBeNull();
    const grandchildPid = Number(match?.[1]);
    expect(isProcessAlive(result.pgid)).toBe(false);
    expect(isProcessAlive(grandchildPid)).toBe(false);
  }, 10_000);
});

describe('S-22: a setsid() escapee is found by the post-run sweep', () => {
  test('a detached grandchild that leaves the process group is still killed, and counted', async ({ tempDir }) => {
    const script = [
      'const cp = require("child_process").spawn(process.execPath,',
      '  ["-e", "setInterval(()=>{},1000)"], {detached: true, stdio: "ignore"});',
      'cp.unref();',
      'process.stdout.write("ESCAPEE:" + cp.pid);',
      'setTimeout(() => process.exit(0), 250);',
    ].join('\n');
    const req = nodeRequest(canonical(tempDir), script, { timeoutMs: 5_000 });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    const match = /ESCAPEE:(\d+)/.exec(result.tail);
    expect(match).not.toBeNull();
    const escapeePid = Number(match?.[1]);
    expect(result.escapees).toBeGreaterThanOrEqual(1);
    expect(isProcessAlive(escapeePid)).toBe(false);
  }, 10_000);
});

// `ExecResult.escapees` is DESIGN 2.6.6's "processes that left the group, found by the post-run sweep" — a
// diagnostic that DESIGN 4.4 resume reporting and any `escapees > 0` alerting reads. An ordinary grandchild that
// merely outlives the leader without ever leaving the process group is NOT one of them: counting it would raise a
// false alarm on every routine run that spawns a child. The kill stays total either way.
describe('escapees counts what LEFT the group, not everything that outlived the leader', () => {
  // Measured on `sweepTracked` itself, with a real group the test builds: a leader of its own group (detached), one
  // child that stays in it and one that `setsid()`s away. Through `run()` the same distinction is timing-dependent
  // (the post-exit `killGroupMembers` usually reaps the in-group child first), so it is pinned here.
  test('of two tracked survivors, only the one whose pgid changed is counted — and both are killed', async () => {
    const script = [
      'const { spawn } = require("child_process");',
      'const member = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)"],',
      '  { stdio: "ignore" });',
      'const escapee = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)"],',
      '  { detached: true, stdio: "ignore" });',
      'escapee.unref();',
      'process.stdout.write(JSON.stringify({ member: member.pid, escapee: escapee.pid }));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const leader = spawn(NODE_BIN, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const leaderPid = leader.pid as number;
    const reported = await new Promise<{ member: number; escapee: number }>((resolve) => {
      leader.stdout?.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8'))));
    });
    try {
      // The tracker's own map, built the way the executor builds it — pid -> start time, never a bare pid.
      const seen = await trackOnce(leaderPid);
      expect(seen.has(reported.member)).toBe(true);
      expect(seen.has(reported.escapee)).toBe(true);

      // The leader is its own group (detached), the member inherited that pgid, the escapee left it.
      const swept = await sweepTracked(seen, leaderPid, (ms) => systemClock.sleep(ms), 100);

      expect(swept).toBe(1);
      await sleep(100);
      expect(isProcessAlive(reported.member)).toBe(false);
      expect(isProcessAlive(reported.escapee)).toBe(false);
    } finally {
      process.kill(-leaderPid, 'SIGKILL');
    }
  }, 15_000);

  test('a grandchild that stays in the process group is killed but reported as zero escapees', async ({ tempDir }) => {
    const script = [
      'const cp = require("child_process").spawn(process.execPath,',
      '  ["-e", "setInterval(()=>{},1000)"], {stdio: "ignore"});',
      'process.stdout.write("INGROUP:" + cp.pid);',
      // Long enough for the descendant tracker to see it before the leader is reaped.
      'setTimeout(() => process.exit(0), 250);',
    ].join('\n');
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), script, { timeoutMs: 5_000 }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    const match = /INGROUP:(\d+)/.exec(result.tail);
    expect(match).not.toBeNull();
    const childPid = Number(match?.[1]);
    expect(result.escapees).toBe(0);
    // Still swept: "not an escapee" is about the COUNT, never about letting a process survive.
    expect(isProcessAlive(childPid)).toBe(false);
  }, 10_000);
});

// The in-run sweep is held to the SAME rule as the cross-restart one (DESIGN 4.4 step 5, "never kills on a bare
// pid"). A long command forks hundreds of short-lived children; by the end their pids are dead and the OS is free to
// hand those numbers to unrelated processes of the same user. A tracked NUMBER is therefore never a target — only a
// tracked number whose start time is still the one that was recorded.
describe('sweepTracked verifies identity: a recycled pid number is neither killed nor counted', () => {
  test('a tracked pid whose start time no longer matches is left alone, and reported as no escapee', async () => {
    // The victim stands in for "the process that now holds a number this run once tracked": it is nobody's
    // descendant, shares no group with the (nonexistent) leader, and its recorded start time is stale.
    const victim = spawn(NODE_BIN, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => victim.once('spawn', () => resolve()));
    const victimPid = victim.pid as number;
    try {
      const stale: TrackedDescendants = new Map([[victimPid, 'Thu Jan  1 00:00:00 1970']]);

      const swept = await sweepTracked(stale, 999_999, (ms) => systemClock.sleep(ms), 100);

      expect(swept).toBe(0);
      await sleep(150);
      expect(isProcessAlive(victimPid)).toBe(true);
    } finally {
      process.kill(-victimPid, 'SIGKILL');
    }
  }, 15_000);

  test('a tracked pid that is simply gone costs nothing and counts as no escapee', async () => {
    const child = spawn(NODE_BIN, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const deadPid = child.pid as number;

    const swept = await sweepTracked(
      new Map([[deadPid, 'Thu Jan  1 00:00:00 1970']]),
      999_999,
      (ms) => systemClock.sleep(ms),
      100,
    );

    expect(swept).toBe(0);
  }, 15_000);

  test('the live descendant of the same tracker IS killed: verification narrows the sweep, it does not disable it', async () => {
    const script = [
      'require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const leader = spawn(NODE_BIN, ['-e', script], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => leader.once('spawn', () => resolve()));
    const leaderPid = leader.pid as number;
    await sleep(300);
    try {
      const seen = await trackOnce(leaderPid);
      const [childPid] = [...seen.keys()];
      expect(childPid).toBeDefined();

      await sweepTracked(seen, leaderPid, (ms) => systemClock.sleep(ms), 100);

      await sleep(150);
      expect(isProcessAlive(childPid as number)).toBe(false);
    } finally {
      process.kill(-leaderPid, 'SIGKILL');
    }
  }, 15_000);
});

// `kill(-0)` addresses the CALLER's own process group — the run host — and `kill(-1)` every process the user may
// signal. `ExecResult.pgid` is `0` on every early return (nothing was spawned), so a dependant that feeds a result
// back into a sweep must not be able to turn that sentinel into a signal.
describe('pgid 0 and 1 are never signalled', () => {
  test('sweepGroupByToken refuses them without probing anything', async () => {
    const options = { wait: (ms: number) => systemClock.sleep(ms), graceMs: 0 };

    expect(await sweepGroupByToken(0, 'any-token', options)).toEqual({ verified: false, killed: false });
    expect(await sweepGroupByToken(1, 'any-token', options)).toEqual({ verified: false, killed: false });
  }, 10_000);

  test('killGroupMembers refuses them and signals nobody', async () => {
    expect(await killGroupMembers(0, (ms) => systemClock.sleep(ms), 0)).toBe(0);
    expect(await killGroupMembers(1, (ms) => systemClock.sleep(ms), 0)).toBe(0);
  }, 10_000);

  // A non-detached child shares THIS process' group, so an unguarded `killGroup(0)` would TERM/KILL it (and the
  // test runner with it). Its survival is the assertion.
  test('killGroup(0) signals nothing: a child in the caller own group survives', async () => {
    const child = spawn(NODE_BIN, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    const pid = child.pid as number;
    try {
      await killGroup(0, (ms) => systemClock.sleep(ms), 0);
      await sleep(50);
      expect(isProcessAlive(pid)).toBe(true);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  }, 10_000);
});

// DESIGN 2.6.6 spells the kill tree `TERM -> grace -> KILL`, and the post-exit safety net is a kill path like any
// other: a grandchild that outlived a command which ended NORMALLY is the one that most deserves the chance to flush
// and exit on the TERM. With a zero grace the TERM and the KILL land in the same macrotask and no real process can
// use the first.
describe('killGroupMembers gives the grace of TERM -> grace -> KILL', () => {
  test('a member that handles SIGTERM gets to run its handler before the KILL', async ({ tempDir }) => {
    const marker = join(tempDir, 'terminated.marker');
    const memberScript = [
      'process.on("SIGTERM", () => {',
      `  require("fs").writeFileSync(${JSON.stringify(marker)}, "handled");`,
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const leaderScript = [
      'const { spawn } = require("child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(memberScript)}], { stdio: "ignore" });`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const leader = spawn(NODE_BIN, ['-e', leaderScript], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => leader.once('spawn', () => resolve()));
    const leaderPid = leader.pid as number;
    await sleep(400);
    try {
      const signalled = await killGroupMembers(leaderPid, (ms) => systemClock.sleep(ms), 300);

      expect(signalled).toBe(1);
      expect(existsSync(marker)).toBe(true);
    } finally {
      process.kill(-leaderPid, 'SIGKILL');
    }
  }, 15_000);
});

describe('never kills on a bare pid: sweepGroupByToken verifies the start token first', () => {
  test('a mismatched token performs no kill', async () => {
    const child = spawn(NODE_BIN, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    const pid = child.pid;
    expect(pid).toBeDefined();
    try {
      await sleep(50);
      const result = await sweepGroupByToken(pid as number, 'definitely-not-the-real-token', {
        wait: (ms) => systemClock.sleep(ms),
        graceMs: 100,
      });
      expect(result).toEqual({ verified: false, killed: false });
      expect(isProcessAlive(pid as number)).toBe(true);
    } finally {
      process.kill(-(pid as number), 'SIGKILL');
    }
  }, 10_000);

  test('the real start token verifies and kills the group', async () => {
    const child = spawn(NODE_BIN, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    const pid = child.pid as number;
    await sleep(50);
    const token = await processStartToken(pid);
    expect(token).toBeDefined();

    const result = await sweepGroupByToken(pid, token as string, { wait: (ms) => systemClock.sleep(ms), graceMs: 100 });

    expect(result).toEqual({ verified: true, killed: true });
    await sleep(50);
    expect(isProcessAlive(pid)).toBe(false);
  }, 10_000);
});

// The token is minted at the `'spawn'` event, when the leader's image is still `/bin/sh -c '<ulimit script>'`; every
// later reading of it — which is ALL the Resumer ever has (DESIGN 4.4 step 5) — sees the post-`exec` image. A token
// that mixes anything image-dependent into the hash therefore cannot round trip through the wrapper, and the
// stateless orphan sweep silently degrades to "found nothing". Measured through the real executor, not a bare pid.
describe('the start token survives the ulimit wrapper `exec` (round trip through createExecutor)', () => {
  test('processStartToken(pgid), read while the program runs, equals the recorded ExecResult.startToken', async ({
    tempDir,
  }) => {
    const pids = fakePidRegistry();
    let observed: Promise<string | undefined> = Promise.resolve(undefined);
    const req = nodeRequest(
      canonical(tempDir),
      'setTimeout(() => process.stdout.write("RUNNING"), 100);setTimeout(() => {}, 400);',
      {
        // A rlimit is what puts the `/bin/sh` wrapper in the picture at all: without one the executor spawns the
        // program directly and this test would prove nothing about surviving its `exec`.
        limits: { openFiles: 256 },
        onChunk: () => {
          const [pgid] = [...pids.entries.keys()];
          if (pgid !== undefined) observed = processStartToken(pgid);
        },
      },
    );
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(result.startToken).not.toMatch(/^unknown:/);
    expect(await observed).toBe(result.startToken);
  }, 15_000);

  test('sweepGroupByToken(pgid, startToken) verifies the recorded pair and stops the group', async ({ tempDir }) => {
    const pids = fakePidRegistry();
    let swept: Promise<SweepByTokenResult> | undefined;
    const req = nodeRequest(
      canonical(tempDir),
      'setTimeout(() => process.stdout.write("RUNNING"), 100);setTimeout(() => {}, 4000);',
      {
        limits: { openFiles: 256 },
        onChunk: () => {
          if (swept !== undefined) return;
          const [entry] = [...pids.entries];
          if (entry === undefined) return;
          const [pgid, { startToken }] = entry;
          swept = sweepGroupByToken(pgid, startToken, { wait: (ms) => systemClock.sleep(ms), graceMs: 100 });
        },
      },
    );
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(await swept).toEqual({ verified: true, killed: true });
    expect(isProcessAlive(result.pgid)).toBe(false);
  }, 15_000);
});

describe('the descendant tracker backs off: a long run does not fork `ps` 25 times a second forever', () => {
  test('40 ms polls for the first second, then a growing period capped at maxMs', async () => {
    const requested: number[] = [];
    let release = (): void => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = async (ms: number): Promise<void> => {
      requested.push(ms);
      if (requested.length >= 30) release();
      await sleep(0);
    };

    await trackDescendants(process.pid, new Map<number, string>(), until, wait, {
      initialMs: 40,
      maxMs: 500,
      rampAfterMs: 1_000,
    });

    // The fast window is exactly the first second of polling: 1000 / 40 = 25 polls before the period starts growing.
    expect(requested.slice(0, 25)).toEqual(new Array(25).fill(40));
    expect(requested.slice(25, 29)).toEqual([80, 160, 320, 500]);
    expect(requested.at(-1)).toBe(500);
  }, 10_000);
});
