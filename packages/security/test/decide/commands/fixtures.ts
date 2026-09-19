// Shared builders for the U1.03 command-policy tests. Not collected as a test (no `.test.ts` suffix).
import type { CommandRule } from '@cohorte/config/schema';
import { Compile } from 'typebox/compile';
import { expect } from 'vitest';
import type {
  BranchResolver,
  CanonicalPath,
  CommandPolicy,
  CommandRequest,
  ProgramResolver,
} from '../../../src/contract/index.ts';
import type { CommandContext, CommandEvaluation } from '../../../src/decide/commands/index.ts';
import { CommandEvaluationSchema } from '../../../src/decide/commands/index.ts';

export const canonical = (path: string): CanonicalPath => path as CanonicalPath;

/** Compiled once for the whole unit: plan.json's fourth test ("every returned verdict fragment is schema-valid",
 * DESIGN 7.4's replacement for the dropped G1-G9 "every verdict of every table row") only holds if the two suites
 * that produce the interesting verdicts assert it on EVERY row, not just a hand-picked sample. Both call this from
 * their own evaluation helpers. */
const schema = Compile(CommandEvaluationSchema);

export function assertSchemaValid(evaluation: CommandEvaluation): CommandEvaluation {
  expect([...schema.Errors(evaluation)].map((error) => error.instancePath)).toEqual([]);
  return evaluation;
}

export const WORKTREE = canonical('/w/run_1/frontend');
export const MAIN_CHECKOUT = canonical('/repo/main');
export const OTHER_WORKTREE = canonical('/w/run_1/backend');

type BranchInfo = ReturnType<BranchResolver['branchOf']>;
export const UNPROTECTED_BRANCH: BranchInfo = { kind: 'branch', name: 'feature/x', protected: false };
export const PROTECTED_BRANCH: BranchInfo = { kind: 'branch', name: 'main', protected: true };
export const DETACHED: BranchInfo = { kind: 'detached-or-unknown', protected: true };

/** Resolves each name in `map` to a fixed realpath; every other name is "not on the pinned PATH". */
export function fakeResolver(map: Record<string, string>): ProgramResolver {
  return { resolve: (bareName) => (bareName in map ? canonical(map[bareName] as string) : undefined) };
}

/** Looks up `branchOf(cwd)` by exact CanonicalPath; anything unlisted is detached/unknown (protected). */
export function fakeBranches(map: Partial<Record<string, BranchInfo>>): BranchResolver {
  return { branchOf: (cwd) => map[cwd] ?? DETACHED };
}

export function baseContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    worktree: WORKTREE,
    cwd: WORKTREE,
    role: 'implementer',
    phase: 'BUILD',
    sandboxLevel: 'L0-process',
    defaultTimeoutMs: 600_000,
    ...overrides,
  };
}

export function commandPolicy(rules: CommandRule[]): CommandPolicy {
  return { default: 'deny', rules };
}

/** `cwd` here is `CommandRequest.cwd`: the RAW, worktree-relative field the model sent, never read by the
 * evaluator (it reads `CommandContext.cwd`, already resolved by stage 3) — populated only for realism. */
export function commandRequest(
  argv: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): CommandRequest {
  return {
    argv,
    cwd: options.cwd ?? '.',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

export function rule(input: {
  id: string;
  program: string;
  subcommand?: readonly string[];
  flags?: CommandRule['flags'];
  positionals?: CommandRule['positionals'];
  decision: CommandRule['decision'];
  when?: CommandRule['when'];
  replay?: CommandRule['replay'];
  network?: boolean;
  origin?: CommandRule['origin'];
}): CommandRule {
  const { id, program, subcommand, flags, positionals, decision, when, replay, network, origin } = input;
  return {
    id,
    program,
    decision,
    replay: replay ?? 'at-most-once',
    network: network ?? false,
    origin: origin ?? 'project-config',
    ...(subcommand === undefined ? {} : { subcommand }),
    ...(flags === undefined ? {} : { flags }),
    ...(positionals === undefined ? {} : { positionals }),
    ...(when === undefined ? {} : { when }),
  };
}

/** The default resolver used by most tests: every one of git/pnpm/npm/yarn/node/docker(-compose)/sh/npx resolves
 * to a fixed, distinct realpath, as if found on the pinned PATH. */
export const STANDARD_RESOLVER = fakeResolver({
  git: '/usr/bin/git',
  pnpm: '/opt/homebrew/bin/pnpm',
  npm: '/usr/local/bin/npm',
  yarn: '/usr/local/bin/yarn',
  node: '/usr/local/bin/node',
  docker: '/usr/local/bin/docker',
  'docker-compose': '/usr/local/bin/docker-compose',
  sh: '/bin/sh',
  npx: '/usr/local/bin/npx',
  base64: '/usr/bin/base64',
  echo: '/bin/echo',
});
