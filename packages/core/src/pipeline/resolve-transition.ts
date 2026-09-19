// DESIGN 2.5.1 — pure lookup + guard check over ONE `TransitionTable`. Never touches a store, never evaluates a
// `Guard` itself: `guardOutcomes` are already-computed `GuardOutcomeLike`s (facts gathered by `collectFacts`,
// evaluated by whatever later wave owns the `GuardRegistry`, DESIGN 2.5.1 "facts are gathered BEFORE").
//
// DEVIATION (docs/v3/requests/U0.09.md): DESIGN names `resolveTransition(table, from, reasonOrOutcome,
// guardOutcomes)` without spelling `reasonOrOutcome`'s shape. Two things need disambiguating beyond a bare
// `TransitionReason`: the ordinary per-phase outcome (`tests-pass`, `built`, `review-approved`, ...) already IS a
// `TransitionReason` one-for-one (DESIGN 2.5.1's own table), so passing it directly covers that half. The half that
// is NOT a 1:1 reason is the `*active`/`*suspended` wildcard "stop-rule" family (T15/T16/T24/T25 all share
// `reason: 'stop-rule'`): DESIGN disambiguates those in PROSE by StopReason set, never by a guard id, so this
// module resolves `{ stop: StopReason }` through `tables/index.ts`'s `STOP_ROW_MAPS` instead of widening
// `TransitionDef` (frozen, U0.08) with a field DESIGN never gives it. A third form, `{ skip: ActivePipelineState }`,
// answers the matrix's `skip` cell in the `*suspended` and FAILED columns, where the row is sourced from the phase
// the run would re-enter and not from where the run is parked (see `ReasonOrOutcome` below).
import type {
  ActivePipelineState,
  GuardOutcome,
  PipelineProfile,
  PipelineState,
  StopReason,
  TransitionReason,
} from '@cohorte/protocol';
import type { TransitionDef, TransitionTable } from '../contract/types.ts';
import { skipDefIdFor } from './command-matrix.ts';
import { matchesFrom, STOP_ROW_MAPS } from './tables/index.ts';

/** `{ skip }` carries the phase the skip fires FROM — for a run parked in PAUSED / WAITING_APPROVAL / AUTH_REQUIRED /
 * QUOTA_EXCEEDED / FAILED that is its `resumeTo`, which is exactly DESIGN 2.5.1's "T33 if policy (on `resumeTo`)".
 * It is a form of its own because `resolveTransition` matches rows by `from` and every skip row carries a CONCRETE
 * active `from`: without it the whole suspended/FAILED `skip` column of the matrix would be unresolvable by the
 * kernel, pushing every consumer to look the row up itself and to evaluate `policy.skip-allows` / `skip.justified`
 * outside the guard check — the bypass I10 exists to prevent. */
export type ReasonOrOutcome = TransitionReason | { readonly stop: StopReason } | { readonly skip: ActivePipelineState };

/** DEVIATION (docs/v3/requests/U0.09.md): `resolveTransition`'s `guardOutcomes` parameter needs the shape a
 * `GuardContext`-evaluated `Guard` produces — that is exactly `@cohorte/protocol`'s `GuardOutcome` (frozen,
 * `{ id, ok, detail? }`). Nothing named `GuardOutcomeLike` exists in `contract/types.ts` (U0.08, frozen); this
 * module uses `GuardOutcome` directly instead of widening the frozen contract with a synonym it never needed. */
export type GuardOutcomeLike = GuardOutcome;

export type ResolveTransitionResult =
  | { ok: true; def: TransitionDef; to: string }
  | { ok: false; reason: 'no-matching-row' }
  /** the bare reason `'stop-rule'` named only WILDCARD-sourced rows (T24 / T25-stop / T26-class rows), which DESIGN
   * 2.5.1 separates by STOP REASON SET and not by a guard: pass `{ stop: StopReason }` instead (see below) */
  | { ok: false; reason: 'stop-reason-required' }
  | { ok: false; reason: 'guard-failed'; def: TransitionDef; failedGuard: string; detail?: string };

