// apps/cli/src/contract/command-module.ts — DESIGN 10.1 rule 3 "every barrel entry is a live export": each verb's
// `commands/<verb>/index.ts` implements `CommandModule`. Wave 0 fills every one with `notImplementedCommand` (the
// documented not-available error, spec 24 `configuration/phase-not-available`); later waves replace the body,
// never the shape — `cli.ts` and `lazy.ts` never change to accommodate a filled-in verb.
import { CohorteError, errorOf } from '@cohorte/base';
import type { CliContext } from './context.ts';

/** What `cli.ts` hands a module after commander parsed the line: positionals, options, and the JSON flag. */
export interface CommandArgs {
  /**
   * Every token commander did not consume, IN ORDER — which in V3.0 means every flag a verb defines for itself:
   * `cohorte run spec-1 --wait 8 --detach` arrives as `['spec-1', '--wait', '8', '--detach']`. A verb module parses
   * its own flags from here.
   */
  readonly positionals: readonly string[];
  /**
   * In V3.0 this carries ONLY `json`. The registry is frozen (PLAN §3 rule 3) and `cli.ts` registers no option but
   * `--json`, on the verbs that publish a document; with `allowUnknownOption(true)` every other flag is left
   * unparsed in `positionals`. So `args.options.wait` / `args.options.check` are ALWAYS `undefined` — read
   * `positionals`. The map is kept open (rather than typed `{ json?: boolean }`) because a post-3.0 registry
   * amendment that declares a real option is a MINOR, not a breaking change to this contract.
   */
  readonly options: Readonly<Record<string, unknown>>;
  /** Set when the verb has DESIGN §9 sub-verbs (`config get`, `auth login`, ...): the one commander matched. */
  readonly subVerb?: string;
  readonly json: boolean;
}

export interface CommandModule {
  readonly verb: string;
  /**
   * Runs the verb; returns the process exit code (DESIGN 2.8 / 2.3.4). Throwing is equivalent to returning the
   * class exit code of `toErrorInfo(thrown, …)`: `cli.ts` converts every throw at the boundary, so a module is
   * free to throw a `CohorteError`, a `NotImplemented`, or let an unexpected error surface — nothing here writes to
   * `ctx.stdio` on error, `cli.ts` alone owns the spec-21 `cause / impact / run / next action / exit code` format.
   */
  run(ctx: CliContext, args: CommandArgs): Promise<number>;
}

/**
 * The Wave-0 body of every verb (DESIGN §9 "stubbed with a seam" and the plain "not yet built" ones alike): a verb
 * a later wave fills replaces this factory call with a real implementation, never the module's shape.
 *
 * It throws a CLASSIFIED `CohorteError`, not a bare `NotImplemented`: `toErrorInfo` keeps a `CohorteError`'s own
 * code, so the documented `configuration/phase-not-available` (DESIGN §9, exit 10) is what the stub MEANS rather
 * than what `cli.ts`'s unknown-throwable fallback happens to be. `cli.ts`'s fallback is `configuration/unexpected`
 * (DESIGN 2.8 "Unknown throwables -> `<nearest class>/unexpected`"), so a real defect in a filled-in verb can never
 * masquerade as "this phase is not available in this build".
 */
export function notImplementedCommand(verb: string): CommandModule {
  return {
    verb,
    // `ctx`/`args` intentionally unused: the Wave-0 stub never touches a port (DESIGN 1.3).
    async run(_ctx, _args): Promise<number> {
      throw new CohorteError(
        errorOf('configuration/phase-not-available', `the verb \`${verb}\` is not available in this build`),
      );
    },
  };
}
