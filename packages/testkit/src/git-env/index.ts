import { join } from 'node:path';

/**
 * The hermetic git variables: toolchain.md §4 plus GIT_OPTIONAL_LOCKS=0 (PLAN U0.02). Global and system config are
 * never read, git never prompts, messages are in the C locale (tests match on them), and the identity is fixed.
 * GIT_OPTIONAL_LOCKS=0 keeps a `git status` from taking index.lock behind the back of a concurrent writer.
 */
export const GIT_ENV_VARS: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});

export interface GitEnvOptions {
  /** A throwaway HOME: HOME and every XDG base directory are redirected below it. */
  home?: string;
  /** The environment to start from. Default: `process.env`. */
  base?: NodeJS.ProcessEnv;
  /** Applied last, so it may override anything (a fixed GIT_AUTHOR_DATE for a golden commit id, for instance). */
  extra?: Readonly<Record<string, string>>;
}

/**
 * A fresh environment for a child process that runs git (or anything that runs git).
 *
 * Every inherited `GIT_*` variable is dropped first. When a test run is started from a git hook, git exports
 * GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE: left in place, they point every `git` of every test at the
 * developer's real repository instead of the temp one.
 */
export function gitEnv(options: GitEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(options.base ?? process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  if (options.home !== undefined) {
    env.HOME = options.home;
    env.XDG_CONFIG_HOME = join(options.home, '.config');
    env.XDG_CACHE_HOME = join(options.home, '.cache');
    env.XDG_DATA_HOME = join(options.home, '.local', 'share');
    env.XDG_STATE_HOME = join(options.home, '.local', 'state');
  }
  return { ...env, ...GIT_ENV_VARS, ...options.extra };
}

/**
 * `gitEnv()` taken once, for a one-off `execFile('git', args, { env: GIT_ENV })`. It keeps the real HOME: anything
 * that could touch `~/.cohorte`, `~/.pi` or a user-level git ignore file takes `gitEnv({ home })` with a throwaway
 * HOME instead, which is what the `tempRepo` fixture does.
 */
export const GIT_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze(gitEnv());
