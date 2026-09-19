// `@cohorte/core/agents` — the area subpath of the agent lifecycle (`packages/core/package.json` maps `./*` to
// `./src/*/index.ts`, so without this file that subpath did not resolve at all).
//
// Written by gate G0 (docs/v3/requests/U0.09.md R1). `AGENT_TRANSITIONS`, `ReincarnateCause` and `reincarnate` live
// in `lifecycle.ts` (U0.08) and reached the frozen barrel already; `ATTEMPT_CONSUMING_EDGES` and `attemptConsumed`
// — the DESIGN 2.5.4 rule behind `agent.state.changed.attemptConsumed` — live in `lifecycle-table.ts` (U0.09) and
// reached NOTHING outside this package. `U2.06` and `U3.03` both read that rule, so the two files are published
// together here and the barrel re-exports this file instead of `lifecycle.ts`.

export * from './lifecycle.ts';
export * from './lifecycle-table.ts';
