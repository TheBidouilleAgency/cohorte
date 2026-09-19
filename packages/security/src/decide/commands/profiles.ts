// ProgramProfiles for git, pnpm, npm, yarn, node, docker (DESIGN 2.6.4, ADR-0024 item 4).
//
// A profile parses argv[1..] into { globals, subcommand, flags, positionals } (`ParsedCommand`), or returns a
// `CommandDenial` when a GLOBAL option would re-target the command onto a directory or repository the agent does not
// own (`git -C`, `node --require`, ...). Everything else that looks like a flag before the first non-flag token is a
// benign global (`git --no-pager push` still parses `push` as the subcommand: DESIGN 7.4 EV-08/09).
//
// Deviation (recorded, not a defect in a dependency): DESIGN's interface comment for `ProgramProfile.parse` is the
// fullest listing of the re-targeting option sets (git: -C/-c/--git-dir/--work-tree/--exec-path/--namespace; pnpm:
// -C/--dir/--prefix; npm: --prefix; node: -e/-p/-r/--require/--import/--loader/--eval); the unit pack's prose
// summary drops a few of these in its compression. This file follows the fuller DESIGN interface comment, which is
// normative for behaviour (RULES pack §0). That per-program listing is ILLUSTRATIVE, not closed: the normative
// sentence is "Returns a denial for any global option that re-targets the command", so `yarn --cwd` and
// `docker -H/--host/--context/--config` are denied too — they are the EV-08/09 mechanism `git -C` is denied for.
//
// Deviation: DESIGN's `ParsedCommand` splits the LEADING run of option tokens into `globals`; npm, pnpm, yarn and
// docker all accept their config options AFTER the subcommand as well (`pnpm install --dir=/elsewhere`), so a
// re-targeting option is rejected wherever it appears in argv, not only while it leads.

import type { CommandDenial, ParsedCommand, ProgramProfile } from '../../contract/index.ts';

/** True for a token that starts a run of leading options, e.g. `-C`, `--dir=x`, `-e"code"`. */
const isFlagToken = (token: string): boolean => token.startsWith('-') && token !== '-';

/** True when `token` invokes `flag`, whether joined by `=` (long options) or directly attached (short options). */
function matchesFlag(token: string, flag: string): boolean {
  if (token === flag) return true;
  if (flag.startsWith('--')) return token.startsWith(`${flag}=`);
  return flag.length === 2 && token.length > flag.length && token.startsWith(flag);
}

export interface ProfileSpec {
  program: string;
  aliases: readonly string[];
  /** global options that re-target the command; matched against every leading flag token (DESIGN 2.6.4 step 1-4). */
  retargeting: readonly string[];
}

/**
 * One shared structural parser for every built-in profile: walk leading flag tokens (denying a re-targeting one on
 * sight), the first non-flag token is the subcommand, everything after it splits into `flags` / `positionals` by
 * whether it starts with `-`. This is a STRUCTURAL split, not a full CLI grammar: it does not know which flags of
 * `git commit -m <msg>` consume a value, because the callers that need that (CommandRule matching) work in terms of
 * flag NAMES and positional VALUES declared by policy data, never by re-deriving one CLI's full option grammar here.
 */
function createProfile(spec: ProfileSpec): ProgramProfile {
  return {
    program: spec.program,
    aliases: spec.aliases,
    parse(args: readonly string[]): ParsedCommand | CommandDenial {
      const retargeted = (token: string): CommandDenial | undefined => {
        const denied = spec.retargeting.find((flag) => matchesFlag(token, flag));
        if (denied === undefined) return undefined;
        return {
          kind: 'denied',
          code: 'security/command-global-option',
          token,
          reason: `${spec.program}: \`${denied}\` re-targets the command onto a different directory or repository`,
        };
      };

      const globals: string[] = [];
      let index = 0;
      while (index < args.length) {
        const token = args[index];
        if (token === undefined || !isFlagToken(token)) break;
        const denial = retargeted(token);
        if (denial !== undefined) return denial;
        globals.push(token);
        index += 1;
      }
      const subcommandToken = args[index];
      const subcommand = subcommandToken === undefined ? [] : [subcommandToken];
      const rest = subcommandToken === undefined ? [] : args.slice(index + 1);
      const flags: string[] = [];
      const positionals: string[] = [];
      for (const token of rest) (isFlagToken(token) ? flags : positionals).push(token);
      // A re-targeting option placed after the subcommand re-targets just as well: `pnpm install --dir=/elsewhere`.
      for (const token of flags) {
        const denial = retargeted(token);
        if (denial !== undefined) return denial;
      }
      return { kind: 'parsed', globals, subcommand, flags, positionals };
    },
  };
}

