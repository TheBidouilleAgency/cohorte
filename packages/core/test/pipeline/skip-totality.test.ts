// DESIGN 2.5.1 T33 / ADR-0018 §5 — "a skip is a waiver bound to a digest, not a hole in the guards": for every
// skippable phase, `skip` then the normal rows reach COMPLETED (skip REVIEW -> SHIP -> T14 holds through the
// recorded waiver; it never bounces SHIP -> TEST); a tree change after the skip invalidates the waiver (T15).
import type { PipelineState } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import type { TransitionTable } from '../../src/contract/types.ts';
import type { ReasonOrOutcome } from '../../src/pipeline/resolve-transition.ts';
import { BUGFIX_V1, FEATURE_V1, REVIEW_V1 } from '../../src/pipeline/tables/index.ts';
import { resolveAllPass } from './fixtures.ts';

interface SkipTarget {
  readonly phase: string;
  readonly to: PipelineState;
}

/** Mirrors `tables/shared.ts`'s own `SKIP_TARGETS` per profile — kept as independent literal data (see the header
 * comment of `ids.test.ts` for why a totality test never imports the constant it is meant to catch a drift in). */
const FEATURE_SKIP_TARGETS: readonly SkipTarget[] = [
  { phase: 'PREFLIGHT', to: 'BUILD' },
  { phase: 'BUILD', to: 'TEST' },
  { phase: 'TEST', to: 'REVIEW' },
  { phase: 'REVIEW', to: 'SHIP' },
  { phase: 'FIX', to: 'TEST' },
  { phase: 'SHIP', to: 'COMPLETED' },
];
const REVIEW_SKIP_TARGETS: readonly SkipTarget[] = [
  { phase: 'TEST', to: 'REVIEW' },
  { phase: 'FIX', to: 'TEST' },
];

/** The "happy path" reason to fire from a given active phase, per profile — see `tables.totality.test.ts`'s own
 * `EXIT_EXPECTATIONS` for the same mapping over the FULL exit set; this one is just the success edge, used to WALK
 * from a post-skip state all the way to COMPLETED. */
const FEATURE_SUCCESS_REASON: Readonly<Record<string, ReasonOrOutcome>> = {
  PREFLIGHT: 'ready',
  BUILD: 'built',
  TEST: 'tests-pass',
  REVIEW: 'review-approved',
  FIX: 'fixed',
  SHIP: 'shipped',
};
const REVIEW_SUCCESS_REASON: Readonly<Record<string, ReasonOrOutcome>> = {
  TEST: 'tests-pass',
  REVIEW: 'review-delivered',
  FIX: 'fixed',
};

function walkToCompleted(
  table: TransitionTable,
  from: PipelineState,
  successReasonOf: Readonly<Record<string, ReasonOrOutcome>>,
): PipelineState {
  let state = from;
  for (let step = 0; step < 10; step += 1) {
    if (state === 'COMPLETED') return state;
    const reason = successReasonOf[state];
    if (!reason) throw new Error(`walkToCompleted: no success reason known for ${state}`);
    const result = resolveAllPass(table, state, reason);
    if (!result.ok) throw new Error(`walkToCompleted: stuck at ${state} (${JSON.stringify(result)})`);
    state = result.to as PipelineState;
  }
  throw new Error(`walkToCompleted: did not reach COMPLETED from ${from} within 10 steps`);
}

describe.each([
  ['feature', FEATURE_V1, FEATURE_SKIP_TARGETS, FEATURE_SUCCESS_REASON] as const,
  ['bugfix', BUGFIX_V1, FEATURE_SKIP_TARGETS, FEATURE_SUCCESS_REASON] as const,
  ['review', REVIEW_V1, REVIEW_SKIP_TARGETS, REVIEW_SUCCESS_REASON] as const,
])('%s@1 skip totality', (profile, table, targets, successReasonOf) => {
  for (const target of targets) {
    it(`skip ${target.phase} lands on ${target.to}, and the normal path from there reaches COMPLETED`, () => {
      const skipRow = table.rows.find((row) => row.id === `T33-${target.phase}`);
      expect(skipRow, `${profile}@1 has a T33-${target.phase} row`).toBeDefined();
      expect(skipRow?.to).toBe(target.to);
      expect(skipRow?.effects[0]).toBe('record-skip');

      const finalState = walkToCompleted(table, target.to, successReasonOf);
      expect(finalState).toBe('COMPLETED');
    });
  }

  it(`every skip row's precondition is exactly {policy.skip-allows, skip.justified} (${profile}@1)`, () => {
    for (const target of targets) {
      const skipRow = table.rows.find((row) => row.id === `T33-${target.phase}`);
      expect(skipRow?.preconditions).toEqual(['policy.skip-allows', 'skip.justified']);
    }
  });
});

describe('T33 derives its extra effects from the success-path row it replaces (feature@1)', () => {
  it("skip TEST carries mint-review-ref (T08's own entry effect)", () => {
    const row = FEATURE_V1.rows.find((r) => r.id === 'T33-TEST');
    expect(row?.effects).toEqual(['record-skip', 'mint-review-ref']);
  });

  it("skip REVIEW carries record-approved-digest (T10's own entry effect)", () => {
    const row = FEATURE_V1.rows.find((r) => r.id === 'T33-REVIEW');
    expect(row?.effects).toEqual(['record-skip', 'record-approved-digest']);
  });

  it("skip SHIP carries release-locks + write-ship-report (T14's own entry effects)", () => {
    const row = FEATURE_V1.rows.find((r) => r.id === 'T33-SHIP');
    expect(row?.effects).toEqual(['record-skip', 'release-locks', 'write-ship-report']);
  });

  it('skip PREFLIGHT / BUILD / FIX carry no extra effect (no success-path effect to derive)', () => {
    for (const phase of ['PREFLIGHT', 'BUILD', 'FIX']) {
      const row = FEATURE_V1.rows.find((r) => r.id === `T33-${phase}`);
      expect(row?.effects).toEqual(['record-skip']);
    }
  });
});

describe('a skip through REVIEW never bounces SHIP back to TEST, and T15 alone re-validates a stale digest', () => {
  it('T14 (the ONLY "shipped" row from SHIP) targets COMPLETED, never TEST', () => {
    const shippedRows = FEATURE_V1.rows.filter((row) => row.from === 'SHIP' && row.reason === 'shipped');
    expect(shippedRows).toHaveLength(1);
    expect(shippedRows[0]?.to).toBe('COMPLETED');
    expect(shippedRows[0]?.id).toBe('T14');
  });

  it('T15 is the ONLY row that re-validates SHIP -> TEST, gated on the tree digest differing from the approved one', () => {
    const t15 = FEATURE_V1.rows.find((row) => row.id === 'T15');
    expect(t15).toMatchObject({
      from: 'SHIP',
      to: 'TEST',
      reason: 'stop-rule',
      preconditions: ['tree.digest-differs-from-approved'],
    });
    const backToTest = FEATURE_V1.rows.filter((row) => row.from === 'SHIP' && row.to === 'TEST');
    expect(backToTest).toHaveLength(1);
    expect(backToTest[0]?.id).toBe('T15');
  });

  it('resolveTransition finds T15 directly (a concrete `from`, not routed through STOP_ROW_MAPS)', () => {
    const result = resolveAllPass(FEATURE_V1, 'SHIP', 'stop-rule');
    expect(result.ok && result.to).toBe('TEST');
  });
});
