// DESIGN 4.2 E3-E5 — the PURE kernel: `nextStep` narrows the table to every row reachable from the current state and
// hands back the union of their guard ids (nothing persisted); `resolveTransition` picks the one row that actually
// fires and checks its preconditions. These are the direct unit tests of the two functions themselves, underneath
// the table-level totality properties of `tables.totality.test.ts`.
import type { GuardOutcome } from '@cohorte/protocol';
import { ACTIVE_PIPELINE_STATES, SUSPENDED_STATES } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import { nextStep } from '../../src/pipeline/next-step.ts';
import { resolveTransition } from '../../src/pipeline/resolve-transition.ts';
import { FEATURE_V1, REVIEW_V1 } from '../../src/pipeline/tables/index.ts';
import { resolveAllPass, stateAt } from './fixtures.ts';

describe('nextStep', () => {
  it('narrows to every row whose `from` matches the current state, in table order', () => {
    const step = nextStep(stateAt('TEST'), FEATURE_V1);
    expect(step.from).toBe('TEST');
    const ids = step.candidates.map((row) => row.id);
    // T08 (tests-pass), T09 (tests-fail), T16 (stop-rule) all read `from: 'TEST'`; T24/T25/T25-stop/T26/T27/T33-TEST
    // read from `*active`/`*any-non-terminal`, which also matches TEST.
    expect(ids).toContain('T08');
    expect(ids).toContain('T09');
    expect(ids).toContain('T16');
    expect(ids).toContain('T33-TEST');
  });

  it('the guard union is deduplicated even though several candidates share a guard id', () => {
    const step = nextStep(stateAt('TEST'), FEATURE_V1);
    expect(new Set(step.guards).size).toBe(step.guards.length);
    expect(step.guards).toContain('checks.all-passed');
    expect(step.guards).toContain('checks.errored-environmental');
  });

  it('a terminal state still returns a step (never throws), with whatever wildcard rows still apply', () => {
    expect(() => nextStep(stateAt('COMPLETED'), FEATURE_V1)).not.toThrow();
    const step = nextStep(stateAt('COMPLETED'), FEATURE_V1);
    // COMPLETED is terminal: *any-non-terminal (T27) and *active/*suspended do not match it.
    expect(step.candidates).toEqual([]);
  });
});

describe('resolveTransition', () => {
  it('no-matching-row: an unreachable (from, reason) pair', () => {
    const result = resolveTransition(FEATURE_V1, 'IDLE', 'shipped', []);
    expect(result).toEqual({ ok: false, reason: 'no-matching-row' });
  });

  it('guard-failed: reports the FIRST failing precondition, in row order, with its detail', () => {
    const result = resolveTransition(FEATURE_V1, 'BUILD', 'built', [
      { id: 'agents.all-completed', ok: false, detail: 'agent agt_x is still running' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'guard-failed') {
      expect(result.def.id).toBe('T07');
      expect(result.failedGuard).toBe('agents.all-completed');
      expect(result.detail).toBe('agent agt_x is still running');
    } else {
      expect.unreachable('expected a guard-failed result');
    }
  });

  it('guard-failed: an outcome absent from guardOutcomes counts as a failure, with no detail', () => {
    const result = resolveTransition(FEATURE_V1, 'BUILD', 'built', []);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'guard-failed') {
      expect(result.failedGuard).toBe('agents.all-completed');
      expect('detail' in result).toBe(false);
    } else {
      expect.unreachable('expected a guard-failed result');
    }
  });

  it('several rows sharing (from, reason) (T06 / T06-surfaces): the first one whose guards ALL hold wins', () => {
    const onlySurfaces: readonly GuardOutcome[] = [{ id: 'surfaces.unowned', ok: true }];
    const result = resolveTransition(FEATURE_V1, 'PREFLIGHT', 'needs-human', onlySurfaces);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.def.id).toBe('T06-surfaces');
  });

  it("the {stop} branch resolves through STOP_ROW_MAPS and still checks the row's own preconditions", () => {
    const passing = resolveTransition(FEATURE_V1, 'TEST', { stop: 'check-environment' }, [
      { id: 'checks.errored-environmental', ok: true },
    ]);
    expect(passing.ok && passing.def.id).toBe('T16');

    const failing = resolveTransition(FEATURE_V1, 'TEST', { stop: 'check-environment' }, []);
    expect(failing).toEqual({
      ok: false,
      reason: 'guard-failed',
      def: FEATURE_V1.rows.find((row) => row.id === 'T16'),
      failedGuard: 'checks.errored-environmental',
    });
  });

  it('the {stop} branch is no-matching-row when the mapped row does not apply from this state', () => {
    // T16 (check-environment) is `from: 'TEST'`: asking for it from BUILD can never match.
    const result = resolveTransition(FEATURE_V1, 'BUILD', { stop: 'check-environment' }, []);
    expect(result).toEqual({ ok: false, reason: 'no-matching-row' });
  });
});