function evaluate(def: TransitionDef, outcomes: ReadonlyMap<string, GuardOutcomeLike>): ResolveTransitionResult {
  for (const guardId of def.preconditions) {
    const outcome = outcomes.get(guardId);
    if (!outcome?.ok) {
      const failure: ResolveTransitionResult = { ok: false, reason: 'guard-failed', def, failedGuard: guardId };
      if (outcome?.detail !== undefined) failure.detail = outcome.detail;
      return failure;
    }
  }
  return { ok: true, def, to: def.to };
}

/** Finds the ONE row `(from, reasonOrOutcome)` names and checks its preconditions against `guardOutcomes`.
 * Several rows may share `(from, reason)` (DESIGN's prose "or" of guards, `tables/shared.ts`'s header comment):
 * they are tried in table order and the first whose preconditions ALL hold wins; if none do, the FIRST candidate's
 * first failing guard is reported (DESIGN 2.5.1: "ALL must hold; evaluated in order; first failure is reported"). */
export function resolveTransition(
  table: TransitionTable,
  from: PipelineState,
  reasonOrOutcome: ReasonOrOutcome,
  guardOutcomes: readonly GuardOutcomeLike[],
): ResolveTransitionResult {
  const outcomes = new Map(guardOutcomes.map((outcome) => [outcome.id, outcome] as const));

  if (typeof reasonOrOutcome === 'object') {
    if ('skip' in reasonOrOutcome) {
      // Deliberately NOT checked against `from`: the run is parked in FAILED or a suspended state while the row is
      // sourced from the phase it would re-enter (`resumeTo`). A phase this profile does not let `skip` fire from
      // simply has no such row.
      const def = table.rows.find((row) => row.id === skipDefIdFor(reasonOrOutcome.skip));
      if (!def) return { ok: false, reason: 'no-matching-row' };
      return evaluate(def, outcomes);
    }
    const byReason: Readonly<Record<string, string>> | undefined = STOP_ROW_MAPS[table.profile as PipelineProfile];
    const rowId = byReason?.[reasonOrOutcome.stop];
    const def = rowId ? table.rows.find((row) => row.id === rowId) : undefined;
    if (!def || !matchesFrom(def.from, from, table.phases)) return { ok: false, reason: 'no-matching-row' };
    return evaluate(def, outcomes);
  }

  const matching = table.rows.filter(
    (row) => matchesFrom(row.from, from, table.phases) && row.reason === reasonOrOutcome,
  );
  if (matching.length === 0) return { ok: false, reason: 'no-matching-row' };

  // `'stop-rule'` is the one reason several rows share WITHOUT a guard telling them apart: T15 (SHIP, stale digest)
  // and T16 (TEST, environmental error) carry a concrete `from` and a discriminating precondition, but T24
  // (-> WAITING_APPROVAL) and T25-stop (-> BLOCKED) are both `*active` with `preconditions: []` and are separated by
  // the STOP REASON SET alone (DESIGN 2.5.1: T24 "stop in (iteration-limit, budget-exhausted, timeout,
  // identical-failure, no-progress)", T25 "stop in (policy-violation, unexpected-repo-change, runtime-incompatible)").
  // First-match-wins over them would make T24 swallow every wildcard stop and leave the SECURITY row T25-stop
  // unreachable, so a wildcard stop row is reachable ONLY through the `{ stop }` form, which routes by STOP_ROW_MAPS.
  const candidates = reasonOrOutcome === 'stop-rule' ? matching.filter((row) => !row.from.startsWith('*')) : matching;
  if (candidates.length === 0) return { ok: false, reason: 'stop-reason-required' };

  let firstFailure: ResolveTransitionResult | undefined;
  for (const def of candidates) {
    const result = evaluate(def, outcomes);
    if (result.ok) return result;
    firstFailure ??= result;
  }
  return firstFailure as ResolveTransitionResult;
}
