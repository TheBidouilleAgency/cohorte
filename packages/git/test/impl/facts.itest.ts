import { rm } from 'node:fs/promises';
import { createTempRepo, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { CanonicalPath } from '../../src/contract.ts';
import { testGitPort } from './helpers.ts';

describe('facts', () => {
  test('reports a supported version, the common dir, HEAD and the main worktree', async ({ tempRepo }) => {
    const port = testGitPort();
    const result = await port.facts(tempRepo.root as CanonicalPath);
    expect(result.supported).toBe(true);
    expect(result.gitVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.commonDir.endsWith('.git')).toBe(true);
    expect(result.head).toEqual({ kind: 'branch', name: 'main', sha: await tempRepo.head() });
    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]?.path).toBe(tempRepo.root);
    expect(result.worktrees[0]?.branch).toBe('main');
  });

  test('reports detached HEAD', async ({ tempRepo }) => {
    const sha = await tempRepo.head();
    await tempRepo.git(['checkout', '--detach', sha]);
    const result = await testGitPort().facts(tempRepo.root as CanonicalPath);
    expect(result.head).toEqual({ kind: 'detached', sha });
  });

  test('reports unborn HEAD before the first commit', async ({ tempDir, tempHome }) => {
    const repo = await createTempRepo(tempDir, { home: tempHome, initialCommit: false });
    const result = await testGitPort().facts(repo.root as CanonicalPath);
    expect(result.head).toEqual({ kind: 'unborn' });
  });

  test('lists every linked worktree', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = `${tempDir}/linked` as CanonicalPath;
    await port.addWorktree({ repo, path: wtPath, branch: 'linked-branch', commit: await tempRepo.head() });
    const result = await port.facts(repo);
    expect(result.worktrees).toHaveLength(2);
    const paths = result.worktrees.map((w) => w.path).sort();
    expect(paths).toEqual([tempRepo.root, wtPath].sort());
    const linked = result.worktrees.find((w) => w.path === wtPath);
    expect(linked?.branch).toBe('linked-branch');
  });

  // DESIGN 5.1: "Base = origin/<default> when it verifies, else local <default>". `origin/HEAD` only exists after a
  // `clone` (not single-branch) or an explicit `remote set-head`, so the local fallbacks carry almost every repo.
  describe('defaultBranch', () => {
    test('prefers origin/HEAD when the remote records one', async ({ tempRepo, tempDir }) => {
      const remote = `${tempDir}/remote.git`;
      await tempRepo.git(['init', '--bare', '--quiet', `--initial-branch=trunk`, remote]);
      await tempRepo.git(['remote', 'add', 'origin', remote]);
      await tempRepo.git(['push', '--quiet', '-u', 'origin', 'main:trunk']);
      await tempRepo.git(['remote', 'set-head', 'origin', 'trunk']);

      const result = await testGitPort().facts(tempRepo.root as CanonicalPath);
      expect(result.defaultBranch).toBe('trunk');
    });

    test('falls back to the local main when the remote has no origin/HEAD', async ({ tempRepo, tempDir }) => {
      const remote = `${tempDir}/remote.git`;
      await tempRepo.git(['init', '--bare', '--quiet', '--initial-branch=main', remote]);
      await tempRepo.git(['remote', 'add', 'origin', remote]);
      await tempRepo.git(['push', '--quiet', '-u', 'origin', 'main']);
      await tempRepo.git(['checkout', '--quiet', '-b', 'feature/work']);
      // `remote add` + `push -u` never writes refs/remotes/origin/HEAD.
      await expect(tempRepo.git(['symbolic-ref', 'refs/remotes/origin/HEAD'])).rejects.toThrow();

      const result = await testGitPort().facts(tempRepo.root as CanonicalPath);
      expect(result.defaultBranch).toBe('main');
    });

    test('a local-only repository reports its own default branch', async ({ tempRepo }) => {
      const result = await testGitPort().facts(tempRepo.root as CanonicalPath);
      expect(result.defaultBranch).toBe('main');
    });

    test('neither main nor master: the current branch is the default', async ({ tempDir, tempHome }) => {
      const repo = await createTempRepo(`${tempDir}/trunk-only`, { home: tempHome, initialBranch: 'trunk' });
      const result = await testGitPort().facts(repo.root as CanonicalPath);
      expect(result.defaultBranch).toBe('trunk');
    });

    test('an unborn repository has no default branch', async ({ tempDir, tempHome }) => {
      const repo = await createTempRepo(`${tempDir}/unborn`, {
        home: tempHome,
        initialBranch: 'trunk',
        initialCommit: false,
      });
      const result = await testGitPort().facts(repo.root as CanonicalPath);
      expect(result.defaultBranch).toBeNull();
    });
  });

  test('a registered worktree whose directory is gone is still listed, not an error', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = `${tempDir}/vanished` as CanonicalPath;
    await port.addWorktree({ repo, path: wtPath, branch: 'vanished-branch', commit: await tempRepo.head() });
    // `git worktree list` keeps reporting it until `worktree prune` runs (DESIGN 5.9): resume, doctor and
    // MergeService all discover worktrees through `facts`, so one stale entry must not fail the whole call.
    await rm(wtPath, { recursive: true, force: true });

    const result = await port.facts(repo);
    expect(result.worktrees).toHaveLength(2);
    expect(result.worktrees.map((w) => w.path)).toContain(wtPath);
  });
});
