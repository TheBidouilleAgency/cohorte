// @cohorte/core/pipeline — the state-machine kernel (PLAN U0.09, DESIGN 2.5.1 / 2.5.4 / ADR-0018): the versioned
// transition tables, the command x state matrix, and the pure functions that read them. Safe to import from any
// later wave once this unit's check is green (PLAN's optimistic-scheduling rule): the exported names are published.
export * from './command-matrix.ts';
export * from './guards/index.ts';
export * from './idempotency-key.ts';
export * from './next-step.ts';
export * from './resolve-transition.ts';
export * from './tables/index.ts';