// The sets include the exact functional SYNONYMS of the options DESIGN 2.6.4 names — `--config-env` is `-c` read
// from the environment, `--experimental-loader` is Node's own documented alias of `--loader` — and the remaining
// value-taking git globals (`--super-prefix`, `--attr-source`), which would otherwise parse as benign globals and
// shift the subcommand out from under the D9 check. DESIGN's per-program listing is illustrative, not closed
// (request R3); the normative sentence is "a denial for ANY global option that re-targets the command".
const GIT_RETARGETING = [
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--namespace',
  '--super-prefix',
  '--attr-source',
];
const PNPM_RETARGETING = ['-C', '--dir', '--prefix'];
const NPM_RETARGETING = ['--prefix'];
const NODE_RETARGETING = [
  '-e',
  '-p',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--eval',
  '--env-file',
  '--env-file-if-exists',
];
/** `yarn --cwd <dir>` runs the whole command in another directory: `git -C` under another name. */
const YARN_RETARGETING = ['--cwd'];
/** `docker -H`/`--host`/`--context` re-target the DAEMON (a remote one included); `--config` the credential store. */
const DOCKER_RETARGETING = ['-H', '--host', '--context', '--config'];

export const GIT_PROFILE: ProgramProfile = createProfile({ program: 'git', aliases: [], retargeting: GIT_RETARGETING });
export const PNPM_PROFILE: ProgramProfile = createProfile({
  program: 'pnpm',
  aliases: [],
  retargeting: PNPM_RETARGETING,
});
export const NPM_PROFILE: ProgramProfile = createProfile({ program: 'npm', aliases: [], retargeting: NPM_RETARGETING });
export const YARN_PROFILE: ProgramProfile = createProfile({
  program: 'yarn',
  aliases: [],
  retargeting: YARN_RETARGETING,
});
export const NODE_PROFILE: ProgramProfile = createProfile({
  program: 'node',
  aliases: [],
  retargeting: NODE_RETARGETING,
});
/** `docker-compose up` normalises to `docker compose up`: EV-10. */
export const DOCKER_PROFILE: ProgramProfile = createProfile({
  program: 'docker',
  aliases: ['docker-compose'],
  retargeting: DOCKER_RETARGETING,
});

export const BUILTIN_PROFILES: readonly ProgramProfile[] = Object.freeze([
  GIT_PROFILE,
  PNPM_PROFILE,
  NPM_PROFILE,
  YARN_PROFILE,
  NODE_PROFILE,
  DOCKER_PROFILE,
]);

/**
 * Subcommand tokens an alias implies, prepended to argv[1..] before the matched profile parses it: `docker-compose`
 * behaves as `docker compose`. No other built-in alias carries an implied subcommand.
 */
const ALIAS_SUBCOMMAND_PREFIX: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'docker-compose': Object.freeze(['compose']),
});

export interface ProfileMatch {
  profile: ProgramProfile;
  /** subcommand tokens the alias implies, to prepend to argv[1..] before calling `profile.parse`. */
  prefix: readonly string[];
}

/** `bareName` is argv[0] as typed (already checked to be a bare name with no path separator). */
export function findProfile(bareName: string, profiles: readonly ProgramProfile[]): ProfileMatch | undefined {
  for (const profile of profiles) {
    if (profile.program === bareName) return { profile, prefix: [] };
    if (profile.aliases.includes(bareName)) return { profile, prefix: ALIAS_SUBCOMMAND_PREFIX[bareName] ?? [] };
  }
  return undefined;
}

/** The CANONICAL program name of `bareName` for trampoline / rule-matching purposes: `docker-compose` -> `docker`. */
export function canonicalProgramName(bareName: string, profiles: readonly ProgramProfile[]): string {
  return findProfile(bareName, profiles)?.profile.program ?? bareName;
}
