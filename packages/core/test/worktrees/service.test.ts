import type { CanonicalPath, GitPort } from '@cohorte/git/contract';
import { describe, expect, it } from 'vitest';
import { createWorktreeServiceImpl } from '../../src/worktrees/implementation.ts';

const runId = 'run_0123456789abcdef0123456789abcdef' as never;
const base = {
  repo: '/tmp/repo' as CanonicalPath,
  root: '/tmp/cohorte-worktrees' as CanonicalPath,
  integrationHead: 'a'.repeat(40),
};

function fakeGit(): GitPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async addWorktree() {
      calls.push('add');
    },
    async switchToNewBranch() {
      calls.push('switch');
    },
    async commitAll() {
      calls.push('commit');
      return { sha: 'b'.repeat(40), treeDigest: 'c'.repeat(64) };
    },
    async changedPaths() {
      return [];
    },
    async resetHardClean() {
      calls.push('reset');
    },
  } as unknown as GitPort & { calls: string[] };
}

describe('WorktreeService', () => {
  it('creates an isolated slot, reuses it for the next incarnation, and resets cleanly', async () => {
    const git = fakeGit();
    const service = createWorktreeServiceImpl({ ...base, git, runId });
    const first = await service.acquire('build-api', 'agt_implementer_api' as never);
    await service.release('build-api');
    const second = await service.acquire('build-api', 'agt_implementer_api_2' as never);
    await service.resetClean('build-api', 'd'.repeat(40));
    expect(first.path).toBe('/tmp/cohorte-worktrees/build-api');
    expect(second.path).toBe(first.path);
    expect(git.calls).toEqual(['add', 'switch', 'reset']);
  });

  it('rejects unsafe slot identifiers before touching git', async () => {
    const git = fakeGit();
    const service = createWorktreeServiceImpl({ ...base, git, runId });
    await expect(service.acquire('../repo', 'agt_implementer_api' as never)).rejects.toThrow('invalid worktree slot');
    expect(git.calls).toEqual([]);
  });
});
