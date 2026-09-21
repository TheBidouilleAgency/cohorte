#!/usr/bin/env node
// apps/cli/src/cli.ts — DESIGN §9 CLI row: the whole verb registry, built from `contract/verbs.ts` and nothing
// else (PLAN §3 rule 3 "cli.ts pre-registers every verb against commands/<verb>/index.ts; ... nobody edits the
// registry"). `cli.ts` never imports `core`/`runtime-*`/`security`/`persistence` directly: a verb's module, and the
// real `CliContext`, are reached only through `lazy.ts`'s single `import()` site (DESIGN 1.2 net 3 rule g, DESIGN
// 1.3 "read-only verbs never load core/runtime") — so `--help` and `--version`, which commander answers itself
// without ever calling `dispatch`, pay nothing beyond this file and `commander`.
import { toErrorInfo } from '@cohorte/base';
import { Command, CommanderError } from 'commander';
import {
  type CliContext,
  CONTROLLER_EXIT_CODES,
  type CommandArgs,
  EXIT_CODE_BY_CLASS,
  formatExitCodesHelp,
  VERBS,
  type VerbSpec,
} from './contract/index.ts';
import { loadCliContext, loadCommandModule } from './lazy.ts';

/** Mirrors `apps/cli/package.json` "version"; `apps/cli/test/registry/version.test.ts` reads that file and fails
 * if the two ever drift (a literal keeps `--version` free of any file read on the one-shot start-up path). */
export const COHORTE_VERSION = '3.0.0-dev.7';

export interface RuntimeDeps {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** Built lazily: only a verb whose action actually runs calls this (never `--help`/`--version`, DESIGN 1.3). */
  readonly context: () => Promise<CliContext>;
}

function printError(deps: RuntimeDeps, info: ReturnType<typeof toErrorInfo>): void {
  // spec 21: "cause / impact / run / next action / exit code"
  deps.stderr.write(`error: ${info.code}: ${info.message}\n`);
  deps.stderr.write(`impact: ${info.impact}\n`);
  deps.stderr.write(`next action: ${info.remediation}\n`);
}

/** Loads the verb's module, builds its `CliContext` and runs it, converting any throw at this one boundary
 * (DESIGN 2.8: "Every error has ... an exit code"; the module itself never writes to stdio on error). */
async function dispatch(deps: RuntimeDeps, verb: string, args: CommandArgs): Promise<number> {
  try {
    const mod = await loadCommandModule(verb);
    const ctx = await deps.context();
    return await mod.run(ctx, args);
  } catch (error) {
    // DESIGN 2.8: "Unknown throwables -> `<nearest class>/unexpected`". A `CohorteError` keeps its own code through
    // `toErrorInfo`, so the Wave-0 stubs still answer `configuration/phase-not-available`; anything else — a
    // TypeError in a filled-in verb, a failed store open, a module that will not load — is reported as what it is.
    const info = toErrorInfo(error, { code: 'configuration/unexpected', class: 'configuration' });
    printError(deps, info);
    return EXIT_CODE_BY_CLASS[info.class];
  }
}

interface ExitBox {
  code: number;
}

function addAction(command: Command, deps: RuntimeDeps, exit: ExitBox, verb: VerbSpec, subVerb?: string): void {
  command.allowUnknownOption(true).allowExcessArguments(true);
  // `--json` only where DESIGN 2.3.5 gives the verb a published document (`JSON_OUTPUTS`): registering it on every
  // verb would promise a machine output that no schema backs, and the Wave-4 `--json validates` tests read that map.
  if (verb.json) command.option('--json', 'print the machine-readable document for this verb (DESIGN 2.3.5)');
  command.argument('[args...]', 'verb arguments').action(async (positionals: string[], options: { json?: boolean }) => {
    const args: CommandArgs = {
      positionals,
      options,
      json: Boolean(options.json),
      ...(subVerb === undefined ? {} : { subVerb }),
    };
    exit.code = await dispatch(deps, verb.name, args);
  });
}

/** Builds the whole commander tree. Exported so a test can assert on `--help` / registration without spawning a
 * process (PLAN U0.10 test list: "every DESIGN §9 verb is registered exactly once and appears in --help"). */
export function buildProgram(deps: RuntimeDeps, exit: ExitBox): Command {
  const program = new Command('cohorte')
    .description('Cohorte: a durable multi-agent development pipeline with a runtime-independent orchestrator.')
    .version(COHORTE_VERSION, '--version', 'print the Cohorte version')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => deps.stdout.write(str),
      writeErr: (str) => deps.stderr.write(str),
    })
    .addHelpText('after', `\n${formatExitCodesHelp()}\n`);

  for (const verb of VERBS) {
    const sub = program.command(verb.name, verb.hidden ? { hidden: true } : undefined).description(verb.summary);
    if (verb.subVerbs && verb.subVerbs.length > 0) {
      addAction(sub, deps, exit, verb); // bare `cohorte <verb>` with no sub-verb
      for (const subVerb of verb.subVerbs) {
        addAction(sub.command(subVerb), deps, exit, verb, subVerb);
      }
    } else {
      addAction(sub, deps, exit, verb);
    }
  }
  return program;
}

/**
 * `CONTROLLER_EXIT_CODES.usage` (2) for anything commander itself refuses (bad flag, unknown command, no command at
 * all), `completed` (0) for the routes where commander did exactly what was asked and then stopped the parse.
 *
 * Keyed off commander's OWN `exitCode`, not off the code NAME: commander raises `commander.help` both for the
 * advertised `help [command]` route (which prints the help and means exit 0) and for a bare `cohorte` with no
 * command (exit 1 there — a usage error), and an allow-list of names got the first case wrong while `--help`,
 * raising `commander.helpDisplayed`, was right. `error.exitCode` already separates the two.
 */
function commanderExitCode(error: CommanderError): number {
  return error.exitCode === 0 ? CONTROLLER_EXIT_CODES.completed : CONTROLLER_EXIT_CODES.usage;
}

/** Parses `argv` (no leading node/script entries) and runs the matched verb. Never calls `process.exit`: the
 * caller (`main()` below, or a test) owns that decision. */
export async function runCli(argv: readonly string[], deps: RuntimeDeps): Promise<number> {
  const exit: ExitBox = { code: CONTROLLER_EXIT_CODES.completed };
  const program = buildProgram(deps, exit);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return commanderExitCode(error);
    throw error;
  }
  return exit.code;
}

async function realContext(): Promise<CliContext> {
  return loadCliContext({
    cwd: process.cwd(),
    env: process.env,
    stdio: { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
  });
}

async function main(): Promise<void> {
  const deps: RuntimeDeps = { stdout: process.stdout, stderr: process.stderr, context: realContext };
  const code = await runCli(process.argv.slice(2), deps);
  process.exitCode = code;
}

// `import.meta.main` (node >= 24.2; `apps/cli` engines are `^24.16.0 || >=26.1.0`) and NOT a hand-rolled
// `import.meta.url === \`file://${process.argv[1]}\``: npm installs `bin` as a SYMLINK
// (`node_modules/.bin/cohorte` -> `../cohorte/dist/cli.mjs`), so the comparison is false for every real install and
// the published CLI would print nothing and exit 0. It also breaks on any install path with a space or a non-ASCII
// character (`import.meta.url` is percent-encoded, `argv[1]` is not).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
