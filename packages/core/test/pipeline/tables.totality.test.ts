// DESIGN 2.5.1 "Totality tests" — run once per table (`feature@1`, `bugfix@1`, `review@1`):
//   * reachability: every phase of `table.phases` is reachable from IDLE;
//   * every active state has an exit for every `PhaseOutcome` kind (TEST: three, keyed by the worst check status);
//   * every `StopReason` resolves to exactly one row;
//   * no row targets an active state outside the profile's own `phases`, and — the mirror of it — no row is SOURCED
//     from one either (a `*active` wildcard is resolved against `table.phases`, never the global active set).
import type { ActivePipelineState, PipelineState } from '@cohorte/protocol';
import {
  ACTIVE_PIPELINE_STATES,
  HALTED_STATES,
  PIPELINE_STATES,
  STOP_REASONS,
  SUSPENDED_STATES,
} from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import type { PhaseOutcome, TransitionTable } from '../../src/contract/types.ts';
import type { ReasonOrOutcome } from '../../src/pipeline/resolve-transition.ts';
import { BUGFIX_V1, FEATURE_V1, REVIEW_V1, STOP_ROW_MAPS } from '../../src/pipeline/tables/index.ts';
import { matchesFrom } from '../../src/pipeline/tables/shared.ts';
import { resolveAllPass } from './fixtures.ts';

const TABLES: readonly TransitionTable[] = [FEATURE_V1, BUGFIX_V1, REVIEW_V1];
const ACTIVE_SET = new Set<string>(ACTIVE_PIPELINE_STATES);

interface Exit {
  readonly reasonOrOutcome: ReasonOrOutcome;
  readonly to: PipelineState;
}

/** One canonical exit per (profile, active phase) DESIGN 2.5.1 / ADR-0018 name — the "happy path" reasons, plus
 * every stop/needs-human branch the table's own prose calls out. Deliberately independent of `command-matrix.ts` /
 * `tables/shared.ts`'s own constants: this file re-derives the expectation from DESIGN's table text so a
 * copy/paste drift in the production data is caught, not echoed. */
const EXIT_EXPECTATIONS: Readonly<Record<string, Readonly<Partial<Record<ActivePipelineState, readonly Exit[]>>>>> = {
  feature: {
    BRAINSTORM: [{ reasonOrOutcome: 'ready', to: 'SPEC' }],
    SPEC: [{ reasonOrOutcome: 'ready', to: 'PREFLIGHT' }],
    PREFLIGHT: [
      { reasonOrOutcome: 'ready', to: 'BUILD' },
      { reasonOrOutcome: 'needs-human', to: 'WAITING_APPROVAL' },
    ],
    BUILD: [{ reasonOrOutcome: 'built', to: 'TEST' }],
    TEST: [
      { reasonOrOutcome: 'tests-pass', to: 'REVIEW' },
      { reasonOrOutcome: 'tests-fail', to: 'FIX' },
      { reasonOrOutcome: { stop: 'check-environment' }, to: 'FAILED' },
    ],
    REVIEW: [
      { reasonOrOutcome: 'review-approved', to: 'SHIP' },
      { reasonOrOutcome: 'review-findings', to: 'FIX' },
      { reasonOrOutcome: 'needs-human', to: 'WAITING_APPROVAL' },
    ],
    FIX: [{ reasonOrOutcome: 'fixed', to: 'TEST' }],
    SHIP: [
      { reasonOrOutcome: 'shipped', to: 'COMPLETED' },
      { reasonOrOutcome: 'stop-rule', to: 'TEST' },
    ],
  },
  bugfix: {
    PREFLIGHT: [
      { reasonOrOutcome: 'ready', to: 'BUILD' },
      { reasonOrOutcome: 'needs-human', to: 'WAITING_APPROVAL' },
    ],
    BUILD: [{ reasonOrOutcome: 'built', to: 'TEST' }],
    TEST: [
      { reasonOrOutcome: 'tests-pass', to: 'REVIEW' },
      { reasonOrOutcome: 'tests-fail', to: 'FIX' },
      { reasonOrOutcome: { stop: 'check-environment' }, to: 'FAILED' },
    ],
    REVIEW: [
      { reasonOrOutcome: 'review-approved', to: 'SHIP' },
      { reasonOrOutcome: 'review-findings', to: 'FIX' },
      { reasonOrOutcome: 'needs-human', to: 'WAITING_APPROVAL' },
    ],
    FIX: [{ reasonOrOutcome: 'fixed', to: 'TEST' }],
    SHIP: [
      { reasonOrOutcome: 'shipped', to: 'COMPLETED' },
      { reasonOrOutcome: 'stop-rule', to: 'TEST' },
    ],
  },
  review: {
    TEST: [
      { reasonOrOutcome: 'tests-pass', to: 'REVIEW' },
      { reasonOrOutcome: 'tests-fail', to: 'FIX' },
      { reasonOrOutcome: { stop: 'check-environment' }, to: 'FAILED' },
    ],
    REVIEW: [
      { reasonOrOutcome: 'review-delivered', to: 'COMPLETED' },
      { reasonOrOutcome: 'review-findings', to: 'FIX' },
    ],
    FIX: [{ reasonOrOutcome: 'fixed', to: 'TEST' }],
  },
};

