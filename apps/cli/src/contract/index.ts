// apps/cli/src/contract/index.ts — the Wave-0 contract entry point of `apps/cli` (PLAN U0.10, DESIGN 1.2 "safe to
// import in any wave"). Frozen after G0 (PLAN §3 rule 7): a unit that believes it is wrong files a request.
export * from './command-module.ts';
export * from './context.ts';
export * from './doctor.ts';
export * from './documents.ts';
export * from './exit-codes.ts';
export * from './verbs.ts';
