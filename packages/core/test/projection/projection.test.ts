import type { EventId, IsoInstant, RunId } from '@cohorte/base';
import { expect, test } from 'vitest';
import type { RunState } from '../../src/contract/types.ts';
import { createProjection } from '../../src/projection/index.ts';
import { initialRunState } from '../../src/state/initial-run-state.ts';

const state = (): RunState =>
  initialRunState({
    runId: 'run_01J0000000000000000000000A' as RunId,
    profile: 'feature',
    tableVersion: 1,
    specId: 'spc_01J0000000000000000000000A' as never,
    specSha256: 'a'.repeat(64) as never,
    title: 'projection',
    pinnedInstallDir: '/tmp/install',
    baseBranch: 'main',
    cohorteVersion: '3.0.0',
    schemaVersion: 1,
    startedAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
  });

test('projection folds durable host events without mutating the input', () => {
  const before = state();
  const event = {
    protocolVersion: '1.0',
    eventId: 'evt_01J0000000000000000000000A' as EventId,
    sequence: 1,
    sub: 0,
    durability: 'durable',
    timestamp: '2026-01-01T00:00:01.000Z' as IsoInstant,
    runId: before.run.runId,
    type: 'run.host.attached',
    source: 'cohorte',
    summary: 'host attached',
    severity: 'info',
    payload: { hostId: 'host-1', pid: 42, cohorteVersion: '3.0.0', fencingToken: 1, takeover: false },
    redactions: [],
  } as never;

  const after = createProjection({}).evolve(before, event);
  expect(after.run.hostId).toBe('host-1');
  expect(after.run.hostPid).toBe(42);
  expect(before.run.hostId).toBeUndefined();
});
