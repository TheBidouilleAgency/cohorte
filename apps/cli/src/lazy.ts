// apps/cli/src/lazy.ts — the ONLY `import(` site of `apps/cli/src` (DESIGN 1.2 net 3 rule g, DESIGN 1.3, DESIGN
// 6.3 §"read-only verbs never load core/runtime"). `check-layers` refuses `import(` anywhere else under
// `apps/cli/src/**` (rule g is per FILE, not per occurrence), so a verb module that needs `compose`/`host`/etc.
// reaches them only through here, which keeps `cli.ts` (and every module reachable from it without going through
// `lazy.ts`) inside François' 10 s / 4 MiB one-shot budget for a verb that never needs the heavy ports.
import type { CliContext, CommandModule } from './contract/index.ts';

/** What `compose/index.ts` (U4.01) exports: assembles the real `CliContext` from process-level inputs. */
export interface ComposeInputs {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: {
    readonly stdout: NodeJS.WritableStream;
    readonly stderr: NodeJS.WritableStream;
    readonly stdin: NodeJS.ReadableStream;
  };
}

/**
 * One LITERAL specifier per verb, closed over a thunk. A computed specifier (`` import(`./commands/${verb}/…`) ``)
 * is invisible to every bundler: rolldown would leave the template in `dist/cli.mjs` and emit no verb chunk, so the
 * SHIPPED cli could not execute a single verb (it would try to load a `.ts` file next to `dist/`). Written out, each
 * specifier is statically analysable: rolldown code-splits one chunk per verb, laziness is preserved, and
 * `apps/cli/test/registry/lazy.test.ts` pins this map against `VERBS` in both directions so a verb added to the
 * registry without a loader — or the reverse — fails Wave 0's own check.
 */
export const COMMAND_MODULES: Readonly<Record<string, () => Promise<unknown>>> = Object.freeze({
  init: () => import('./commands/init/index.ts'),
  doctor: () => import('./commands/doctor/index.ts'),
  discover: () => import('./commands/discover/index.ts'),
  run: () => import('./commands/run/index.ts'),
  status: () => import('./commands/status/index.ts'),
  inspect: () => import('./commands/inspect/index.ts'),
  resume: () => import('./commands/resume/index.ts'),
  pause: () => import('./commands/pause/index.ts'),
  cancel: () => import('./commands/cancel/index.ts'),
  shutdown: () => import('./commands/shutdown/index.ts'),
  approve: () => import('./commands/approve/index.ts'),
  deny: () => import('./commands/deny/index.ts'),
  retry: () => import('./commands/retry/index.ts'),
  skip: () => import('./commands/skip/index.ts'),
  logs: () => import('./commands/logs/index.ts'),
  tail: () => import('./commands/tail/index.ts'),
  diff: () => import('./commands/diff/index.ts'),
  review: () => import('./commands/review/index.ts'),
  fix: () => import('./commands/fix/index.ts'),
  ship: () => import('./commands/ship/index.ts'),
  auth: () => import('./commands/auth/index.ts'),
  providers: () => import('./commands/providers/index.ts'),
  models: () => import('./commands/models/index.ts'),
  config: () => import('./commands/config/index.ts'),
  migrate: () => import('./commands/migrate/index.ts'),
  reconcile: () => import('./commands/reconcile/index.ts'),
  spec: () => import('./commands/spec/index.ts'),
  policy: () => import('./commands/policy/index.ts'),
  gc: () => import('./commands/gc/index.ts'),
  update: () => import('./commands/update/index.ts'),
  brainstorm: () => import('./commands/brainstorm/index.ts'),
  'run-tool': () => import('./commands/run-tool/index.ts'),
  send: () => import('./commands/send/index.ts'),
  __host: () => import('./commands/__host/index.ts'),
});

/** Loads `commands/<verb>/index.ts` and returns its default export. */
export async function loadCommandModule(verb: string): Promise<CommandModule> {
  const load = COMMAND_MODULES[verb];
  if (!load) throw new RangeError(`lazy.ts: no command module registered for verb "${verb}"`);
  const loaded = await load();
  const mod = loaded as { default?: CommandModule };
  if (!mod.default || typeof mod.default.run !== 'function') {
    throw new TypeError(`lazy.ts: commands/${verb}/index.ts has no default CommandModule export`);
  }
  return mod.default;
}

/**
 * The one `import(` of `./compose/index.ts` (DESIGN 1.2 net 3 rule g): `cli.ts` reaches the real `CliContext`
 * only through here, so a read-only verb whose action never runs never pays for it either (DESIGN 1.3).
 */
export async function loadCliContext(inputs: ComposeInputs): Promise<CliContext> {
  const loaded: unknown = await import('./compose/index.ts');
  const mod = loaded as { composeCliContext?: (inputs: ComposeInputs) => Promise<CliContext> };
  if (typeof mod.composeCliContext !== 'function') {
    throw new TypeError('lazy.ts: compose/index.ts has no composeCliContext export');
  }
  return mod.composeCliContext(inputs);
}
