import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempRepo, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { CanonicalPath } from '../../src/contract.ts';
import { testGitPort } from './helpers.ts';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('addWorktree', () => {
  test('concurrent worktree add succeeds for every slot', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const head = await tempRepo.head();
    const slots = ['a', 'b', 'c', 'd'];
    await Promise.all(
      slots.map((slot) =>
        port.addWorktree({ repo, path: join(tempDir, slot) as CanonicalPath, branch: `agent/${slot}`, commit: head }),
      ),
    );
    const facts = await port.facts(repo);
    expect(facts.worktrees).toHaveLength(slots.length + 1);
    for (const slot of slots) {
      const wt = facts.worktrees.find((w) => w.path === join(tempDir, slot));
      expect(wt?.branch).toBe(`agent/${slot}`);
    }
  });

  test('detached: no branch is created', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = join(tempDir, 'detached') as CanonicalPath;
    await port.addWorktree({ repo, path: wtPath, branch: null, commit: await tempRepo.head() });
    const facts = await port.facts(repo);
    const wt = facts.worktrees.find((w) => w.path === wtPath);
    expect(wt?.branch).toBeNull();
  });
});

describe('switchToNewBranch', () => {
  test('slot reuse: a fresh branch at the given commit', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = join(tempDir, 'slot') as CanonicalPath;
    const head1 = await tempRepo.head();
    await port.addWorktree({ repo, path: wtPath, branch: 'incarnation-1', commit: head1 });

    await tempRepo.write('root-change.txt', 'x\n');
    const head2 = await tempRepo.commit('advance integration');

    await port.switchToNewBranch({ worktree: wtPath, branch: 'incarnation-2', at: head2 });
    const facts = await port.facts(repo);
    const wt = facts.worktrees.find((w) => w.path === wtPath);
    expect(wt?.branch).toBe('incarnation-2');
    expect(wt?.head).toBe(head2);
  });

  test('refuses a dirty slot instead of carrying the previous agent over', async ({ tempRepo, tempDir }) => {
    // DESIGN 5.2 / ADR-0021 §3: the incoming agent's branch starts AT the integration head. `git checkout -b`
    // carries uncommitted and untracked files across, so the next `commitAll` would attribute the previous
    // agent's unfinished work to the new one; the caller decides (`resetHardClean`), never this method.
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = join(tempDir, 'reused-slot') as CanonicalPath;
    const head = await tempRepo.head();
    await port.addWorktree({ repo, path: wtPath, branch: 'agent-1', commit: head });
    await writeFile(join(wtPath, 'previous-agent-leftover.txt'), 'x\n');

    await expect(port.switchToNewBranch({ worktree: wtPath, branch: 'agent-2', at: head })).rejects.toThrow(
      /dirty|uncommitted/i,
    );
    const facts = await port.facts(repo);
    expect(facts.worktrees.find((w) => w.path === wtPath)?.branch).toBe('agent-1');
  });
});

describe('removeWorktree', () => {
  test('removes a clean worktree', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = join(tempDir, 'clean') as CanonicalPath;
    await port.addWorktree({ repo, path: wtPath, branch: 'clean-branch', commit: await tempRepo.head() });
    const result = await port.removeWorktree(wtPath, { force: false });
    expect(result).toBe('removed');
    expect(await exists(wtPath)).toBe(false);
  });

  test('keeps a dirty worktree', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = join(tempDir, 'dirty') as CanonicalPath;
    await port.addWorktree({ repo, path: wtPath, branch: 'dirty-branch', commit: await tempRepo.head() });
    await writeFile(join(wtPath, 'untracked.txt'), 'x\n');
    const result = await port.removeWorktree(wtPath, { force: false });
    expect(result).toBe('dirty-kept');
    expect(await exists(wtPath)).toBe(true);
  });
});

