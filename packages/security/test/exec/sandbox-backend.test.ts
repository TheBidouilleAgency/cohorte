// The `SandboxBackend` seam (DESIGN 2.6.6, ADR-0003 §2b). Two properties this unit must hold BEFORE U4.07 injects
// a real Seatbelt/bubblewrap backend:
//   1. what `ExecResult.guarantees` claims and what was actually spawned are the same thing — a backend that
//      produced the report also wrapped the argv (the alternative is the worst failure mode there is: a run that
//      reports `level: 'L1-os'` while the command runs completely unwrapped);
//   2. `require: 'native'` is earned by `enforced`, never by `partial` (DESIGN 2.6.6: "sandbox.require: native is
//      satisfied only by enforced: with a partial backend the run refuses to start").
import { systemClock } from '@cohorte/base';
import { fakeRedactor, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { SandboxCapabilities } from '../../src/contract/index.ts';
import { createExecutor } from '../../src/exec/index.ts';
import { canonical, fakePidRegistry, l1Capabilities, markerBackend, nodeRequest, SANDBOX_MARKER } from './support.ts';

const reportMarker = `process.stdout.write(process.env.${SANDBOX_MARKER} ?? "UNWRAPPED")`;

describe('the backend actually wraps the spawned command', () => {
  test('a backend whose wrap() prepends a program: that program is what reached the argv', async ({ tempDir }) => {
    const executor = createExecutor({
      redactor: fakeRedactor(),
      pids: fakePidRegistry(),
      clock: systemClock,
      backend: markerBackend(l1Capabilities()),
    });

    const result = await executor.run(nodeRequest(canonical(tempDir), reportMarker), new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(result.exitCode).toBe(0);
    // The wrapper ran AND handed control to the real program with its argv intact.
    expect(result.tail).toBe('wrapped');
    expect(result.guarantees.level).toBe('L1-os');
  }, 10_000);

  test('the default (none) backend wraps nothing: the program still sees no marker', async ({ tempDir }) => {
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(nodeRequest(canonical(tempDir), reportMarker), new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(result.tail).toBe('UNWRAPPED');
    expect(result.guarantees.level).toBe('L0-process');
  }, 10_000);

  test('a backend that cannot probe is used for NEITHER the report nor the argv', async ({ tempDir }) => {
    const broken = markerBackend(l1Capabilities());
    const executor = createExecutor({
      redactor: fakeRedactor(),
      pids: fakePidRegistry(),
      clock: systemClock,
      backend: { ...broken, probe: () => Promise.reject(new Error('no sandbox-exec here')) },
    });

    const result = await executor.run(nodeRequest(canonical(tempDir), reportMarker), new AbortController().signal);

    expect(result.guarantees.level).toBe('L0-process');
    expect(result.tail).toBe('UNWRAPPED');
  }, 10_000);
});

const degradations: ReadonlyArray<{ label: string; overrides: Partial<SandboxCapabilities> }> = [
  { label: 'filesystem: partial', overrides: { filesystem: 'partial' } },
  { label: 'network: partial', overrides: { network: 'partial' } },
  { label: 'processEscape: partial', overrides: { processEscape: 'partial' } },
];

describe('require: "native" is satisfied only by an ENFORCED backend (DESIGN 2.6.6, ADR-0003 §2b)', () => {
  test.for(degradations)(
    'an L1-os backend reporting $label refuses to start',
    { timeout: 10_000 },
    async ({ overrides }, { tempDir }) => {
      const pids = fakePidRegistry();
      const executor = createExecutor({
        redactor: fakeRedactor(),
        pids,
        clock: systemClock,
        backend: markerBackend(l1Capabilities(overrides)),
      });

      const result = await executor.run(
        nodeRequest(canonical(tempDir), reportMarker, { require: 'native' }),
        new AbortController().signal,
      );

      expect(result.outcome).toBe('sandbox-denied');
      expect(result.exitCode).toBeNull();
      expect(pids.entries.size).toBe(0);
    },
  );

  test('a fully enforced L1-os backend does satisfy it, and the command is wrapped', async ({ tempDir }) => {
    const executor = createExecutor({
      redactor: fakeRedactor(),
      pids: fakePidRegistry(),
      clock: systemClock,
      backend: markerBackend(l1Capabilities()),
    });

    const result = await executor.run(
      nodeRequest(canonical(tempDir), reportMarker, { require: 'native' }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe('ok');
    expect(result.tail).toBe('wrapped');
  }, 10_000);
});
