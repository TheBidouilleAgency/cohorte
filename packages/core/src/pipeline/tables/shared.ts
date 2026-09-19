// DESIGN 2.5.1 — pieces every versioned transition table (`feature.v1.ts`, `bugfix.v1.ts`, `review.v1.ts`) shares:
// the `*active` / `*suspended` / `*any-non-terminal` wildcard matcher, the T20-T27 + T30-T32 "tail" (identical across
// profiles per ADR-0018 §3: "T20-T33 identical"), `entryEffectsOf` (T33's derivation rule) and the StopReason -> row
// lookup the totality tests hold every table to.
//
// DEVIATION (recorded in docs/v3/requests/U0.09.md): `TransitionDef.from` is ONE string (DESIGN 2.5.1's own type),
// so a row whose prose lists several `from` values or an "or" of guards cannot be a single AND-precondition row.
// Two patterns close the gap without widening the frozen `TransitionDef` shape (contract/types.ts, U0.08, read-only):
//  1. A wildcard `from` — `*active`, `*suspended`, and one this file ADDS, `*any-non-terminal` (T27's
//     `{IDLE,*active,*suspended,FAILED,BLOCKED}`) — resolved by `matchesFrom`.
//  2. An "or" of guards (T06, T12) becomes SEVERAL candidate rows with the same `(from, reason, to)` and one guard
//     each; `resolveTransition` tries candidates in table order and returns the first whose preconditions all hold,
//     which is exactly OR semantics over AND-only rows.
import type {
  ActivePipelineState,
  PipelineProfile,
  PipelineState,
  StopReason,
  TransitionReason,
} from '@cohorte/protocol';
import { ACTIVE_PIPELINE_STATES, SUSPENDED_STATES, TERMINAL_STATES } from '@cohorte/protocol';
import type { GuardId, TransitionEffectId } from '../../contract/ids.ts';
import type { TransitionDef, TransitionTable } from '../../contract/types.ts';

/** Not in DESIGN's two named wildcards: T27 alone needs "everywhere except the two terminal states". */
export const ANY_NON_TERMINAL_FROM = '*any-non-terminal';
export const ACTIVE_FROM = '*active';
export const SUSPENDED_FROM = '*suspended';
export const RESUME_TO = '*resumeTo';

const SUSPENDED_SET: readonly string[] = SUSPENDED_STATES;
const TERMINAL_SET: readonly string[] = TERMINAL_STATES;

/** Whether a row's `from` (a concrete state or one of the three wildcards above) covers the given state.
 *
 * `*active` is resolved against the TABLE's own `phases`, not the global `ACTIVE_PIPELINE_STATES`: a profile that
 * removes a phase (bugfix@1 has no BRAINSTORM/SPEC, review@1 only TEST/REVIEW/FIX) must not have its wildcard tail
 * fire from a state it does not have — `tables.totality.test.ts`'s "no row is SOURCED from an active state outside
 * table.phases" is the mirror of the existing "no row TARGETS a state outside table.phases". `*suspended` and
 * `*any-non-terminal` are unaffected: no suspended state is ever a phase, and T27 (`cancel`) is legal from every
 * non-terminal state by design. The default keeps the global set so a caller without a table still behaves. */
export function matchesFrom(
  rowFrom: string,
  state: PipelineState,
  activePhases: readonly ActivePipelineState[] = ACTIVE_PIPELINE_STATES,
): boolean {
  switch (rowFrom) {
    case ACTIVE_FROM:
      return (activePhases as readonly string[]).includes(state);
    case SUSPENDED_FROM:
      return SUSPENDED_SET.includes(state);
    case ANY_NON_TERMINAL_FROM:
      return !TERMINAL_SET.includes(state);
    default:
      return rowFrom === state;
  }
}

/** DESIGN 2.5.1 T33: derived from the table, never hand-listed twice. Empty for PREFLIGHT, BUILD and FIX. */
const SUCCESS_REASON_BY_PHASE: Readonly<Partial<Record<ActivePipelineState, TransitionReason>>> = {
  TEST: 'tests-pass',
  REVIEW: 'review-approved',
  SHIP: 'shipped',
};

export function entryEffectsOf(table: TransitionTable, phase: ActivePipelineState): readonly TransitionEffectId[] {
  const reason = SUCCESS_REASON_BY_PHASE[phase];
  if (!reason) return [];
  const row = table.rows.find((candidate) => candidate.from === phase && candidate.reason === reason);
  return (row?.effects ?? []) as readonly TransitionEffectId[];
}

