// Hardened runner (DESIGN 5.0): EVERY Cohorte-run git invocation goes through here. `execFile` only, never a
// shell; hooks, fsmonitor, ssh and gpg-signing are disabled by CONFIG FLAG on every call (repository config can
// never win: command-line -c always outranks it), and the environment is built from scratch — never inherited
// from `process.env` — so nothing ambient (a token, a stray GIT_* var) ever reaches a git child process.
import { type ExecFileException, execFile } from 'node:child_process';
import { GIT_HARDENED_CONFIG_ARGS, GIT_HARDENED_ENV } from '../contract.ts';

export interface GitIdentityEnv {
  name: string;
  email: string;
}

export interface RunGitOptions {
  /** absolute, pinned; never resolved through an ambient PATH at call time */
  gitBinary: string;
  /** the PATH handed to git for its own helpers; pinned at run start */
  path: string;
  cwd: string;
  args: readonly string[];
  // `| undefined` (not just `?`) so callers may forward `GitPortOptions.timeoutMs` verbatim under exactOptionalPropertyTypes.
  timeoutMs?: number | undefined;
  /** merged on top of {@link GIT_HARDENED_ENV} + PATH; used for GIT_INDEX_FILE (tree digest) */
  extraEnv?: Readonly<Record<string, string>>;
  /** sets the GIT_AUTHOR_ and GIT_COMMITTER_ variables explicitly (5.0: identity is never read from ambient config) */
  identity?: GitIdentityEnv;
  /** piped to stdin, then closed; stdin is always closed, so a command that unexpectedly waits on it fails fast */
  input?: string;
  /** default 16 MiB, mirrors the testkit temp-repo fixture */
  maxBuffer?: number;
  /** return stdout as raw bytes too (`stdoutBytes`): a diff/patch is not guaranteed to be valid UTF-8 */
  binary?: boolean;
  /** exit codes besides 0 that resolve instead of rejecting (`merge-tree --write-tree`'s 1 = conflict) */
  allowExitCodes?: readonly number[];
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  stdoutBytes?: Uint8Array;
  exitCode: number;
}

/** A hardened git invocation that exited with a code {@link RunGitOptions.allowExitCodes} did not allow, or was killed. */
export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, signal: string | null, stdout: string, stderr: string) {
    const outcome = signal ? `killed by ${signal}` : `exited ${exitCode ?? '(unknown)'}`;
    super(`git ${args.join(' ')} ${outcome}: ${stderr.trim() || stdout.trim() || '(no output)'}`);
    this.name = 'GitCommandError';
    this.args = args;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function buildEnv(options: RunGitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...GIT_HARDENED_ENV, PATH: options.path };
  if (options.identity) {
    env.GIT_AUTHOR_NAME = options.identity.name;
    env.GIT_AUTHOR_EMAIL = options.identity.email;
    env.GIT_COMMITTER_NAME = options.identity.name;
    env.GIT_COMMITTER_EMAIL = options.identity.email;
  }
  if (options.extraEnv) Object.assign(env, options.extraEnv);
  return env;
}

/**
 * Runs one hardened git invocation: {@link GIT_HARDENED_CONFIG_ARGS} always precede `options.args`. Rejects with
 * {@link GitCommandError} unless the exit code is 0 or listed in `allowExitCodes`; a signal always rejects.
 */
export function runGit(options: RunGitOptions): Promise<RunGitResult> {
  const args = [...GIT_HARDENED_CONFIG_ARGS, ...options.args];
  const env = buildEnv(options);
  const allowed = new Set<number>([0, ...(options.allowExitCodes ?? [])]);
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      options.gitBinary,
      args,
      {
        cwd: options.cwd,
        env,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: 'buffer',
        windowsHide: true,
      },
      (error: ExecFileException | null, stdoutBuf, stderrBuf) => {
        const stdout = stdoutBuf.toString('utf8');
        const stderr = stderrBuf.toString('utf8');
        const numericExitCode = typeof error?.code === 'number' ? error.code : null;
        const signal = error?.signal ?? null;
        const exitCode = numericExitCode ?? (error ? -1 : 0);
        if (error && (signal !== null || !allowed.has(exitCode))) {
          reject(new GitCommandError(args, numericExitCode, signal, stdout, stderr));
          return;
        }
        resolvePromise({
          stdout,
          stderr,
          exitCode,
          ...(options.binary ? { stdoutBytes: new Uint8Array(stdoutBuf) } : {}),
        });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input, 'utf8');
    else child.stdin?.end();
  });
}
