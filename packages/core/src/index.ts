// @cohorte/core — frozen barrel (PLAN U0.08, DESIGN 10.1 rule 3), the composition root's entry point (DESIGN 1.2 L5).
// Inside a wave, prefer the narrower subpath a later unit will finish (`@cohorte/core/engine`,
// `@cohorte/core/contract`, …) over this barrel — it is structural, edited by Wave 0 and by the integrators only.
//
// Two kinds of line below, and the difference is load-bearing (PLAN §3 rule 3, "later units FILL stub files that lie
// inside their owned paths; they never edit a barrel"):
//   - `export *` for the files this unit owns outright (the contract, the lifecycle table, the crash points, the
//     error catalogue);
//   - ONE EXPLICIT LINE PER AREA, re-exporting the area's own `src/<area>/index.ts`. An explicit re-export SHADOWS
//     the `export *` of `./contract/index.ts` (ESM resolves local and indirect export entries before star entries,
//     and TypeScript does the same), so this barrel hands out whatever the AREA file exports today: the
//     `NotImplemented` stub the area re-exports from `contract/factories.ts` while it is still a seam, and the real
//     factory the moment the unit that owns that area fills it — without that unit editing this file or
//     `contract/factories.ts`, neither of which it owns. Fix round 1 (reviewer blocker): before it, a filled area
//     (`events`, `durability/journal`, `durability/lease`) was unreachable through the barrel.
// `pipeline/guards` was the one area of the list with no line here, because `packages/core/src/pipeline/guards/index.ts`
// (U0.09) holds guard predicates rather than the thin re-export every other area uses. Gate G0 closed it
// (docs/v3/requests/U0.08.md R2 / R10, decided in docs/v3/gates/G0.md): the area file now carries that re-export too,
// so the twenty-one areas are uniform and `U2.05` fills its directory without a barrel edit.
// Gate G0 (docs/v3/requests/U0.09.md R1): `./agents/index.ts` in place of `./agents/lifecycle.ts`, so that the
// attempt rule of `agents/lifecycle-table.ts` (`ATTEMPT_CONSUMING_EDGES`, `attemptConsumed`) is published at all.
export * from './agents/index.ts';
export { createAgentSupervisor } from './agents/supervisor/index.ts';
export { createApprovalService, createToolHostReplay } from './approvals/index.ts';
export { createBudgetTracker } from './budgets/index.ts';
export { createContextBuilder } from './context/index.ts';
export * from './contract/index.ts';
export * from './durability/crashpoints.ts';
export { createEffectJournal } from './durability/journal/index.ts';
export { createLeaseManager } from './durability/lease/index.ts';
// `RunEngineDeps` rides with `createEngine` (gate G1, docs/v3/requests/U1.09.md R1): the frozen `EngineDeps` of
// `contract/factories.ts` is the six-field stub type, and the real loop needs thirteen more ports (guards, facts,
// transition effects, the authenticator and its key, the writer, the redactor, the lease manager, the table lookup).
// `U1.09` declared the wider shape in its own area under a DIFFERENT name rather than reshape a frozen contract, and
// that is kept — but a composition root reaching this barrel for `createEngine` must be able to name its parameter,
// so the type is published beside the factory. `EngineDeps` stays exactly what `contract/factories.ts` declares.
export { createEngine, type RunEngineDeps } from './engine/index.ts';
export * from './errors/catalogue.ts';
export { createEventWriter } from './events/index.ts';
export { createGrantComputer } from './grants/index.ts';
export { createIntegrationService } from './integration/index.ts';
export { createLoopController } from './loop/index.ts';
export { createPhaseContracts } from './phases/contracts/index.ts';
export { createPhaseExecutor } from './phases/executor/index.ts';
export { createPipelineGuards } from './pipeline/guards/index.ts';
export { createProjection } from './projection/index.ts';
export { createProvisioner } from './provision/index.ts';
export { createResumer, verifyProjectionAgainstEvents } from './resume/index.ts';
export { createReviewCalculator } from './review/index.ts';
export { createPinReader, createRunSnapshotter } from './snapshot/index.ts';
export { createToolHost } from './toolhost/index.ts';
export { createWorktreeService } from './worktrees/index.ts';
