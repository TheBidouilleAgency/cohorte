// apps/cli/src/contract/verbs.ts — DESIGN §9 "V3.0 scope cut" CLI row + the verb-semantics paragraph, and DESIGN
// 2.3.4 "every command type has a CLI verb, because one-shot CLI spawns are the only V3.0 transport". `cli.ts`
// builds the whole commander tree from this table and NOTHING ELSE (PLAN §3 rule 3: "cli.ts pre-registers every
// verb against commands/<verb>/index.ts"); a later wave fills a verb's module, never this table's shape.
import type { CommandType } from '@cohorte/protocol';

export interface VerbSpec {
  readonly name: string;
  readonly summary: string;
  /** DESIGN §9: `config get|set|validate|trust`, `auth login|status|logout`, `providers list|test`, ... */
  readonly subVerbs?: readonly string[];
  /** Not listed in `cohorte --help` (the `__host` internal entry point, DESIGN 4.7). */
  readonly hidden?: boolean;
  /**
   * This verb accepts `--json` and publishes a document for it (DESIGN 2.3.5). Set exactly on the verbs that have
   * a `JSON_OUTPUTS` entry — `cli.ts` registers the `--json` option only for those, and
   * `apps/cli/test/registry/json-outputs.test.ts` pins the two sides equal in BOTH directions, so a verb can never
   * be silently flagged `--json` with no document behind it.
   */
  readonly json?: boolean;
  /** The `@cohorte/protocol` `CommandType` this verb drives 1:1, when it drives exactly one (DESIGN 2.3.4). */
  readonly commandType?: CommandType;
}

export const VERBS: readonly VerbSpec[] = [
  { name: 'init', summary: 'Scaffold .cohorte/ for this repository' },
  { name: 'doctor', summary: 'Diagnose the installation, configuration and toolchain', json: true },
  { name: 'discover', summary: 'Print the deterministic project scan (no write)', json: true },
  { name: 'run', summary: 'Start a pipeline run', commandType: 'start', json: true },
  { name: 'loop', summary: 'Run a feature through the durable V3 workflow' },
  { name: 'status', summary: 'Show a run, or the project, status', commandType: 'status', json: true },
  {
    name: 'inspect',
    summary: 'Inspect one agent, context, approval, effect, snapshot, lock, diff or artifact',
    commandType: 'inspect',
    json: true,
  },
  { name: 'resume', summary: 'Resume a suspended run', commandType: 'resume', json: true },
  { name: 'pause', summary: 'Pause an active run', commandType: 'pause', json: true },
  { name: 'cancel', summary: 'Cancel a run', commandType: 'cancel', json: true },
  { name: 'shutdown', summary: 'Ask the detached host to shut down gracefully', commandType: 'shutdown', json: true },
  { name: 'approve', summary: 'Approve a pending approval request', commandType: 'approve', json: true },
  { name: 'deny', summary: 'Deny a pending approval request', commandType: 'deny', json: true },
  { name: 'retry', summary: 'Retry a phase or an agent', commandType: 'retry', json: true },
  { name: 'skip', summary: 'Skip a phase (only if policy.skip lists it)', commandType: 'skip', json: true },
  { name: 'logs', summary: 'Print durable run events' },
  { name: 'tail', summary: 'Follow a run (durable + ephemeral events)', commandType: 'tail' },
  { name: 'diff', summary: 'Show the run diff for a surface', json: true },
  { name: 'review', summary: 'Start a review-profile run over a ref range or a prior run' },
  { name: 'fix', summary: "Retry a run's FIX phase" },
  { name: 'ship', summary: 'Show and resolve the pending ship approval' },
  { name: 'auth', summary: 'Manage provider authentication', subVerbs: ['login', 'status', 'logout'], json: true },
  { name: 'providers', summary: 'List or test configured providers', subVerbs: ['list', 'test'] },
  { name: 'models', summary: 'List available models', subVerbs: ['list'] },
  {
    name: 'config',
    summary: 'Read, write, validate or trust the project configuration',
    subVerbs: ['get', 'set', 'validate', 'trust'],
  },
  { name: 'migrate', summary: 'Check or apply state-store migrations' },
  {
    name: 'reconcile',
    summary: 'Plan the project configuration against the discovered state',
    commandType: 'reconcile',
    json: true,
  },
  { name: 'spec', summary: 'Validate or freeze a human-written spec', subVerbs: ['validate', 'freeze'] },
  {
    name: 'obsidian',
    summary: 'Connect and synchronize an Obsidian board',
    subVerbs: ['create', 'connect', 'status', 'move'],
  },
  { name: 'policy', summary: 'Explain the effective security policy', subVerbs: ['explain'] },
  { name: 'gc', summary: 'Garbage-collect worktrees, spools and old runs' },
  {
    name: 'update',
    // DESIGN §9 spells it as a FLAG, `update --check`, not a sub-verb: the Wave-5 unit that fills
    // `commands/update/index.ts` reads `--check` from `args.options`/`args.positionals` like every other verb flag.
    summary: 'Check for a newer pinned install (offline, --check only in V3.0)',
  },
  { name: 'brainstorm', summary: 'Create a draft feature spec from an idea' },
  { name: 'patch', summary: 'Create a minimal regression patch spec' },
  {
    name: 'run-tool',
    summary: 'Run one tool directly (admin; policy.admin.runTool)',
    commandType: 'run-tool',
    json: true,
  },
  {
    name: 'send',
    summary: 'Send text to a running agent (policy.steer.enabled)',
    commandType: 'agent.send',
    json: true,
  },
  { name: '__host', summary: 'Internal: run the detached host in-process', hidden: true },
];

const BY_NAME = new Map(VERBS.map((verb) => [verb.name, verb]));

export function findVerb(name: string): VerbSpec | undefined {
  return BY_NAME.get(name);
}

export const VERB_NAMES: readonly string[] = VERBS.map((verb) => verb.name);

/** DESIGN 2.3.4: every `CommandType` has exactly one driving verb. Built from `VERBS`, so it can never drift. */
export const COMMAND_TYPE_TO_VERB: Readonly<Record<CommandType, string>> = Object.freeze(
  Object.fromEntries(
    VERBS.filter((verb): verb is VerbSpec & { commandType: CommandType } => verb.commandType !== undefined).map(
      (verb) => [verb.commandType, verb.name],
    ),
  ) as Record<CommandType, string>,
);
