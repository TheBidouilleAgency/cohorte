// Command policy: a parsed-argv allowlist, not a matcher (DESIGN 2.6.4, ADR-0024).
import type { CommandRule } from '@cohorte/config/schema';
import type { CanonicalPath } from './paths.ts';

export type { CommandRule } from '@cohorte/config/schema';

/** NO string form exists (I3). `cwd` is worktree-relative and validated by stage 3. */
export interface CommandRequest {
  argv: readonly string[];
  cwd: string;
  timeoutMs?: number;
}

/** What a profile's `parse` yields: argv[1..] read STRUCTURALLY. */
export interface ParsedCommand {
  kind: 'parsed';
  /** global options that do not re-target the command (the re-targeting ones are a {@link CommandDenial}) */
  globals: readonly string[];
  subcommand: readonly string[];
  flags: readonly string[];
  positionals: readonly string[];
}

export interface CommandDenial {
  kind: 'denied';
  /** the error code of the verdict, e.g. 'security/command-global-option' */
  code: string;
  /** the offending token */
  token: string;
  reason: string;
}

export interface ProgramProfile {
  /** canonical name: 'git' | 'pnpm' | 'npm' | 'yarn' | 'node' | 'docker' */
  program: string;
  /** 'docker-compose' => docker + ['compose'] */
  aliases: readonly string[];
  /**
   * Parses argv[1..] into { globals, subcommand[], flags, positionals }. Returns a denial for any global option that
   * re-targets the command: git -C/-c/--git-dir/--work-tree/--exec-path/--namespace · pnpm -C/--dir/--prefix ·
   * npm --prefix · node -e/-p/-r/--require/--import/--loader/--eval.
   */
  parse(args: readonly string[]): ParsedCommand | CommandDenial;
}

export interface CommandPolicy {
  default: 'deny';
  rules: CommandRule[];
}

/** through the PATH pinned at run start (recorded in the snapshot), then realpath */
export interface ProgramResolver {
  resolve(bareName: string): CanonicalPath | undefined;
}
