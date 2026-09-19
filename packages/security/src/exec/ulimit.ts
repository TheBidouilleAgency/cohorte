// The ONE shell in the product (DESIGN 2.6.6, I3, ADR-0003). `ULIMIT_WRAPPER_SCRIPT` is a compile-time constant:
// request data is NEVER interpolated into it as text. Every limit value and every real argv element reaches the
// program as a literal POSITIONAL PARAMETER, consumed by `shift` before `exec` replaces the shell's own process
// image — so `; && | $()` and newlines inside an argument are never re-parsed by anything (EV-01..EV-15).
//
// The final `exec` goes through `/usr/bin/env -u PWD -u SHLVL` rather than straight to `"$0" "$@"`: macOS's
// `/bin/sh` (bash) re-exports `PWD` and `SHLVL` into the process environ on every `exec`, `unset` notwithstanding
// (verified on this machine: `unset SHLVL` is undone before the next `exec`) — two names that belong to neither
// `ExecRequest.env` nor `OS_INJECTED_ENV`. `env` is not a shell (no word-splitting, no metacharacter handling: its
// own arguments are plain argv), so this changes nothing about I3; it only strips the two stowaway names before the
// real program's image ever exists. `env`'s own rlimits are inherited unchanged from `sh` (rlimits are a property
// of the process, not reset by `execve`).
//
// The ONE thing `env` does parse is its operands: any operand containing `=` is a variable assignment, and the
// first operand WITHOUT one is the utility to exec. The program path is that operand, so a path containing `=` is
// swallowed as an assignment and `env` execs the NEXT argv element — a model-influenced argument (I3) — as the
// program. `--` does not protect it on either BSD or GNU (assignments are operands, not options), and there is no
// escaping form. `isWrappableProgramPath` therefore REFUSES such a path and the executor fails the run closed (I2)
// rather than run something nobody approved. Arguments are unaffected (`env` stops scanning at the program).
// The refusal costs exactly what it must and no more: the executor reaches for this wrapper only when a request
// actually asks for a rlimit, so a request with empty `limits` spawns the program directly and never meets `env`.
//
// The script FAILS CLOSED. A `ulimit` the kernel refuses (a value above the hard limit, a limit this OS does not
// support) must never let the program start anyway: that would run it with no limit while `SandboxCapabilities`
// still says `cpuTime: 'enforced'` / `processes: 'enforced'` — the "silently skipped" case S-24 forbids. Each
// `ulimit` is therefore guarded by `|| exit <ULIMIT_REFUSED_EXIT>`, and its own diagnostic is sent to `/dev/null`
// rather than to the child's stderr pipe, where it would be counted as the PROGRAM's output (folded into
// `outputSha256`, pushed to the model through `onChunk`, and put at the head of `tail`).
const ULIMIT_REFUSED_EXIT = 126;
const ULIMIT_WRAPPER_SCRIPT =
  `[ -n "$1" ] && { ulimit -t "$1" 2>/dev/null || exit ${ULIMIT_REFUSED_EXIT}; }; ` +
  `[ -n "$2" ] && { ulimit -f "$2" 2>/dev/null || exit ${ULIMIT_REFUSED_EXIT}; }; ` +
  `[ -n "$3" ] && { ulimit -n "$3" 2>/dev/null || exit ${ULIMIT_REFUSED_EXIT}; }; ` +
  `[ -n "$4" ] && { ulimit -u "$4" 2>/dev/null || exit ${ULIMIT_REFUSED_EXIT}; }; ` +
  'shift 4; exec /usr/bin/env -u PWD -u SHLVL "$0" "$@"';

/**
 * How the wrapper reports "the kernel refused a limit you asked for". The executor maps it to `outcome: 'error'`
 * when it comes with NO output at all — the shell's own `exec` failure (program not executable, ENOENT) uses the
 * same code but writes a diagnostic to stderr first, and a program is free to exit 126 by itself.
 */