describe('resetHardClean', () => {
  test('refuses to operate on the main worktree', async ({ tempRepo }) => {
    // The root check passes (the target IS the configured root), so this pins the SECOND guard on its own.
    const port = testGitPort({ worktreeRoot: tempRepo.root as CanonicalPath });
    await expect(port.resetHardClean(tempRepo.root as CanonicalPath, await tempRepo.head())).rejects.toThrow(
      /main worktree/,
    );
  });

  test('resets and cleans a linked worktree, leaving the main worktree untouched', async ({ tempRepo, tempDir }) => {
    const port = testGitPort({ worktreeRoot: tempDir as CanonicalPath });
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = join(tempDir, 'quarantine') as CanonicalPath;
    const head = await tempRepo.head();
    await port.addWorktree({ repo, path: wtPath, branch: 'quarantined', commit: head });
    await writeFile(join(wtPath, 'tracked.txt'), 'v1\n');
    await port.commitAll({
      worktree: wtPath,
      message: 'v1',
      trailers: {},
      identity: { name: 'a', email: 'a@example.invalid' },
      paths: ['tracked.txt'],
    });
    await writeFile(join(wtPath, 'tracked.txt'), 'v2-uncommitted\n');
    await writeFile(join(wtPath, 'untracked.txt'), 'stray\n');

    await port.resetHardClean(wtPath, head);

    expect(await exists(join(wtPath, 'tracked.txt'))).toBe(false); // reset --hard to `head`, before tracked.txt existed
    expect(await exists(join(wtPath, 'untracked.txt'))).toBe(false); // clean -fdx
    const mainStatus = await tempRepo.git(['status', '--porcelain=v2']);
    expect(mainStatus.stdout).toBe('');
  });

  test('refuses a path that is not a registered worktree', async ({ tempDir }) => {
    const port = testGitPort({ worktreeRoot: tempDir as CanonicalPath });
    await expect(port.resetHardClean(tempDir as CanonicalPath, 'HEAD')).rejects.toThrow(/registered worktree/);
  });

  test('refuses a linked worktree of another repository outside the root, and destroys nothing', async ({
    tempDir,
    tempHome,
  }) => {
    // DESIGN 5.1 / ADR-0021 §1: `resetHardClean` is a quarantine operation on Cohorte's OWN worktree root. A
    // linked worktree of an unrelated repository is a registered, non-main worktree of its own repository, so
    // the registration check alone would accept it and `reset --hard` + `clean -fdx` would destroy user work.
    const root = join(tempDir, 'cohorte-worktree-root');
    await mkdir(root, { recursive: true });
    const other = await createTempRepo(join(tempDir, 'users-repo'), { home: tempHome });
    await other.write('important.txt', 'work in progress\n');
    await other.commit('user work');
    const outside = join(tempDir, 'users-other-checkout');
    await other.git(['worktree', 'add', '-b', 'users-branch', outside]);
    await writeFile(join(outside, 'uncommitted-user-work.txt'), 'never lose me\n');
    await writeFile(join(outside, 'important.txt'), 'edited, not committed\n');

    const port = testGitPort({ worktreeRoot: root as CanonicalPath });
    await expect(port.resetHardClean(outside as CanonicalPath, 'HEAD')).rejects.toThrow(/worktree root/);

    expect(await exists(join(outside, 'uncommitted-user-work.txt'))).toBe(true);
    expect(await readFile(join(outside, 'important.txt'), 'utf8')).toBe('edited, not committed\n');
  });

  test('a sibling of the root whose name merely starts with it is outside the root', async ({ tempRepo, tempDir }) => {
    // Segment-boundary comparison, never a bare `startsWith`: `<root>-evil` is not below `<root>`.
    const root = join(tempDir, 'root');
    await mkdir(root, { recursive: true });
    const port = testGitPort({ worktreeRoot: root as CanonicalPath });
    const sibling = join(tempDir, 'root-evil') as CanonicalPath;
    await port.addWorktree({
      repo: tempRepo.root as CanonicalPath,
      path: sibling,
      branch: 'sibling',
      commit: await tempRepo.head(),
    });
    await writeFile(join(sibling, 'keep-me.txt'), 'x\n');

    await expect(port.resetHardClean(sibling, 'HEAD')).rejects.toThrow(/worktree root/);
    expect(await exists(join(sibling, 'keep-me.txt'))).toBe(true);
  });
});
