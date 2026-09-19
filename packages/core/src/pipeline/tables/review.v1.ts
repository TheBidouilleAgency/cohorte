// DESIGN 2.5.1 / ADR-0018 §3: `review@1` — `IDLE -> REVIEW` (guards `reviewtarget.resolved-to-sha`,
// `snapshot.captured`, `auth.plan-satisfied`; effect `mint-review-ref`), `REVIEW -> COMPLETED` on any verdict
// (reason `review-delivered`: the verdict IS the product), and `REVIEW -> FIX -> TEST -> REVIEW` only when the run
// was started `withFix`. T20-T33 identical in SHAPE to feature/bugfix (ADR-0018 §3), but T33 (skip) and the
// StopReason placements for `check-environment` / `review-clean` are re-derived against THIS table's own rows: this
// profile has no SHIP, so `review-clean` lands on R02 (REVIEW -> COMPLETED) instead of feature's T14.
//
// `reviewtarget.resolved-to-sha` is a member of `GUARD_IDS` (contract/ids.ts, frozen by U0.08): an earlier draft of
// this file recorded it as a gap (see git history / docs/v3/requests/U0.09.md) before checking the frozen file
// itself — it was already there, so `R01`'s preconditions are typed `readonly GuardId[]` like every other row.
import type { ActivePipelineState } from '@cohorte/protocol';
import type { GuardId } from '../../contract/ids.ts';
import type { TransitionDef, TransitionTable } from '../../contract/types.ts';
import { buildSkipRows, buildTailRows, stopRowMap } from './shared.ts';

const PHASES: readonly ActivePipelineState[] = ['TEST', 'REVIEW', 'FIX'];

const HEAD_ROWS: readonly TransitionDef[] = [
  {
    id: 'R01',
    from: 'IDLE',
    to: 'REVIEW',
    reason: 'start',
    actor: 'either',
    preconditions: [
      'reviewtarget.resolved-to-sha',
      'snapshot.captured',
      'auth.plan-satisfied',
    ] satisfies readonly GuardId[],
    effects: ['mint-review-ref'],
  },
  // "on any verdict": guard semantics (later wave) decide `nothing-to-fix` as either no fix items, or fix items
  // but the run was not started `withFix` — the profile-level distinction is the guard implementation's job, not
  // this table's (PLAN's "smallest consistent reading": reuse the existing id rather than mint a `withFix`-shaped
  // one `GUARD_IDS` does not have either).
  {
    id: 'R02',
    from: 'REVIEW',
    to: 'COMPLETED',
    reason: 'review-delivered',
    actor: 'system',
    preconditions: ['review.nothing-to-fix'] satisfies readonly GuardId[],
    effects: [],
  },
  {
    id: 'R03',
    from: 'REVIEW',
    to: 'FIX',
    reason: 'review-findings',
    actor: 'system',
    preconditions: ['review.has-fix-items', 'loop.may-continue'] satisfies readonly GuardId[],
    effects: [],
  },
  {
    id: 'R04',
    from: 'FIX',
    to: 'TEST',
    reason: 'fixed',
    actor: 'system',
    preconditions: ['agents.all-completed', 'diff.within-ownership', 'integration.merged'] satisfies readonly GuardId[],
    effects: [],
  },
  {
    id: 'R05',
    from: 'TEST',
    to: 'REVIEW',
    reason: 'tests-pass',
    actor: 'system',
    preconditions: ['checks.all-passed', 'checks.digest-equals-integration'] satisfies readonly GuardId[],
    effects: ['mint-review-ref'],
  },
  {
    id: 'R06',
    from: 'TEST',
    to: 'FIX',
    reason: 'tests-fail',
    actor: 'system',
    preconditions: ['checks.failed-non-environmental', 'loop.may-continue'] satisfies readonly GuardId[],
    effects: ['synthesize-check-findings'],
  },
  {
    id: 'R07',
    from: 'TEST',
    to: 'FAILED',
    reason: 'stop-rule',
    actor: 'system',
    preconditions: ['checks.errored-environmental'] satisfies readonly GuardId[],
    effects: ['checkpoint-worktrees', 'checkpoint'],
  },
];

export const REVIEW_STOP_ROW_MAP = stopRowMap({ checkEnvironment: 'R07', reviewClean: 'R02' });

const SKIP_TARGETS = [
  { phase: 'TEST', to: 'REVIEW' },
  { phase: 'FIX', to: 'TEST' },
] as const;

export const REVIEW_V1 = {
  profile: 'review',
  version: 1,
  initial: 'IDLE',
  phases: PHASES,
  rows: [...HEAD_ROWS, ...buildTailRows(), ...buildSkipRows('review', PHASES, HEAD_ROWS, SKIP_TARGETS)],
} as const satisfies TransitionTable;