function reachablePhases(table: TransitionTable): ReadonlySet<PipelineState> {
  const reached = new Set<PipelineState>(['IDLE']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table.rows) {
      if (row.from.startsWith('*')) continue; // a wildcard source never DISCOVERS a new active phase (see header)
      if (!reached.has(row.from as PipelineState)) continue;
      if (row.to.startsWith('*')) continue; // '*resumeTo': resolved dynamically, not a fixed target
      if (!reached.has(row.to as PipelineState)) {
        reached.add(row.to as PipelineState);
        grew = true;
      }
    }
  }
  return reached;
}

describe.each(TABLES)('$profile@$version', (table) => {
  it('reachability: every phase of table.phases is reachable from IDLE', () => {
    const reached = reachablePhases(table);
    for (const phase of table.phases) expect(reached, `phase ${phase} of ${table.profile}`).toContain(phase);
  });

  it('no row targets an active state outside table.phases', () => {
    for (const row of table.rows) {
      if ((ACTIVE_SET as ReadonlySet<string>).has(row.to)) {
        expect(table.phases, `row ${row.id} targets ${row.to}`).toContain(row.to);
      }
    }
  });

  it('every phase of table.phases has at least one exit, and every declared exit resolves', () => {
    const exits = EXIT_EXPECTATIONS[table.profile];
    expect(exits).toBeDefined();
    for (const phase of table.phases) {
      const declared = exits?.[phase];
      expect(declared?.length ?? 0, `${table.profile}: ${phase} has a declared exit`).toBeGreaterThan(0);
      for (const exit of declared ?? []) {
        const result = resolveAllPass(table, phase, exit.reasonOrOutcome);
        expect(
          result.ok,
          `${table.profile}: ${phase} + ${JSON.stringify(exit.reasonOrOutcome)} -> ${JSON.stringify(result)}`,
        ).toBe(true);
        if (result.ok) expect(result.to).toBe(exit.to);
      }
    }
  });

  it('every phase of table.phases has an exit for every PhaseOutcome kind', () => {
    // The property the plan words as "every active state has an exit for every `PhaseOutcome` kind" — asserted over
    // the four KINDS themselves (contract/types.ts), not only over the hand-declared exits above. It holds today
    // through the wildcard tail rows (T21/T24/T25-stop/T26 and the per-phase T33), which is exactly why a future
    // narrowing of a wildcard's `from` would otherwise break it silently.
    const exits = EXIT_EXPECTATIONS[table.profile];
    for (const phase of table.phases) {
      const success = exits?.[phase]?.[0]?.reasonOrOutcome;
      expect(success, `${table.profile}: ${phase} has a declared success exit`).toBeDefined();
      const hasConcreteFailure = table.rows.some((row) => row.from === phase && row.reason === 'tests-fail');
      const byKind: Readonly<Record<PhaseOutcome['kind'], ReasonOrOutcome>> = {
        passed: success as ReasonOrOutcome,
        // a phase with no concrete `tests-fail` row exits a failed outcome through the T26 stop (`internal-error`)
        failed: hasConcreteFailure ? 'tests-fail' : { stop: 'internal-error' },
        'needs-human': 'needs-human',
        suspended: { stop: 'paused' },
      };
      for (const [kind, reasonOrOutcome] of Object.entries(byKind)) {
        const result = resolveAllPass(table, phase, reasonOrOutcome);
        expect(
          result.ok,
          `${table.profile}: ${phase} + PhaseOutcome ${kind} (${JSON.stringify(reasonOrOutcome)}) -> ${JSON.stringify(result)}`,
        ).toBe(true);
      }
    }
  });

  it('no row is SOURCED from an active state outside table.phases', () => {
    // The mirror of the assertion above: a `*active` wildcard resolved against the GLOBAL active set would fire a row
    // from a phase the profile deliberately removed (bugfix@1 has no BRAINSTORM, review@1 no SHIP/PREFLIGHT/BUILD).
    const legal = new Set<string>([...table.phases, 'IDLE', ...SUSPENDED_STATES, ...HALTED_STATES]);
    for (const row of table.rows) {
      if (row.from === '*any-non-terminal') continue; // T27: `cancel` is legal from every non-terminal state by design
      for (const state of PIPELINE_STATES) {
        if (!matchesFrom(row.from, state, table.phases)) continue;
        expect(legal, `row ${row.id} (from ${row.from}) is sourced from ${state}`).toContain(state);
      }
    }
  });

  it('TEST has exactly the three exits keyed by the worst CheckResult.status (passed/failed/errored)', () => {
    if (!table.phases.includes('TEST')) return;
    const passed = resolveAllPass(table, 'TEST', 'tests-pass');
    const failed = resolveAllPass(table, 'TEST', 'tests-fail');
    const errored = resolveAllPass(table, 'TEST', { stop: 'check-environment' });
    expect(passed.ok && passed.to).toBe('REVIEW');
    expect(failed.ok && failed.to).toBe('FIX');
    expect(errored.ok && errored.to).toBe('FAILED');
    // mutually exclusive by construction (DESIGN 2.5.1 T16): three DIFFERENT rows fire, never the same one twice
    expect(passed.ok && errored.ok && (passed as { def: { id: string } }).def.id).not.toBe(
      (errored as { def: { id: string } }).def.id,
    );
  });

  it('every StopReason resolves to exactly one row in this table', () => {
    const map = STOP_ROW_MAPS[table.profile];
    for (const reason of STOP_REASONS) {
      const rowId = map[reason];
      expect(rowId, `${table.profile}: StopReason ${reason}`).toBeTruthy();
      const matches = table.rows.filter((row) => row.id === rowId);
      expect(matches, `${table.profile}: StopReason ${reason} -> row ${rowId}`).toHaveLength(1);
    }
  });
});