/** T24 (`*active -> WAITING_APPROVAL`) and T25-stop (`*active -> BLOCKED`) share `reason: 'stop-rule'`, a WILDCARD
 * `from` and an empty precondition list: DESIGN 2.5.1 separates them by the STOP REASON SET alone. First-match-wins
 * over them would make T24 answer every wildcard stop and leave the security row T25-stop unreachable, so the bare
 * reason is REFUSED whenever only wildcard rows match — the caller must pass `{ stop }`. */
describe('resolveTransition — a wildcard stop row is reachable only through {stop}', () => {
  const ALL_PASS: readonly GuardOutcome[] = [];

  it('the bare reason `stop-rule` from an active state with no concrete row is `stop-reason-required`, never T24', () => {
    for (const from of ['PREFLIGHT', 'BUILD', 'REVIEW', 'FIX'] as const) {
      const result = resolveAllPass(FEATURE_V1, from, 'stop-rule');
      expect(result, `bare stop-rule from ${from}`).toEqual({ ok: false, reason: 'stop-reason-required' });
    }
  });

  it('a CONCRETE stop row still answers the bare reason: TEST -> T16, SHIP -> T15', () => {
    const fromTest = resolveAllPass(FEATURE_V1, 'TEST', 'stop-rule');
    expect(fromTest.ok && fromTest.def.id).toBe('T16');
    const fromShip = resolveAllPass(FEATURE_V1, 'SHIP', 'stop-rule');
    expect(fromShip.ok && fromShip.def.id).toBe('T15');
  });

  it('{stop: policy-violation | unexpected-repo-change | runtime-incompatible} reaches T25-stop from EVERY active state', () => {
    for (const stop of ['policy-violation', 'unexpected-repo-change', 'runtime-incompatible'] as const) {
      for (const from of ACTIVE_PIPELINE_STATES) {
        const result = resolveTransition(FEATURE_V1, from, { stop }, ALL_PASS);
        expect(result.ok, `${stop} from ${from}`).toBe(true);
        if (result.ok) {
          expect(result.def.id).toBe('T25-stop');
          expect(result.to).toBe('BLOCKED');
        }
      }
    }
  });

  it('{stop: iteration-limit | budget-exhausted | timeout | identical-failure | no-progress} still reaches T24', () => {
    for (const stop of [
      'iteration-limit',
      'budget-exhausted',
      'timeout',
      'identical-failure',
      'no-progress',
    ] as const) {
      const result = resolveTransition(FEATURE_V1, 'BUILD', { stop }, ALL_PASS);
      expect(result.ok, `${stop} from BUILD`).toBe(true);
      if (result.ok) {
        expect(result.def.id).toBe('T24');
        expect(result.to).toBe('WAITING_APPROVAL');
      }
    }
  });
});

/** DESIGN 2.5.1 conditions T30's EXTRA guard on the suspension CAUSE ("plus `approval.none-pending-blocking` /
 * `auth.plan-satisfied`"), while the command matrix maps the WHOLE `*suspended` column of `resume` to the one row
 * T30 (`command-matrix.ts`). A wildcard row must therefore be at least as strict as every cause it covers: without
 * `auth.plan-satisfied` a human `resume` on an AUTH_REQUIRED run left AUTH_REQUIRED with auth still broken, because
 * the cause-keyed sibling T30-auth answers only the reason `auth-restored`, which no `resume` command carries. */
