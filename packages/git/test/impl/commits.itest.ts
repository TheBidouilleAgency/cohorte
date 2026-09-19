import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { CanonicalPath } from '../../src/contract.ts';
import { AGENT_IDENTITY, testGitPort } from './helpers.ts';

describe('commitAll', () => {
  test('commits staged paths with trailers and returns sha + treeDigest', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    await tempRepo.write('a.txt', 'hello\n');

    const result = await port.commitAll({
      worktree,
      message: 'cohorte(spec): backend build#1',
      trailers: { 'Cohorte-Run': 'run_abc', 'Cohorte-Effect': 'eff_1' },
      identity: AGENT_IDENTITY,
      paths: ['a.txt'],
    });

    expect('sha' in result).toBe(true);
    if (!('sha' in result)) throw new Error('unreachable');
    expect(result.sha).toBe(await tempRepo.head());
    const log = await tempRepo.git(['log', '-1', '--format=%B']);
    expect(log.stdout).toContain('Cohorte-Run: run_abc');
    expect(log.stdout).toContain('Cohorte-Effect: eff_1');
  });

  test('is content-idempotent: an identical second call finds nothing to commit', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    await tempRepo.write('a.txt', 'hello\n');
    const req = {
      worktree,
      message: 'first',
      trailers: { 'Cohorte-Run': 'run_abc' },
      identity: AGENT_IDENTITY,
      paths: ['a.txt'],
    };
    const first = await port.commitAll(req);
    expect('sha' in first).toBe(true);

    // No further edits: the same paths, the same content already committed.
    const second = await port.commitAll({ ...req, message: 'second attempt, nothing changed' });
    expect(second).toEqual({ kind: 'nothing' });
  });

  test('commits ONLY the requested paths, even when the index holds foreign staged content', async ({ tempRepo }) => {
    const port = testGitPort();
    const worktree = tempRepo.root as CanonicalPath;
    await tempRepo.write('seed.txt', 'seed\n');
    await tempRepo.commit('seed');

    // Agents cannot commit, but `git add` is not in ADR-0007 §2's built-in deny list: the index may already hold
    // something Cohorte never audited. It must not ride along (DESIGN 5.3).
    await tempRepo.write('not-mine.txt', 'staged out of band\n');
    await tempRepo.git(['add', '--', 'not-mine.txt']);
    await tempRepo.write('mine.txt', 'audited\n');
    await tempRepo.git(['rm', '-q', '--cached', '--', 'seed.txt']); // a staged deletion of an audited path
    await tempRepo.write('seed.txt', 'seed\n'); // still on disk: `paths` decides, not the index

    const result = await port.commitAll({
      worktree,
      message: 'cohorte(spec): only mine',
      trailers: {},
      identity: AGENT_IDENTITY,
      paths: ['mine.txt'],
    });
    expect('sha' in result).toBe(true);

    const committed = await tempRepo.git(['show', '--name-only', '--format=', 'HEAD']);
    expect(committed.stdout.trim().split('\n')).toEqual(['mine.txt']);
    // The foreign path is still staged, uncommitted: the next commitAll must not sweep it up either.
    const staged = await tempRepo.git(['diff', '--cached', '--name-only']);
    expect(staged.stdout).toContain('not-mine.txt');
  });

  test('a deletion of a requested path is committed as a deletion', async ({ tempRepo }) => {
    const port = testGitPort();
    await tempRepo.write('gone.txt', 'bye\n');
    await tempRepo.commit('add gone.txt');
    await rm(join(tempRepo.root, 'gone.txt')); // an agent deletes the file; the index still carries it

    const result = await port.commitAll({
      worktree: tempRepo.root as CanonicalPath,
      message: 'cohorte(spec): remove',
      trailers: {},
      identity: AGENT_IDENTITY,
      paths: ['gone.txt'],
    });
    expect('sha' in result).toBe(true);
    const named = await tempRepo.git(['show', '--name-status', '--format=', 'HEAD']);
    expect(named.stdout.trim()).toBe('D\tgone.txt');
  });

  test('an empty paths list is always nothing to commit', async ({ tempRepo }) => {
    const port = testGitPort();
    const result = await port.commitAll({
      worktree: tempRepo.root as CanonicalPath,
      message: 'noop',
      trailers: {},
      identity: AGENT_IDENTITY,
      paths: [],
    });
    expect(result).toEqual({ kind: 'nothing' });
  });

  test('adds a Co-authored-by trailer when the identity carries one', async ({ tempRepo }) => {
    const port = testGitPort();
    await tempRepo.write('b.txt', 'x\n');
    await port.commitAll({
      worktree: tempRepo.root as CanonicalPath,
      message: 'user identity',
      trailers: {},
      identity: { ...AGENT_IDENTITY, coAuthoredBy: 'Cohorte <cohorte@localhost>' },
      paths: ['b.txt'],
    });
    const log = await tempRepo.git(['log', '-1', '--format=%B']);
    expect(log.stdout).toContain('Co-authored-by: Cohorte <cohorte@localhost>');
  });
});

describe('findCommitByTrailer', () => {
  test('finds exactly one commit', async ({ tempRepo }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    await tempRepo.write('one.txt', '1\n');
    await port.commitAll({
      worktree: repo,
      message: 'one',
      trailers: { 'Cohorte-Effect': 'eff_1' },
      identity: AGENT_IDENTITY,
      paths: ['one.txt'],
    });
    await tempRepo.write('two.txt', '2\n');
    await port.commitAll({
      worktree: repo,
      message: 'two',
      trailers: { 'Cohorte-Effect': 'eff_2' },
      identity: AGENT_IDENTITY,
      paths: ['two.txt'],
    });

    const found = await port.findCommitByTrailer(repo, 'main', 'Cohorte-Effect', 'eff_1');
    expect(found).not.toBeNull();
    const commitMessage = await tempRepo.git(['log', '-1', '--format=%B', found ?? '']);
    expect(commitMessage.stdout).toContain('one');

    const missing = await port.findCommitByTrailer(repo, 'main', 'Cohorte-Effect', 'eff_does-not-exist');
    expect(missing).toBeNull();
  });
});
