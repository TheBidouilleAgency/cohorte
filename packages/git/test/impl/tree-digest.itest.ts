// DESIGN 5.8 / 7.4 E1-E9 + F1 (inverted). V2's content-addressed digest, ported: survives an identical-content
// commit, is invalidated by any tracked edit or new untracked non-ignored file, ignores `.cohorte/`, and never
// touches the real index.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempRepo, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { CanonicalPath } from '../../src/contract.ts';
import { testGitPort } from './helpers.ts';

const EXCLUDE = ['.cohorte'];
/** git's well-known empty-tree object id (`git hash-object -t tree /dev/null`). */
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

describe('treeDigest', () => {
  test('is deterministic on an unchanged worktree', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    const before = await port.treeDigest(worktree, { exclude: EXCLUDE });
    const afterNoChange = await port.treeDigest(worktree, { exclude: EXCLUDE });
    expect(afterNoChange).toBe(before);
  });

  test('a repository whose index was never written digests to the empty tree', async ({ tempDir, tempHome }) => {
    // `git init` does not create `.git/index`: the digest must still be computable (the empty-tree oid) instead of
    // failing with a raw fs error before git is ever invoked — a caller could not classify that as 5.8's "not fresh".
    const repo = await createTempRepo(`${tempDir}/index-less`, { home: tempHome, initialCommit: false });
    const digest = await testGitPort().treeDigest(repo.root as CanonicalPath, { exclude: EXCLUDE });
    expect(digest).toBe(EMPTY_TREE_OID);
    // The digest computation created no real index either.
    await expect(stat(join(repo.root, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('is invalidated by a tracked edit, and reverts when the edit is reverted', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    await tempRepo.write('tracked.txt', 'original\n');
    await tempRepo.commit('add tracked.txt');
    const clean = await port.treeDigest(worktree, { exclude: EXCLUDE });

    await tempRepo.write('tracked.txt', 'edited\n');
    const edited = await port.treeDigest(worktree, { exclude: EXCLUDE });
    expect(edited).not.toBe(clean);

    await tempRepo.write('tracked.txt', 'original\n');
    const reverted = await port.treeDigest(worktree, { exclude: EXCLUDE });
    expect(reverted).toBe(clean);
  });

  test('is invalidated by a new untracked, non-ignored file', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    const before = await port.treeDigest(worktree, { exclude: EXCLUDE });
    await tempRepo.write('untracked.txt', 'new\n');
    const after = await port.treeDigest(worktree, { exclude: EXCLUDE });
    expect(after).not.toBe(before);
  });

  test('ignores the excluded directory (.cohorte/)', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    const before = await port.treeDigest(worktree, { exclude: EXCLUDE });
    await tempRepo.write('.cohorte/state/whatever.json', '{}\n');
    const after = await port.treeDigest(worktree, { exclude: EXCLUDE });
    expect(after).toBe(before);
  });

  test('a gitignored file is outside the digest, an unignored sibling is not', async ({ tempRepo }) => {
    // DESIGN 5.7 leans on this property explicitly: because the digest ignores ignored files, `node_modules` and
    // `provision.writableCaches` need their own manifest digest. A pathspec widened to `--force` would silently
    // break that reasoning, so the boundary is pinned here rather than left to the implementation's intent.
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    await tempRepo.write('.gitignore', 'secrets/\n');
    await tempRepo.commit('ignore secrets/');
    const before = await port.treeDigest(worktree, { exclude: EXCLUDE });

    await tempRepo.write('secrets/k.pem', 'ignored content\n');
    expect(await port.treeDigest(worktree, { exclude: EXCLUDE })).toBe(before);

    await tempRepo.write('not-secrets.txt', 'seen\n');
    expect(await port.treeDigest(worktree, { exclude: EXCLUDE })).not.toBe(before);
  });

  test('is content-idempotent across a commit: pre-commit and post-commit digests match', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    await tempRepo.write('idempotent.txt', 'same content\n');
    const staged = await port.treeDigest(worktree, { exclude: EXCLUDE });
    await tempRepo.commit('idempotent commit');
    const committed = await port.treeDigest(worktree, { exclude: EXCLUDE });
    expect(committed).toBe(staged);
  });

  test('E9: the real index is never touched', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    const indexPath = join(worktree, '.git', 'index');
    const before = await readFile(indexPath);
    const beforeStat = await stat(indexPath);
    await writeFile(join(worktree, 'racy.txt'), 'x\n');
    await port.treeDigest(worktree, { exclude: EXCLUDE });
    const after = await readFile(indexPath);
    const afterStat = await stat(indexPath);
    expect(after.equals(before)).toBe(true);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    const status = await tempRepo.git(['status', '--porcelain=v2']);
    expect(status.stdout).toMatch(/^\? racy\.txt$/m);
  });

  test('F1 inverted: digest is purely content-addressed, so a green digest from one worktree does not identify another', async ({
    tempRepo,
    tempDir,
  }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const wtPath = join(tempDir, 'other-worktree') as CanonicalPath;
    await port.addWorktree({ repo, path: wtPath, branch: 'other', commit: await tempRepo.head() });

    const mainDigest = await port.treeDigest(repo, { exclude: EXCLUDE });
    const otherDigest = await port.treeDigest(wtPath, { exclude: EXCLUDE });
    // Same content (a fresh worktree at the same commit) -> the SAME digest, even though they are different
    // worktrees: the digest alone cannot distinguish them, so a caller must bind results to (runId, slot, digest).
    expect(otherDigest).toBe(mainDigest);

    await writeFile(join(wtPath, 'only-in-other.txt'), 'x\n');
    const otherChanged = await port.treeDigest(wtPath, { exclude: EXCLUDE });
    const mainUnchanged = await port.treeDigest(repo, { exclude: EXCLUDE });
    expect(otherChanged).not.toBe(mainUnchanged);
    expect(mainUnchanged).toBe(mainDigest);
  });
});
