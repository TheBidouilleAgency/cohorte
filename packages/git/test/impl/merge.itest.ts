// DESIGN 5.4/5.5, ADR-0008: plumbing merge (merge-tree -> commit-tree -> update-ref CAS), no working tree, no hook.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { CanonicalPath } from '../../src/contract.ts';
import { AGENT_IDENTITY, testGitPort } from './helpers.ts';

async function branchWorktree(
  port: ReturnType<typeof testGitPort>,
  repo: CanonicalPath,
  dir: string,
  branch: string,
  at: string,
  file: string,
  content: string,
): Promise<string> {
  const path = join(dir, branch) as CanonicalPath;
  await port.addWorktree({ repo, path, branch, commit: at });
  await writeFile(join(path, file), content);
  const result = await port.commitAll({
    worktree: path,
    message: `${branch}: ${file}`,
    trailers: {},
    identity: AGENT_IDENTITY,
    paths: [file],
  });
  if (!('sha' in result)) throw new Error('expected a commit');
  return result.sha;
}

describe('mergeTree', () => {
  test('a clean merge returns the merged tree; commitTree + updateRefCas land it', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const base = await tempRepo.head();

    const oursSha = await branchWorktree(port, repo, tempDir, 'ours', base, 'ours-only.txt', 'from ours\n');
    const theirsSha = await branchWorktree(port, repo, tempDir, 'theirs', base, 'theirs-only.txt', 'from theirs\n');

    const merged = await port.mergeTree(repo, 'ours', 'theirs');
    expect(merged.clean).toBe(true);
    if (!merged.clean) throw new Error('expected a clean merge');

    const mergeSha = await port.commitTree(repo, merged.tree, [oursSha, theirsSha], 'cohorte(spec): integrate', {
      'Cohorte-Run': 'run_merge',
    });
    const ref = 'refs/cohorte/run_merge/integration';
    expect(await port.updateRefCas(repo, ref, mergeSha, null)).toBe('ok');
    expect(await tempRepo.git(['rev-parse', ref])).toMatchObject({ stdout: `${mergeSha}\n` });

    const files = await tempRepo.git(['ls-tree', '-r', '--name-only', mergeSha]);
    expect(files.stdout).toContain('ours-only.txt');
    expect(files.stdout).toContain('theirs-only.txt');
  });

  test('a conflicting merge reports the conflicted files and commits nothing', async ({ tempRepo, tempDir }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const base = await tempRepo.head();

    await branchWorktree(port, repo, tempDir, 'ours-c', base, 'shared.txt', 'ours version\n');
    await branchWorktree(port, repo, tempDir, 'theirs-c', base, 'shared.txt', 'theirs version\n');

    const merged = await port.mergeTree(repo, 'ours-c', 'theirs-c');
    expect(merged.clean).toBe(false);
    if (merged.clean) throw new Error('expected a conflict');
    expect(merged.files).toEqual(['shared.txt']);
  });
});

describe('updateRefCas', () => {
  test('a stale expectedOld reports moved, never applying the write', async ({ tempRepo }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const first = await tempRepo.head();
    await tempRepo.write('extra.txt', 'x\n');
    const second = await tempRepo.commit('second');

    const ref = 'refs/cohorte/run_cas/integration';
    expect(await port.updateRefCas(repo, ref, first, null)).toBe('ok'); // ref now at `first`
    // A racing writer whose stale view of the ref was `second` (it never was) loses the CAS and applies nothing.
    expect(await port.updateRefCas(repo, ref, second, second)).toBe('moved');
    expect(await tempRepo.git(['rev-parse', ref])).toMatchObject({ stdout: `${first}\n` });
  });

  test('creating the same ref twice: the second call reports moved', async ({ tempRepo }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const sha = await tempRepo.head();
    const ref = 'refs/cohorte/run_create/integration';
    expect(await port.updateRefCas(repo, ref, sha, null)).toBe('ok');
    expect(await port.updateRefCas(repo, ref, sha, null)).toBe('moved');
  });

  test('an expectedOld on a ref that no longer exists reports moved', async ({ tempRepo }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const sha = await tempRepo.head();
    const ref = 'refs/cohorte/run_gone/integration';
    expect(await port.updateRefCas(repo, ref, sha, null)).toBe('ok');
    await tempRepo.git(['update-ref', '-d', ref]);
    expect(await port.updateRefCas(repo, ref, sha, sha)).toBe('moved');
  });

  test('plain lock contention is an error to retry, never a lost compare-and-swap', async ({ tempRepo }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const sha = await tempRepo.head();
    const ref = 'refs/cohorte/run_lock/integration';
    // A stale or concurrently held `<ref>.lock` makes git say `cannot lock ref` too, but the repository did NOT
    // change underneath us; DESIGN 5.4 (1) would turn a `moved` here into a false `unexpected-repo-change`.
    const lock = join(repo, '.git', `${ref}.lock`);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, '');

    await expect(port.updateRefCas(repo, ref, sha, null)).rejects.toThrow(/Unable to create|File exists/i);
    await expect(port.createRef(repo, ref, sha)).rejects.toThrow(/Unable to create|File exists/i);
    await rm(lock);
    expect(await port.updateRefCas(repo, ref, sha, null)).toBe('ok');
  });
});

describe('createRef', () => {
  test('mints an immutable reviewer ref: a second mint attempt throws', async ({ tempRepo }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const sha = await tempRepo.head();
    const ref = 'refs/cohorte/run_review/review/1';
    await port.createRef(repo, ref, sha);
    expect(await tempRepo.git(['rev-parse', ref])).toMatchObject({ stdout: `${sha}\n` });

    await tempRepo.write('after-review.txt', 'x\n');
    const laterSha = await tempRepo.commit('after review minted');
    await expect(port.createRef(repo, ref, laterSha)).rejects.toThrow();
    // The ref never moved.
    expect(await tempRepo.git(['rev-parse', ref])).toMatchObject({ stdout: `${sha}\n` });
  });
});
