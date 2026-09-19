// DESIGN 5 (GitPort). EVERY method funnels through `runGit` (`./runner.ts`), the hardened invocation of 5.0.
import type { GitPort } from '../contract.ts';
import { commitAll, findCommitByTrailer } from './commits.ts';
import type { GitPortOptions } from './context.ts';
import { facts } from './facts.ts';
import { commitTree, createRef, mergeTree, updateRefCas } from './merge.ts';
import { changedPaths, diffBySurface } from './status.ts';
import { treeDigest } from './tree-digest.ts';
import { addWorktree, removeWorktree, resetHardClean, switchToNewBranch } from './worktrees.ts';

export type { GitPortOptions } from './context.ts';
export { GitCommandError } from './runner.ts';
export { WorktreeDirtyError } from './worktrees.ts';

export function createGitPort(options: GitPortOptions): GitPort {
  return {
    facts: (repo) => facts(repo, options),
    treeDigest: (worktree, opts) => treeDigest(worktree, opts, options),
    addWorktree: (req) => addWorktree(req, options),
    switchToNewBranch: (req) => switchToNewBranch(req, options),
    removeWorktree: (path, opts) => removeWorktree(path, opts, options),
    resetHardClean: (worktree, to) => resetHardClean(worktree, to, options),
    commitAll: (req) => commitAll(req, options),
    findCommitByTrailer: (repo, branch, key, value) => findCommitByTrailer(repo, branch, key, value, options),
    mergeTree: (repo, ours, theirs) => mergeTree(repo, ours, theirs, options),
    commitTree: (repo, tree, parents, message, trailers) => commitTree(repo, tree, parents, message, trailers, options),
    updateRefCas: (repo, ref, next, expectedOld) => updateRefCas(repo, ref, next, expectedOld, options),
    createRef: (repo, ref, sha) => createRef(repo, ref, sha, options),
    diffBySurface: (req) => diffBySurface(req, options),
    changedPaths: (worktree) => changedPaths(worktree, options),
  };
}
