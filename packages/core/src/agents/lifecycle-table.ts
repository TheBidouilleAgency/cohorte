// DESIGN 2.5.4 — the agent lifecycle table this unit's plan entry (PLAN U0.09) lists as a deliverable
// (`AGENT_TRANSITIONS`, `ReincarnateCause`, the four reincarnation edges, "`attempt` is incremented by
// `failed -> retrying` and `failed -> escalated` ONLY").
//
// DEVIATION (docs/v3/requests/U0.09.md): `packages/core/src/agents/lifecycle.ts` — owned by U0.08, already green,
// sequenced BEFORE this unit — already ships a verbatim DESIGN-2.5.4 implementation of exactly this table (same
// `AGENT_TRANSITIONS` shape, same `ReincarnateCause`, same `reincarnate()`), as part of U0.08's `core/src/*/index.ts`
// stub pass. This looks like a genuine PLAN-level duplication (two units independently assigned the same DESIGN
// section's deliverable under two different file names) rather than two DIFFERENT things to build. Re-implementing
// it a second time here would leave two sources of truth for one closed, `satisfies`-total table — a drift hazard,
// not a feature — so this file is the import point PLAN promises at `agents/lifecycle-table.ts` and simply
// re-exports U0.08's (this unit's OWN tests, `test/state/lifecycle-table.test.ts`, still prove the totality DESIGN
// 2.5.4 and this unit's "tests first" list require, through this file).

import type { AgentState } from '@cohorte/protocol';

export type { ReincarnateCause } from './lifecycle.ts';
export { AGENT_TRANSITIONS, reincarnate } from './lifecycle.ts';

/**
 * DESIGN 2.5.4's rule "stated once" — **`attempt` is incremented by exactly two edges, `failed -> retrying` and
 * `failed -> escalated`, and by nothing else** — AS DATA (PLAN U0.09's third deliverable), so `agent.state.changed`'s
 * `attemptConsumed` (DESIGN 2.3.3: "true **only** for `reason: 'retry'` and `'escalation'`") has ONE source of truth
 * instead of being re-derived from prose by every producer. The two edges are exactly those two reasons:
 * `failed -> retrying` is `reason: 'retry'`, `failed -> escalated` is `reason: 'escalation'`.
 *
 * Everything else leaves `attempt` untouched — in particular the four REINCARNATION edges
 * (`spawning | running | waiting | paused -> spawning`, `reincarnate()` above), the initial `planned -> spawning`,
 * and `retrying | escalated -> spawning`, whose increment already happened on the hop INTO `retrying`/`escalated`.
 */
export const ATTEMPT_CONSUMING_EDGES = [
  ['failed', 'retrying'],
  ['failed', 'escalated'],
] as const satisfies readonly (readonly [AgentState, AgentState])[];

/** Whether the lifecycle edge `from -> to` consumes one of the agent's `maxAttempts` (see `ATTEMPT_CONSUMING_EDGES`).
 * Total: it answers for any pair of `AgentState`s, edge of `AGENT_TRANSITIONS` or not. */
export function attemptConsumed(from: AgentState, to: AgentState): boolean {
  return ATTEMPT_CONSUMING_EDGES.some(([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to);
}
