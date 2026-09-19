// GitPort (DESIGN 5) and the hardened-runner constants (DESIGN 5.0). This package depends on `base` only, so the
// two types DESIGN borrows from its neighbours are declared here, structurally identical to the originals:
// `CanonicalPath` (= @cohorte/security/contract) and `FileTouch` (= @cohorte/protocol). Same brand, same fields:
// a value of one is a value of the other, and `core` hands them across without a cast.
import type { Brand, Sha256, SurfaceId } from '@cohorte/base';

/** absolute, realpath'd, NFC, no trailing slash, on-disk case */
export type CanonicalPath = Brand<string, 'CanonicalPath'>;

export interface FileTouch {
  /** worktree-relative, POSIX */
  path: string;
  op: 'read' | 'create' | 'modify' | 'delete';
  beforeSha256?: Sha256;
  afterSha256?: Sha256;
  bytes?: number;
}

/** `merge-tree --write-tree` needs git >= 2.38 */
export const MIN_GIT_VERSION = '2.38.0';

export interface RepoFacts {
  /** e.g. '2.50.1' */
  gitVersion: string;
  /** false below {@link MIN_GIT_VERSION} */
  supported: boolean;
  /** the COMMON git dir: every worktree of one repository reports the same one */
  commonDir: CanonicalPath;
  defaultBranch: string | null;
  head: { kind: 'branch'; name: string; sha: string } | { kind: 'detached'; sha: string } | { kind: 'unborn' };
  worktrees: { path: CanonicalPath; branch: string | null; head: string | null; locked: boolean }[];
}

/** Explicit on every commit: the ambient git config is never read (5.0). */
export interface GitIdentity {
  name: string;
  email: string;
  /** `git.commitIdentity: user` => the user's identity + this trailer value, e.g. 'Cohorte <cohorte@localhost>' */
  coAuthoredBy?: string;
}

/**
 * Path -> surface, decided by the CALLER (`core`, through `security`'s GlobMatcher): this package never evaluates
 * a glob. `'shared'` also covers a path no surface owns.
 */
export interface SurfaceMap {
  surfaceOf(worktreeRelativePosixPath: string): SurfaceId | 'shared';
}

/** Bytes for the caller to store as an artifact: this package writes no state. */
export interface ArtifactDraft {
  kind: 'diff';
  mediaType: 'text/x-diff';
  bytes: Uint8Array;
}

/** DESIGN 5, verbatim. execFile `git`, never a shell. */
export interface GitPort {
  /** version (>= 2.38 for merge-tree --write-tree), default branch, HEAD kind, worktrees */
  facts(repo: CanonicalPath): Promise<RepoFacts>;
  treeDigest(worktree: CanonicalPath, opts: { exclude: string[] }): Promise<string>;
  addWorktree(req: { repo: CanonicalPath; path: CanonicalPath; branch: string | null; commit: string }): Promise<void>;
  /** slot reuse: new agent branch at the integration head */
  switchToNewBranch(req: { worktree: CanonicalPath; branch: string; at: string }): Promise<void>;
  removeWorktree(path: CanonicalPath, opts: { force: false }): Promise<'removed' | 'dirty-kept'>;
  /** quarantine path only; refuses any path outside the worktree root */
  resetHardClean(worktree: CanonicalPath, to: string): Promise<void>;
  commitAll(req: {
    worktree: CanonicalPath;
    message: string;
    trailers: Record<string, string>;
    identity: GitIdentity;
    paths: string[];
  }): Promise<{ sha: string; treeDigest: string } | { kind: 'nothing' }>;
  findCommitByTrailer(repo: CanonicalPath, branch: string, key: string, value: string): Promise<string | null>;
  /** git merge-tree --write-tree: no working tree involved */
  mergeTree(
    repo: CanonicalPath,
    ours: string,
    theirs: string,
  ): Promise<{ clean: true; tree: string } | { clean: false; files: string[] }>;
  commitTree(
    repo: CanonicalPath,
    tree: string,
    parents: string[],
    message: string,
    trailers: Record<string, string>,
  ): Promise<string>;
  /** atomic compare-and-swap */
  updateRefCas(repo: CanonicalPath, ref: string, next: string, expectedOld: string | null): Promise<'ok' | 'moved'>;
  /** refs/cohorte/<runId>/review/<n> — never updated during the run */
  createRef(repo: CanonicalPath, ref: string, sha: string): Promise<void>;
  diffBySurface(req: {
    repo: CanonicalPath;
    base: string;
    head: string;
    surfaces: SurfaceMap;
  }): Promise<{ surface: SurfaceId | 'shared'; files: string[]; patch: ArtifactDraft }[]>;
  /** status --porcelain=v2 -z, exact parsing */
  changedPaths(worktree: CanonicalPath): Promise<FileTouch[]>;
}

const frozen = <const T extends readonly string[]>(values: T): T => Object.freeze(values);

/**
 * 5.0 — mandatory on EVERY Cohorte-run git invocation, before the subcommand. Hooks and config are
 * repository-controlled code, and Cohorte's own git runs in the run host, outside the gate and the sandbox.
 */
export const GIT_HARDENED_CONFIG_ARGS = frozen([
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.sshCommand=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.pager=cat',
]);

/** 5.0 — the COMPLETE git-specific env; the runner adds a pinned PATH and nothing from `process.env`. */
export const GIT_HARDENED_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
});

/** wherever output is parsed */
export const GIT_PORCELAIN_ARGS = frozen(['--porcelain=v2', '-z']);
/** on every diff */
export const GIT_DIFF_HARDENING_ARGS = frozen(['--no-ext-diff', '--no-textconv']);
