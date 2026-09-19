// Frozen built-in DATA (DESIGN 2.6.3 step 5, 2.6.4, 2.6.6; PLAN F-8). None of it is overridable: no project config
// and no approval lifts a protected root, a trampoline or the agent git deny set.

const frozen = <const T extends readonly string[]>(values: T): T => Object.freeze(values);

/** Worktree-relative, any depth: `.git` (file OR directory), Cohorte's own directory, Pi's project directory. */
export const PROTECTED_REPO_GLOBS = frozen(['**/.git', '**/.git/**', '**/.cohorte/**', '**/.pi/**']);

/**
 * Relative to the user's HOME; the caller canonicalises them into `PathResolverOptions.protectedRoots`, together with
 * Cohorte's install dir, every pinned runtime artifact and the node binary dir. `~/.cohorte/worktrees` is deliberately
 * ABSENT (DESIGN 5.1): agent worktrees live there.
 */
export const PROTECTED_HOME_PATHS = frozen([
  '.cohorte/keys',
  '.cohorte/versions',
  '.cohorte/pi-agent',
  '.cohorte/brains',
  '.cohorte/trust',
  '.cohorte/config.yaml',
  '.pi/agent',
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.config/gcloud',
]);

/** HOME-relative read denials of every L1 profile (DESIGN 2.6.6); the caller adds the project's state dir. */
export const L1_DENY_READ_HOME_PATHS = frozen([
  '.pi/agent',
  '.cohorte/keys',
  '.cohorte/versions',
  '.cohorte/pi-agent',
  '.cohorte/brains',
  '.cohorte/trust',
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.config/gcloud',
]);

/** The default `denyRead` / `denyWrite` of every AgentGrant (DESIGN 2.6.1). Deny sets always win. */
export const DEFAULT_DENY_GLOBS = frozen([
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.git',
  '**/.git/**',
  '**/.cohorte/**',
  '**/.pi/**',
  '**/.npmrc',
  '**/.netrc',
]);

/**
 * Programs that run OTHER programs or reach the network: denied with `overridable: false` (DESIGN 2.6.4 step 2).
 * `pi` and `cohorte` are in it: Pi has an `auth` subcommand that prints the OAuth token. A project that truly needs one
 * declares an exact-argv rule under `policy.dangerousCommands`, and every use is an `ask`.
 */
export const TRAMPOLINE_PROGRAMS = frozen([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'env',
  'xargs',
  'sudo',
  'su',
  'doas',
  'eval',
  'exec',
  'nohup',
  'time',
  'watch',
  'npx',
  'pnpx',
  'bunx',
  'corepack',
  'ssh',
  'scp',
  'curl',
  'wget',
  'nc',
  'perl',
  'ruby',
  'osascript',
  'pi',
  'cohorte',
]);

/** `python*`: python, python3, python3.12, pythonw ... */
export const TRAMPOLINE_PREFIXES = frozen(['python']);

const TRAMPOLINES: ReadonlySet<string> = new Set(TRAMPOLINE_PROGRAMS);

/** `name` is the alias-normalised BARE program name; the comparison is exact-case (the name was resolved on disk first). */
export function isTrampoline(name: string): boolean {
  return TRAMPOLINES.has(name) || TRAMPOLINE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Agents have no commit capability (D9): commits and merges are Cohorte's. Built-in, non-overridable. */
export const AGENT_GIT_DENIED_SUBCOMMANDS = frozen([
  'commit',
  'push',
  'merge',
  'rebase',
  'reset',
  'checkout',
  'switch',
  'worktree',
  'config',
  'update-ref',
  'filter-branch',
  'gc',
]);

/** The NAMES an L0 child env may carry (DESIGN 2.6.6). Built from scratch, never inherited. */
export const L0_ENV_ALLOWLIST = frozen([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'CI',
  'TMPDIR',
  'NO_COLOR',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
]);

/** The allowlisted names whose VALUE is fixed; PATH (pinned), HOME and TMPDIR (per-agent scratch), LANG and LC_ALL come from the run. */
export const L0_ENV_FIXED: Readonly<Record<string, string>> = Object.freeze({
  TERM: 'dumb',
  CI: '1',
  NO_COLOR: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});

/**
 * What "env contains only the allowlist" means, defined once: visible ⊆ allow ∪ OS_INJECTED_ENV[platform].
 * CoreFoundation injects `__CF_USER_TEXT_ENCODING` into every macOS process (PLAN F-8). Mirrored, value for value, by
 * `@cohorte/runtime-pi/host-protocol`, which may not import this package.
 */
export const OS_INJECTED_ENV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  darwin: Object.freeze(['__CF_USER_TEXT_ENCODING']),
});

/** The env names a child may legitimately SEE on this platform, given what it was allowed. */
export function visibleEnvAllowed(allow: readonly string[], platform: string): ReadonlySet<string> {
  return new Set([...allow, ...(OS_INJECTED_ENV[platform] ?? [])]);
}
