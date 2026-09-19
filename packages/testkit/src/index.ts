// @cohorte/testkit — dev-only, never bundled. This barrel exports the FOUNDATION only (PLAN U0.02). Every later
// area (fake-brain, store-factory, http-provider, crash, run-cli, golden) is reached through its own subpath
// (`@cohorte/testkit/<area>`), so a half-written area can never break a sibling's test run. Do not add one here.
export * from './fake-redactor/index.ts';
export * from './fault-injector/index.ts';
export * from './fixed-clock/index.ts';
export * from './git-env/index.ts';
export * from './seq-ids/index.ts';
export * from './temp-repo/index.ts';
