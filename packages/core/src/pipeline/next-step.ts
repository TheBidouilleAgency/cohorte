// DESIGN 4.2 E3 — "step = nextStep(state, table): pure; nothing persisted", read BEFORE E4's
// "facts = collectFacts(step.guards)". At E3 the phase outcome / command that will supply `resolveTransition`'s
// `reasonOrOutcome` is not known yet (it is derived elsewhere, after the phase actually runs, or carried by the
// command itself) — so `nextStep`'s job is narrower and fully pure: given only the CURRENT pipeline state, narrow
// the table to every row that could possibly fire from here (`from` matches, exact or wildcard) and hand back the
// UNION of their guard ids, so `collectFacts` gathers everything ANY of them might need in one read-only pass.
// `resolveTransition` (a sibling module) is what later picks the one row that actually fires.
import type { PipelineState } from '@cohorte/protocol';
import type { GuardId } from '../contract/ids.ts';
import type { RunState, TransitionDef, TransitionTable } from '../contract/types.ts';
import { matchesFrom } from './tables/index.ts';

export interface PipelineStep {
  readonly from: PipelineState;
  /** every row reachable from `from`, in table order; several may share the same `(from, reason)` (an "or" of
   * guards spelled as sibling rows, `tables/shared.ts`'s header comment) */
  readonly candidates: readonly TransitionDef[];
  /** the deduplicated union of every candidate's preconditions, ready for `collectFacts` */
  readonly guards: readonly GuardId[];
}

export function nextStep(state: RunState, table: TransitionTable): PipelineStep {
  const from = state.run.state;
  const candidates = table.rows.filter((row) => matchesFrom(row.from, from, table.phases));
  const guards = [...new Set(candidates.flatMap((row) => row.preconditions))] as readonly GuardId[];
  return { from, candidates, guards };
}