export const ULIMIT_REFUSED_EXIT_CODE = ULIMIT_REFUSED_EXIT;

/** Absolute, not resolved through PATH: the wrapper never depends on what an agent-controlled PATH would find. */
export const ULIMIT_SHELL = '/bin/sh';

/**
 * Can the wrapper carry this program at all? `false` for a path `/usr/bin/env` would read as a variable assignment
 * (see the header): the executor turns that into `outcome: 'error'` and nothing is spawned. The check is on the
 * path the wrapper's `env` actually receives as its first operand — that is `SandboxBackend.wrap()`'s output, not
 * necessarily `ExecRequest.file`: when a backend prepends its own helper, the original program has become an
 * ARGUMENT of that helper, which `env` never inspects.
 */
export function isWrappableProgramPath(file: string): boolean {
  return !file.includes('=');
}

/** Why a run was refused before any spawn, in the words the result carries in `guarantees.notes`. */
export function unwrappableProgramNote(file: string): string {
  return (
    `exec: refused to run '${file}' under the requested rlimits: a program path containing '=' cannot be carried ` +
    `through the rlimit wrapper — '/usr/bin/env' would read it as a variable assignment and exec the next argument ` +
    'instead. Nothing was spawned. (The same program runs when no rlimit is requested: there is no wrapper then.)'
  );
}

export interface UlimitLimits {
  cpuSeconds?: number;
  fileSizeBytes?: number;
  openFiles?: number;
  processes?: number;
}

export interface WrappedCommand {
  file: string;
  args: string[];
}

const toIntArg = (value: number | undefined): string =>
  value === undefined ? '' : String(Math.max(0, Math.trunc(value)));

/**
 * `ulimit -f` uses 1 KiB blocks on macOS and 512-byte blocks on Linux (the POSIX shells expose different units).
 * At least one block once a POSITIVE byte limit was asked for —
 * but `fileSizeBytes: 0` is a request in its own right ("this command may create no file at all"), and rounding it
 * up to one block would hand the caller 1024 writable bytes while `guarantees` still claims the limit applied.
 */
const toBlockArg = (bytes: number | undefined): string => {
  if (bytes === undefined) return '';
  if (bytes <= 0) return '0';
  const blockSize = process.platform === 'linux' ? 512 : 1024;
  return String(Math.max(1, Math.ceil(bytes / blockSize)));
};

/**
 * Wraps `file`/`args` so the process starts under `ulimit -t/-f/-n/-u` before `exec` hands control to it. `limits`
 * become POSITIONAL ARGUMENTS of the constant script (never text baked into it); an omitted limit is passed as an
 * empty string and the script's own `[ -n "$k" ]` guard skips it. A limit that IS asked for and that the kernel
 * refuses aborts with `ULIMIT_REFUSED_EXIT_CODE` instead of running unlimited. `ulimit -v` (address space) is not
 * attempted: toolchain.md §8 measured it failing outright on macOS ("cannot modify limit: Invalid argument"), so
 * `memoryBytes` is not enforced by this wrapper on any platform (SandboxCapabilities.memory stays `unavailable`).
 */
export function requestsAnyRlimit(limits: UlimitLimits): boolean {
  return (
    limits.cpuSeconds !== undefined ||
    limits.fileSizeBytes !== undefined ||
    limits.openFiles !== undefined ||
    limits.processes !== undefined
  );
}

export function wrapWithUlimit(file: string, args: readonly string[], limits: UlimitLimits): WrappedCommand {
  return {
    file: ULIMIT_SHELL,
    args: [
      '-c',
      ULIMIT_WRAPPER_SCRIPT,
      file,
      toIntArg(limits.cpuSeconds),
      toBlockArg(limits.fileSizeBytes),
      toIntArg(limits.openFiles),
      toIntArg(limits.processes),
      ...args,
    ],
  };
}
