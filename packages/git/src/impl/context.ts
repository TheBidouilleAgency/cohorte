import type { CanonicalPath, GitIdentity } from '../contract.ts';

/**
 * Constructs a `GitPort` (`createGitPort`). Unit-owned (PLAN U1.05): `packages/git/src/impl/**` is not the frozen
 * contract, so this shape may grow across the wave without touching `GitPort` itself.
 */
export interface GitPortOptions {
  /** the absolute, pinned path of the `git` binary; never resolved through an ambient PATH at call time */
  gitBinary: string;
  /** the PATH handed to git (for its own helpers); pinned at run start */
  path: string;
  timeoutMs?: number;
  /**
   * Identity for the commits `GitPort` authors itself: merge commits (`commitTree`). DESIGN 5 gives `commitTree`
   * no per-call identity — a merge is Cohorte's own act, never an agent's — while `commitAll` takes one explicitly
   * per call (`GitIdentity`). The hardened environment (5.0) never reads an ambient identity, so one must be
   * supplied here or `commit-tree` fails with "empty ident name".
   */
  mergeIdentity: GitIdentity;
  /**
   * `git.worktreeRoot` as resolved by the configuration (DESIGN 5.1, ADR-0021 §1): the ONE directory under which
   * every Cohorte worktree of every run of this project lives. `resetHardClean` — the only destructive method of
   * this port — refuses any target that does not canonicalise under it, so a repository Cohorte never provisioned
   * can never be hard-reset and cleaned. Required, not optional: a `GitPort` built without it would have no root
   * to refuse against, which is exactly the hole the guard exists to close.
   */
  worktreeRoot: CanonicalPath;
}
