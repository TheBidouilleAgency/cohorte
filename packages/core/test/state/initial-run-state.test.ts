// DESIGN 2.5.1 / 4.3 #1 — `initialRunState`: the `RunState` a fresh run starts from, BEFORE `pipeline.started`
// (T04's guards) has run. The six host-computed keys (marked `(*)` on `RunRecord`) are therefore absent.
import type { IsoInstant, RunId, Sha256, SpecId } from '@cohorte/base';
import { describe, expect, it } from 'vitest';
import { initialRunState } from '../../src/state/initial-run-state.ts';

const INPUT = {
  runId: 'run_00000000000000000000000002' as RunId,
  profile: 'feature',
  tableVersion: 1,
  specId: 'spc_00000000000000000000000002' as SpecId,
  specSha256: 'd'.repeat(64) as Sha256,
  title: 'a fresh run',
  pinnedInstallDir: '/tmp/u0.09-initial-run-state',
  baseBranch: 'main',
  cohorteVersion: '3.0.0-test',
  schemaVersion: 1,
  startedAt: '2026-01-01T00:00:00.000Z' as IsoInstant,
};

describe('initialRunState', () => {
  it('starts at IDLE, sequence 0, version 0', () => {
    const state = initialRunState(INPUT);
    expect(state.run.state).toBe('IDLE');
    expect(state.run.lastSequence).toBe(0);
    expect(state.run.version).toBe(0);
  });

  it('every aggregate collection is empty', () => {
    const state = initialRunState(INPUT);
    expect(state.phases).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.incarnations).toEqual([]);
    expect(state.worktrees).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.budgets).toEqual([]);
    expect(state.locks).toEqual([]);
  });

  it('the six host-computed (*) keys are absent while IDLE, not merely undefined', () => {
    const state = initialRunState(INPUT);
    for (const key of ['snapshotDigest', 'runtimePin', 'plan', 'baseSha', 'integrationBranch', 'zones']) {
      expect(key in state.run, `RunRecord.${key} should be absent for a fresh IDLE run`).toBe(false);
    }
  });

  it('cancelRequested / pauseRequested start false; purgeable starts false', () => {
    const state = initialRunState(INPUT);
    expect(state.run.cancelRequested).toBe(false);
    expect(state.run.pauseRequested).toBe(false);
    expect(state.run.purgeable).toBe(false);
  });

  it('echoes every caller-supplied field verbatim', () => {
    const state = initialRunState(INPUT);
    expect(state.run.runId).toBe(INPUT.runId);
    expect(state.run.profile).toBe(INPUT.profile);
    expect(state.run.tableVersion).toBe(INPUT.tableVersion);
    expect(state.run.specId).toBe(INPUT.specId);
    expect(state.run.specSha256).toBe(INPUT.specSha256);
    expect(state.run.title).toBe(INPUT.title);
    expect(state.run.pinnedInstallDir).toBe(INPUT.pinnedInstallDir);
    expect(state.run.baseBranch).toBe(INPUT.baseBranch);
    expect(state.run.cohorteVersion).toBe(INPUT.cohorteVersion);
    expect(state.run.schemaVersion).toBe(INPUT.schemaVersion);
    expect(state.run.startedAt).toBe(INPUT.startedAt);
    expect(state.run.updatedAt).toBe(INPUT.startedAt);
  });
});