/** One phase this profile lets `skip` fire from, and where it lands — the profile's OWN "next(X)", never a shared
 * constant: a skip row must target a state inside `table.phases` like every other row (the totality test PLAN §…
 * requires of every row). feature/bugfix's REVIEW skips to SHIP; review@1 lets `skip` fire from TEST and FIX only —
 * its REVIEW is NOT skippable, because in that profile the verdict is the product. */
export interface SkippablePhaseTarget {
  phase: ActivePipelineState;
  to: PipelineState;
}

function skipRow(target: SkippablePhaseTarget, entryEffects: readonly TransitionEffectId[]): TransitionDef {
  return {
    id: `T33-${target.phase}`,
    from: target.phase,
    to: target.to,
    reason: 'skip-command',
    actor: 'human',
    preconditions: ['policy.skip-allows', 'skip.justified'] satisfies readonly GuardId[],
    effects: ['record-skip', ...entryEffects],
  };
}

/** Built AFTER the profile's own rows exist, so `entryEffectsOf` reads real success-path effects instead of a second,
 * hand-typed copy (T33's own deliverable text). `profile`/`phases` are only what `entryEffectsOf` needs to find the
 * success-path row per skippable phase; the returned rows carry no profile of their own. */
export function buildSkipRows(
  profile: PipelineProfile,
  phases: readonly ActivePipelineState[],
  headRows: readonly TransitionDef[],
  targets: readonly SkippablePhaseTarget[],
): readonly TransitionDef[] {
  const partial: TransitionTable = { profile, version: 1, initial: 'IDLE', phases, rows: headRows };
  return targets.map((target) => skipRow(target, entryEffectsOf(partial, target.phase)));
}

/** The T20-T32 tail (DESIGN ADR-0018 §3: "T20-T33 identical"), parameterised only by which row answers
 * `check-environment` and `review-clean` in THIS profile (T33 is profile-specific: `buildSkipRows` above). */
