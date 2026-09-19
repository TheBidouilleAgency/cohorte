// Shared by the impl test files: a GitPort wired to the real `git` on PATH (test-only; production pins an
// absolute path at doctor time). Not a `*.itest.ts` file, so vitest never collects it on its own.
import type { CanonicalPath, GitIdentity } from '../../src/contract.ts';
import { createGitPort, type GitPortOptions } from '../../src/impl/index.ts';

export const MERGE_IDENTITY: GitIdentity = { name: 'Cohorte Test', email: 'cohorte-test@example.invalid' };
export const AGENT_IDENTITY: GitIdentity = { name: 'Agent Test', email: 'agent-test@example.invalid' };

/**
 * The default `worktreeRoot`: a path that does not exist, so a test that needs the root (only `resetHardClean`
 * reads it) and forgets to set it fails loudly instead of quietly passing the guard of DESIGN 5.1.
 */
export const UNSET_WORKTREE_ROOT = '/cohorte-test/worktree-root-not-set' as CanonicalPath;

export function testGitPortOptions(overrides: Partial<GitPortOptions> = {}): GitPortOptions {
  return {
    gitBinary: 'git',
    path: process.env.PATH ?? '/usr/bin:/bin',
    mergeIdentity: MERGE_IDENTITY,
    worktreeRoot: UNSET_WORKTREE_ROOT,
    ...overrides,
  };
}

export function testGitPort(overrides: Partial<GitPortOptions> = {}) {
  return createGitPort(testGitPortOptions(overrides));
}