describe('resolveTransition — T30 carries the guards of EVERY suspension cause it covers', () => {
  const ALL_BUT_AUTH: readonly GuardOutcome[] = [
    { id: 'resume.locks-rebuilt', ok: true },
    { id: 'resume.git-verified', ok: true },
    { id: 'runtime.pin-valid', ok: true },
    { id: 'approval.none-pending-blocking', ok: true },
    { id: 'auth.plan-satisfied', ok: false, detail: 'subscription token expired' },
  ];

  it('a `resume-command` from AUTH_REQUIRED fails on auth.plan-satisfied instead of resuming', () => {
    const result = resolveTransition(FEATURE_V1, 'AUTH_REQUIRED', 'resume-command', ALL_BUT_AUTH);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'guard-failed') {
      expect(result.def.id).toBe('T30');
      expect(result.failedGuard).toBe('auth.plan-satisfied');
      expect(result.detail).toBe('subscription token expired');
    } else {
      expect.unreachable('expected a guard-failed result on auth.plan-satisfied');
    }
  });

  it('the same holds from EVERY suspended state: the matrix maps the whole column to T30', () => {
    for (const from of SUSPENDED_STATES) {
      const result = resolveTransition(FEATURE_V1, from, 'resume-command', ALL_BUT_AUTH);
      expect(result.ok, `resume-command from ${from}`).toBe(false);
      if (!result.ok && result.reason === 'guard-failed') {
        expect(result.failedGuard, `resume-command from ${from}`).toBe('auth.plan-satisfied');
      } else {
        expect.unreachable(`expected a guard-failed result from ${from}`);
      }
    }
  });

  it('with every guard satisfied, T30 still resumes into *resumeTo', () => {
    for (const from of SUSPENDED_STATES) {
      const result = resolveAllPass(FEATURE_V1, from, 'resume-command');
      expect(result.ok, `resume-command from ${from}`).toBe(true);
      if (result.ok) {
        expect(result.def.id).toBe('T30');
        expect(result.to).toBe('*resumeTo');
      }
    }
  });

  it('T31 (retry from FAILED) and T32 (resume --ack from BLOCKED) are supersets of T30, per DESIGN 2.5.1', () => {
    const t30 = FEATURE_V1.rows.find((row) => row.id === 'T30')?.preconditions ?? [];
    expect(t30.length).toBeGreaterThan(0);
    for (const id of ['T31', 'T32'] as const) {
      const row = FEATURE_V1.rows.find((candidate) => candidate.id === id);
      for (const guard of t30) expect(row?.preconditions, `${id} carries T30's ${guard}`).toContain(guard);
    }
  });
});

/** DESIGN 2.5.1's matrix makes `skip` a REQUIRED cell of the `*suspended` and FAILED columns, "on `resumeTo`": the
 * run is parked while the row is sourced from the phase it would re-enter. `resolveTransition` matches rows by
 * `from`, so only the `{ skip }` form can reach that row — otherwise every consumer would look the row up itself and
 * evaluate `policy.skip-allows` / `skip.justified` outside the kernel, which is the guard bypass I10 forbids. */
describe('resolveTransition — {skip} resolves the per-phase T33 row wherever the run is parked', () => {
  const SKIP_OK: readonly GuardOutcome[] = [
    { id: 'policy.skip-allows', ok: true },
    { id: 'skip.justified', ok: true },
  ];

  it('skip from FAILED resolves the row of the run `resumeTo` phase (T33-BUILD -> TEST)', () => {
    const result = resolveTransition(FEATURE_V1, 'FAILED', { skip: 'BUILD' }, SKIP_OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.def.id).toBe('T33-BUILD');
      expect(result.to).toBe('TEST');
    }
  });

  it('skip from every suspended state resolves the same row', () => {
    for (const from of SUSPENDED_STATES) {
      const result = resolveTransition(FEATURE_V1, from, { skip: 'REVIEW' }, SKIP_OK);
      expect(result.ok, `skip REVIEW from ${from}`).toBe(true);
      if (result.ok) {
        expect(result.def.id).toBe('T33-REVIEW');
        expect(result.to).toBe('SHIP');
      }
    }
  });

  it('skip from the active phase itself resolves the same row (the matrix `*active` cell)', () => {
    const result = resolveTransition(FEATURE_V1, 'TEST', { skip: 'TEST' }, SKIP_OK);
    expect(result.ok && result.def.id).toBe('T33-TEST');
  });

  it('a missing `policy.skip-allows` is guard-failed, never a bypass', () => {
    const result = resolveTransition(FEATURE_V1, 'PAUSED', { skip: 'BUILD' }, [{ id: 'skip.justified', ok: true }]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'guard-failed') {
      expect(result.def.id).toBe('T33-BUILD');
      expect(result.failedGuard).toBe('policy.skip-allows');
    } else {
      expect.unreachable('expected a guard-failed result on policy.skip-allows');
    }
  });

  it('a phase this profile does not let `skip` fire from is `no-matching-row` (review@1 REVIEW)', () => {
    const result = resolveTransition(REVIEW_V1, 'FAILED', { skip: 'REVIEW' }, SKIP_OK);
    expect(result).toEqual({ ok: false, reason: 'no-matching-row' });
  });
});