export function buildTailRows(): readonly TransitionDef[] {
  return [
    {
      id: 'T20',
      from: ACTIVE_FROM,
      to: 'PAUSED',
      reason: 'pause-command',
      actor: 'human',
      preconditions: [],
      effects: ['park-agents', 'checkpoint-worktrees'],
    },
    {
      id: 'T21',
      from: ACTIVE_FROM,
      to: 'WAITING_APPROVAL',
      reason: 'needs-human',
      actor: 'system',
      preconditions: ['approval.pending-blocking'] satisfies readonly GuardId[],
      effects: [],
    },
    {
      id: 'T22',
      from: ACTIVE_FROM,
      to: 'AUTH_REQUIRED',
      reason: 'auth-required',
      actor: 'system',
      preconditions: [],
      effects: ['park-agents', 'checkpoint-worktrees'],
    },
    {
      id: 'T23',
      from: ACTIVE_FROM,
      to: 'QUOTA_EXCEEDED',
      reason: 'quota-exceeded',
      actor: 'system',
      preconditions: [],
      effects: ['park-agents', 'checkpoint-worktrees', 'schedule-wakeup'],
    },
    {
      id: 'T24',
      from: ACTIVE_FROM,
      to: 'WAITING_APPROVAL',
      reason: 'stop-rule',
      actor: 'system',
      preconditions: [],
      effects: ['open-approval'],
    },
    {
      id: 'T25',
      from: ACTIVE_FROM,
      to: 'BLOCKED',
      reason: 'security-violation',
      actor: 'system',
      preconditions: [],
      effects: ['cancel-agents', 'freeze-worktrees'],
    },
    {
      id: 'T25-stop',
      from: ACTIVE_FROM,
      to: 'BLOCKED',
      reason: 'stop-rule',
      actor: 'system',
      preconditions: [],
      effects: ['cancel-agents', 'freeze-worktrees'],
    },
    {
      id: 'T26',
      from: ACTIVE_FROM,
      to: 'FAILED',
      reason: 'unexpected-error',
      actor: 'system',
      preconditions: [],
      effects: ['cancel-agents', 'checkpoint-worktrees', 'checkpoint'],
    },
    {
      id: 'T27',
      from: ANY_NON_TERMINAL_FROM,
      to: 'CANCELLED',
      reason: 'cancel-command',
      actor: 'human',
      preconditions: [],
      effects: ['cancel-agents', 'release-locks'],
    },
    // DESIGN 2.5.1 conditions T30's extra guard on the suspension CAUSE ("plus `approval.none-pending-blocking` /
    // `auth.plan-satisfied`), but the command matrix maps the WHOLE `*suspended` column of `resume` to this single
    // id: a human `resume` on an AUTH_REQUIRED or QUOTA_EXCEEDED run fires T30, never the cause-keyed siblings below
    // (they answer the SYSTEM reasons `auth-restored` / `quota-reset`, which no `resume` command carries). A wildcard
    // row must therefore be at least as strict as every cause it covers, so T30 carries BOTH extra guards — resuming
    // into an active phase with auth broken would only bounce the run straight back to AUTH_REQUIRED through T22.
    {
      id: 'T30',
      from: SUSPENDED_FROM,
      to: RESUME_TO,
      reason: 'resume-command',
      actor: 'either',
      preconditions: [
        'resume.locks-rebuilt',
        'resume.git-verified',
        'runtime.pin-valid',
        'approval.none-pending-blocking',
        'auth.plan-satisfied',
      ] satisfies readonly GuardId[],
      effects: [],
    },
    {
      id: 'T30-approval',
      from: SUSPENDED_FROM,
      to: RESUME_TO,
      reason: 'approval-resolved',
      actor: 'either',
      preconditions: [
        'resume.locks-rebuilt',
        'resume.git-verified',
        'runtime.pin-valid',
        'approval.none-pending-blocking',
      ] satisfies readonly GuardId[],
      effects: [],
    },
    {
      id: 'T30-auth',
      from: SUSPENDED_FROM,
      to: RESUME_TO,
      reason: 'auth-restored',
      actor: 'either',
      preconditions: [
        'resume.locks-rebuilt',
        'resume.git-verified',
        'runtime.pin-valid',
        'auth.plan-satisfied',
      ] satisfies readonly GuardId[],
      effects: [],
    },
    {
      id: 'T30-quota',
      from: SUSPENDED_FROM,
      to: RESUME_TO,
      reason: 'quota-reset',
      actor: 'either',
      preconditions: ['resume.locks-rebuilt', 'resume.git-verified', 'runtime.pin-valid'] satisfies readonly GuardId[],
      effects: [],
    },
    // DESIGN 2.5.1 defines T31 as "T30 guards + `retry.target-legal`" and T32 as "`resume.acknowledged` + T30
    // guards", so both follow T30's guard list above.
    {
      id: 'T31',
      from: 'FAILED',
      to: RESUME_TO,
      reason: 'retry-command',
      actor: 'human',
      preconditions: [
        'resume.locks-rebuilt',
        'resume.git-verified',
        'runtime.pin-valid',
        'approval.none-pending-blocking',
        'auth.plan-satisfied',
        'retry.target-legal',
      ] satisfies readonly GuardId[],
      effects: [],
    },
    {
      id: 'T32',
      from: 'BLOCKED',
      to: RESUME_TO,
      reason: 'resume-command',
      actor: 'human',
      preconditions: [
        'resume.acknowledged',
        'resume.locks-rebuilt',
        'resume.git-verified',
        'runtime.pin-valid',
        'approval.none-pending-blocking',
        'auth.plan-satisfied',
      ] satisfies readonly GuardId[],
      effects: ['record-human-ack'],
    },
  ];
}

/** DESIGN 2.5.3 / spec 11.2: the row every `StopReason` resolves to, in THIS profile — `check-environment` and
 * `review-clean` are profile-specific (a review table has no SHIP, a feature/bugfix table's REVIEW-clean success
 * path is T14; see the totality test for why each placement was chosen). */
export function stopRowMap(profileSpecific: {
  checkEnvironment: string;
  reviewClean: string;
}): Readonly<Record<StopReason, string>> {
  return {
    'review-clean': profileSpecific.reviewClean,
    'iteration-limit': 'T24',
    'budget-exhausted': 'T24',
    timeout: 'T24',
    'identical-failure': 'T24',
    'no-progress': 'T24',
    'policy-violation': 'T25-stop',
    'approval-required': 'T21',
    'unexpected-repo-change': 'T25-stop',
    'runtime-incompatible': 'T25-stop',
    'auth-required': 'T22',
    'quota-exceeded': 'T23',
    paused: 'T20',
    cancelled: 'T27',
    'agent-dead': 'T24',
    unreviewed: 'T21',
    'internal-error': 'T26',
    'check-environment': profileSpecific.checkEnvironment,
  };
}
