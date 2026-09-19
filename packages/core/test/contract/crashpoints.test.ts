import { beforeEach, describe, expect, it } from 'vitest';
import {
  CRASHPOINTS,
  crashpoint,
  isCrashpoint,
  resetCrashpointOccurrences,
  SimulatedCrash,
  setFaultInjector,
} from '../../src/durability/crashpoints.ts';

// DESIGN 4.3, transcribed independently from the table (rows 1-21; row 22 is SQLite's own WAL durability, not a
// `crashpoint()` call site) so a typo or an accidental duplicate in the registry itself is still caught.
const DESIGN_4_3_NAMES = [
  'start.after-run-row',
  'host.after-lease',
  'snapshot.mid-materialize',
  'transition.before-commit',
  'transition.after-commit',
  'transition-effect.after-intent',
  'transition-effect.after-external',
  'plan.after-commit',
  'provision.after-worktree-add',
  'provision.after-install',
  'spawn.after-intent',
  'spawn.after-ready',
  'tool.after-requested',
  'approval.after-requested',
  'tool.after-intent',
  'tool.after-effect',
  'tool.after-done',
  'agent.after-exit-before-collect',
  'commit.after-git-commit',
  'merge.after-update-ref',
  'phase.before-completed-commit',
  'checkpoint.after-events-before-snapshot',
  'command.external.after-accepted',
  'ship.after-approval',
  'locks.after-release',
  'reset.after-git-reset',
];

describe('CRASHPOINTS', () => {
  it('is unique', () => {
    expect(new Set(CRASHPOINTS).size).toBe(CRASHPOINTS.length);
  });

  it('equals the DESIGN 4.3 list', () => {
    expect([...CRASHPOINTS].sort()).toEqual([...DESIGN_4_3_NAMES].sort());
  });

  it('isCrashpoint recognises every registered name and nothing else', () => {
    for (const name of CRASHPOINTS) expect(isCrashpoint(name)).toBe(true);
    expect(isCrashpoint('not-a-crashpoint')).toBe(false);
  });
});

describe('crashpoint()', () => {
  beforeEach(() => {
    resetCrashpointOccurrences();
    setFaultInjector(null);
    delete process.env.COHORTE_CRASH_AT;
  });

  it('is a no-op without the env var and without an armed injector', () => {
    expect(() => crashpoint('start.after-run-row')).not.toThrow();
  });

  it('throws on an unregistered name', () => {
    // @ts-expect-error deliberately not a Crashpoint
    expect(() => crashpoint('nope')).toThrow(TypeError);
  });

  it('throws SimulatedCrash when an armed FaultInjector says so, on the right occurrence', () => {
    setFaultInjector({ shouldFail: (point, occurrence) => point === 'tool.after-intent' && occurrence === 2 });
    expect(() => crashpoint('tool.after-intent')).not.toThrow();
    let caught: unknown;
    try {
      crashpoint('tool.after-intent');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SimulatedCrash);
    expect((caught as SimulatedCrash).point).toBe('tool.after-intent');
    expect((caught as SimulatedCrash).occurrence).toBe(2);
  });

  it('never crashes a point the injector was not armed for', () => {
    setFaultInjector({ shouldFail: (point) => point === 'reset.after-git-reset' });
    expect(() => crashpoint('start.after-run-row')).not.toThrow();
  });
});
