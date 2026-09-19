// `ExecResult.guarantees` equals `probeSandbox()` (DESIGN 2.6.6); `require: 'native'` with no usable backend is
// `sandbox-denied` (ADR-0003 §3: "native with no usable backend refuses to start").
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { systemClock } from '@cohorte/base';
import { fakeRedactor, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import { createExecutor, probeSandbox, sandboxUnavailable } from '../../src/exec/index.ts';
import { canonical, fakePidRegistry, l1Capabilities, markerBackend, nodeRequest } from './support.ts';

/** The test's own, independent answer to "is this an executable file?" / "is this name on PATH?". */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && isExecutable(join(dir, name)));
}

describe('ExecResult.guarantees equals probeSandbox()', () => {
  test('the same platform, the same (empty, until U4.07) backend list, the same report', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });
    const req = nodeRequest(canonical(tempDir), 'process.exit(0)');

    const result = await executor.run(req, new AbortController().signal);
    const probed = await probeSandbox();

    expect(result.guarantees).toEqual(probed);
    expect(probed.level).toBe('L0-process');
    expect(probed.backend).toBe('none');
  });

  test('probeSandbox() is exactly what SandboxCapabilities describes: additionalProperties: false shape', async () => {
    const probed = await probeSandbox();
    expect(Object.keys(probed).sort()).toEqual(
      [
        'level',
        'backend',
        'filesystem',
        'network',
        'processEscape',
        'envFiltering',
        'timeout',
        'outputCap',
        'cpuTime',
        'memory',
        'processes',
        'killTree',
        'missing',
        'notes',
      ].sort(),
    );
  });
});

// `Executor.capabilities()` is marked `[S]` in DESIGN 2.6.6: "exactly what `cohorte doctor --json` prints under
// sandbox". It describes the MACHINE. A refusal sentence about one `require: 'native'` call, or the advisory
// filesystem record of one request, belongs to that call's result and must never leak into it.
describe('capabilities() reports the machine, never the last request', () => {
  test('a denied run does not leave its refusal note behind in capabilities()', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const denied = await executor.run(
      nodeRequest(canonical(tempDir), 'process.exit(0)', { require: 'native' }),
      new AbortController().signal,
    );

    expect(denied.outcome).toBe('sandbox-denied');
    expect(denied.guarantees.notes.length).toBeGreaterThan(0);
    expect(executor.capabilities()).toEqual(await probeSandbox());
    expect(executor.capabilities().notes).toEqual([]);
  }, 10_000);

  // A COLD `capabilities()`: built, then read, with nothing awaited in between. It must not answer `missing: []`
  // and have `probeSandbox()` answer `['bwrap']` a tick later — `doctor` would then contradict itself depending on
  // when it was called. The expectation is computed here, from the machine, so the assertion is not vacuous on a
  // platform whose expected `missing` happens to be empty.
  test('capabilities() read in the same tick as construction already names the missing L1 binaries', async () => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });
    const cold = executor.capabilities();

    const expected: string[] = [];
    if (process.platform === 'darwin' && !isExecutable('/usr/bin/sandbox-exec')) expected.push('sandbox-exec');
    if (process.platform === 'linux' && !onPath('bwrap')) expected.push('bwrap');

    expect(cold.missing).toEqual(expected);
    expect(cold).toEqual(await probeSandbox());
  });

  // The PATH scan replaces a spawned `which`, which is not part of coreutils and is absent from many minimal Linux
  // images: there it fails, and `doctor` reports `bwrap` missing on a host that has it installed.
  test('detection finds a binary that is on PATH without depending on `which` being installed', () => {
    // `ps` is what this unit's own process table needs, so it is on PATH wherever these tests can run at all.
    expect(onPath('ps')).toBe(true);
    expect(onPath('a-binary-that-does-not-exist-anywhere')).toBe(false);
  });
});

// DESIGN 2.6.6 L0 row: "Filesystem and network isolation are advisory", and the plan requires the `fs.readOnly`
// roots of DESIGN 5.7 to be RECORDED as advisory here — that is the seam U4.07 flips to enforced.
describe('the roots L0 cannot enforce are recorded on the result', () => {
  test('a non-empty fs.readOnly / denyRead is named in the result notes, and the command still runs', async ({
    tempDir,
  }) => {
    const dependencies = canonical(join(tempDir, 'node_modules'));
    const secrets = canonical(join(tempDir, 'keys'));
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), 'process.stdout.write("RAN")', {
        fs: { readWrite: [canonical(tempDir)], readOnly: [dependencies], denyRead: [secrets] },
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.tail).toBe('RAN');
    const notes = result.guarantees.notes.join(' ');
    expect(notes).toContain('NOT enforced');
    expect(notes).toContain(dependencies);
    expect(notes).toContain(secrets);
    // Per-request, not per-machine: neither the doctor report nor the probe learns anything from one call.
    expect(executor.capabilities().notes).toEqual([]);
    expect((await probeSandbox()).notes).toEqual([]);
  }, 10_000);

  test('a request that asks for no such root adds no note: guarantees still equals probeSandbox()', async ({
    tempDir,
  }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), 'process.stdout.write("RAN")'),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.guarantees).toEqual(await probeSandbox());
  }, 10_000);
});

describe('require: "native" with no usable backend refuses to start (ADR-0003)', () => {
  test('outcome is sandbox-denied and nothing is spawned', async ({ tempDir }) => {
    const pids = fakePidRegistry();
    const executor = createExecutor({ redactor: fakeRedactor(), pids, clock: systemClock });
    const req = nodeRequest(canonical(tempDir), 'process.exit(1)', { require: 'native' });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('sandbox-denied');
    expect(result.exitCode).toBeNull();
    expect(pids.entries.size).toBe(0);
  });

  // DESIGN 2.6.6: the run refuses to start "(`security/sandbox-unavailable`, naming the failing self-test)". Both
  // halves are minted HERE, once: `guarantees.notes` names the axis that fell short, and `sandboxUnavailable()`
  // turns that report into the catalogued error with its `doctor` remediation, so no dependant reinvents either.
  test('the refused result names the failing axes in guarantees.notes', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), 'process.exit(1)', { require: 'native' }),
      new AbortController().signal,
    );

    expect(result.guarantees.notes.length).toBeGreaterThan(0);
    expect(result.guarantees.notes.join(' ')).toContain('no OS sandbox backend is active');
  });

  test('a partial L1 backend names the axis AND the escape self-test that has not passed', async ({ tempDir }) => {
    const executor = createExecutor({
      redactor: fakeRedactor(),
      pids: fakePidRegistry(),
      clock: systemClock,
      backend: markerBackend(l1Capabilities({ filesystem: 'partial' })),
    });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), 'process.exit(1)', { require: 'native' }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('sandbox-denied');
    const notes = result.guarantees.notes.join(' ');
    expect(notes).toContain("filesystem is 'partial'");
    expect(notes).toMatch(/S-2[89]/);
  });

  test('sandboxUnavailable() mints the catalogued code, its remediation and the notes as the message', async () => {
    const guarantees = await probeSandbox();

    const info = sandboxUnavailable(guarantees);

    expect(info.code).toBe('security/sandbox-unavailable');
    expect(info.class).toBe('security');
    expect(info.retryable).toBe(false);
    expect(info.remediation).toContain('cohorte doctor');
    expect(info.message).toContain('no OS sandbox backend is active');
  });
});
