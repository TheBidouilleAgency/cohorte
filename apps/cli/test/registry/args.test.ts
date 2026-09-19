// apps/cli/test/registry/args.test.ts — what `cli.ts` actually hands a `CommandModule`, pinned against the
// `CommandArgs` contract (`apps/cli/src/contract/command-module.ts`).
//
// The invariant a Wave-4/5 unit needs to know before it writes a line: the verb registry is frozen (PLAN §3 rule 3)
// and `cli.ts` registers NO option but `--json`, so with `allowUnknownOption(true)` every other flag of every verb
// arrives UNPARSED in `positionals` and `options` carries `json` alone. A unit that reaches for `args.options.wait`
// or `args.options.check` would silently read `undefined` — no usage error, no type error. This file is the thing
// that says so out loud.
//
// The two verb modules are mocked (they are Wave-0 stubs that throw): `lazy.ts` loads them with a literal relative
// specifier, so a mock registered here is what `loadCommandModule` resolves. The mock is scoped to this file, which
// is why the pin lives beside `verbs.test.ts` rather than inside it — there, `run` and `config` must stay the real
// stubs for the not-available-error cases.
import { describe, expect, test, vi } from 'vitest';
import { runCli } from '../../src/cli.ts';
import type { CommandArgs, CommandModule } from '../../src/contract/index.ts';
import { testDeps } from './helpers.ts';

const { seen } = vi.hoisted(() => ({ seen: [] as CommandArgs[] }));

function recordingModule(verb: string): { default: CommandModule } {
  return {
    default: {
      verb,
      run: async (_ctx, args): Promise<number> => {
        seen.push(args);
        return 0;
      },
    },
  };
}

vi.mock('../../src/commands/run/index.ts', () => recordingModule('run'));
vi.mock('../../src/commands/config/index.ts', () => recordingModule('config'));

/** Runs one command line and returns the single `CommandArgs` the module received. */
async function argsOf(argv: readonly string[]): Promise<CommandArgs> {
  seen.length = 0;
  const code = await runCli(argv, testDeps());
  expect(code, `\`cohorte ${argv.join(' ')}\` should have reached its command module`).toBe(0);
  expect(seen.length, 'the command module ran exactly once').toBe(1);
  const args = seen[0];
  if (!args) throw new Error('unreachable: seen.length was asserted to be 1');
  return args;
}

describe('CommandArgs', () => {
  test('a verb-specific flag is NOT parsed: it lands in positionals, and options carries json alone', async () => {
    const args = await argsOf(['run', 'spec-1', '--wait', '8', '--detach', '--json']);
    expect(args.positionals).toEqual(['spec-1', '--wait', '8', '--detach']);
    expect(args.options).toEqual({ json: true });
    expect(args.json).toBe(true);
    expect(args.subVerb).toBeUndefined();
  });

  test('without --json, options is empty — `args.options.<anything>` is always undefined', async () => {
    const args = await argsOf(['run', '--wait', '8']);
    expect(args.positionals).toEqual(['--wait', '8']);
    expect(args.options).toEqual({});
    expect(Object.keys(args.options)).toEqual([]);
    expect(args.json).toBe(false);
  });

  test('a sub-verb is reported in subVerb and removed from positionals (DESIGN §9 `config get <key>`)', async () => {
    const args = await argsOf(['config', 'get', 'runtime.name']);
    expect(args.subVerb).toBe('get');
    expect(args.positionals).toEqual(['runtime.name']);
  });

  test('a bare verb with sub-verbs reaches the same module with no subVerb', async () => {
    const args = await argsOf(['config']);
    expect(args.subVerb).toBeUndefined();
    expect(args.positionals).toEqual([]);
  });
});
