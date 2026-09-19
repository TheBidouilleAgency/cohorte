import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { takeCheckpoint } from '../checkpoint.ts';
import { REPO_ROOT, type TempTree, test } from './support/tree.ts';

const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

const BINARY = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 0]);

/** A repository with one commit, then: an edit, a binary edit, an index rename, a deletion, untracked and ignored files. */
async function dirtyRepo(tree: TempTree): Promise<string> {
  const repo = join(tree.root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await tree.write({
    'repo/.gitignore': 'node_modules/\n*.log\n',
    'repo/kept.txt': 'kept\n',
    'repo/edited.txt': 'before\n',
    'repo/old-name.txt': 'moved by git mv\n',
    'repo/deleted.txt': 'gone\n',
  });
  writeFileSync(join(repo, 'blob.bin'), BINARY);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');

  writeFileSync(join(repo, 'edited.txt'), 'after\n');
  writeFileSync(join(repo, 'blob.bin'), Buffer.concat([BINARY, BINARY]));
  git(repo, 'mv', 'old-name.txt', 'new-name.txt');
  git(repo, 'rm', '-q', 'deleted.txt');
  await tree.write({
    'repo/untracked/new file.ts': 'export const fresh = 1;\n',
    'repo/untracked/deep/er.md': '# deep\n',
    'repo/node_modules/dep/index.js': 'ignored\n',
    'repo/debug.log': 'ignored\n',
  });
  return repo;
}

const snapshot = (repo: string) => ({
  head: git(repo, 'rev-parse', 'HEAD').trim(),
  refs: git(repo, 'for-each-ref'),
  stash: git(repo, 'stash', 'list'),
  status: git(repo, 'status', '--porcelain=v1', '-z'),
  index: readFileSync(join(repo, '.git/index')).toString('base64'),
});

describe('takeCheckpoint', () => {
  test('writes a binary patch of tracked changes and a tarball of untracked files, outside the repository', async ({
    tree,
  }) => {
    const repo = await dirtyRepo(tree);
    const out = join(tree.root, 'checkpoints');
    const before = snapshot(repo);

    const result = takeCheckpoint({
      root: repo,
      gate: 'G0',
      checkpointDir: out,
      now: new Date('2026-09-18T12:00:00Z'),
      env: GIT_ENV,
    });

    expect(result.dir.startsWith(out)).toBe(true);
    expect(readdirSync(result.dir).sort()).toEqual(['manifest.json', 'tracked.patch', 'untracked.tar.gz']);
    const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      gate: 'G0',
      head: before.head,
      branch: 'main',
      createdAt: '2026-09-18T12:00:00.000Z',
    });
    expect(manifest.untracked.files).toEqual(['untracked/deep/er.md', 'untracked/new file.ts']);
    expect(manifest.tracked.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.untracked.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The repository's git state is exactly what it was: no commit, no ref, no stash, same index.
    expect(snapshot(repo)).toEqual(before);
  });

  test('round trip: HEAD + patch + tarball reproduces the working tree', async ({ tree }) => {
    const repo = await dirtyRepo(tree);
    const result = takeCheckpoint({
      root: repo,
      gate: 'G1',
      checkpointDir: join(tree.root, 'checkpoints'),
      env: GIT_ENV,
    });

    const restored = join(tree.root, 'restored');
    git(tree.root, 'clone', '-q', repo, restored);
    git(restored, 'apply', '--index', '--binary', join(result.dir, 'tracked.patch'));
    execFileSync('tar', ['-xzf', join(result.dir, 'untracked.tar.gz'), '-C', restored]);

    expect(readFileSync(join(restored, 'edited.txt'), 'utf8')).toBe('after\n');
    expect(readFileSync(join(restored, 'blob.bin'))).toEqual(Buffer.concat([BINARY, BINARY]));
    expect(existsSync(join(restored, 'old-name.txt'))).toBe(false);
    expect(readFileSync(join(restored, 'new-name.txt'), 'utf8')).toBe('moved by git mv\n');
    expect(existsSync(join(restored, 'deleted.txt'))).toBe(false);
    expect(readFileSync(join(restored, 'untracked/new file.ts'), 'utf8')).toBe('export const fresh = 1;\n');
    expect(existsSync(join(restored, 'node_modules'))).toBe(false);
    expect(existsSync(join(restored, 'debug.log'))).toBe(false);
    // One patch cannot say which changes were staged, so the restored tree has them all staged; what
    // must be identical is the content: the same diff against HEAD, the same untracked files.
    expect(git(restored, 'diff', '--binary', 'HEAD')).toBe(git(repo, 'diff', '--binary', 'HEAD'));
    expect(git(restored, 'ls-files', '--others', '--exclude-standard')).toBe(
      git(repo, 'ls-files', '--others', '--exclude-standard'),
    );
  });

  test('a clean repository still yields a checkpoint (empty patch, empty tarball)', async ({ tree }) => {
    const repo = join(tree.root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await tree.write({ 'repo/a.txt': 'a\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const result = takeCheckpoint({
      root: repo,
      gate: 'G2',
      checkpointDir: join(tree.root, 'checkpoints'),
      env: GIT_ENV,
    });
    expect(readFileSync(join(result.dir, 'tracked.patch'), 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8')).untracked.files).toEqual([]);
  });

  test('two checkpoints of one gate never overwrite each other', async ({ tree }) => {
    const repo = await dirtyRepo(tree);
    const at = new Date('2026-09-18T12:00:00Z');
    const options = { root: repo, gate: 'G0', checkpointDir: join(tree.root, 'checkpoints'), now: at, env: GIT_ENV };
    expect(takeCheckpoint(options).dir).not.toBe(takeCheckpoint(options).dir);
  });

  test.for([
    ['no checkpoint directory', { checkpointDir: undefined }, /COHORTE_CHECKPOINT_DIR/],
    ['a relative checkpoint directory', { checkpointDir: 'checkpoints' }, /absolute/],
    ['a gate name that is not a plain token', { gate: '../G0' }, /gate/],
  ] as const)('refuses %s', async ([, override, message], { tree }) => {
    const repo = await dirtyRepo(tree);
    const options = {
      root: repo,
      gate: 'G0',
      checkpointDir: join(tree.root, 'checkpoints'),
      env: GIT_ENV,
      ...override,
    };
    expect(() => takeCheckpoint(options)).toThrow(message);
  });

  test('refuses a checkpoint directory inside the repository, also through a symlink', async ({ tree }) => {
    const repo = await dirtyRepo(tree);
    expect(() =>
      takeCheckpoint({ root: repo, gate: 'G0', checkpointDir: join(repo, 'checkpoints'), env: GIT_ENV }),
    ).toThrow(/inside the repository/);

    symlinkSync(join(repo, 'untracked'), join(tree.root, 'sneaky'));
    expect(() =>
      takeCheckpoint({ root: repo, gate: 'G0', checkpointDir: join(tree.root, 'sneaky', 'cp'), env: GIT_ENV }),
    ).toThrow(/inside the repository/);
    expect(existsSync(join(repo, 'untracked', 'cp'))).toBe(false);
  });

  test('command line: reads COHORTE_CHECKPOINT_DIR, prints the directory, exits 2 without it', async ({ tree }) => {
    const repo = await dirtyRepo(tree);
    const script = join(REPO_ROOT, 'scripts/checkpoint.ts');
    const out = join(tree.root, 'checkpoints');
    const ok = spawnSync(process.execPath, [script, 'G0', '--root', repo], {
      encoding: 'utf8',
      env: { ...GIT_ENV, COHORTE_CHECKPOINT_DIR: out },
    });
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(out);
    expect(readdirSync(out)).toHaveLength(1);

    const missing = spawnSync(process.execPath, [script, 'G0', '--root', repo], { encoding: 'utf8', env: GIT_ENV });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('COHORTE_CHECKPOINT_DIR');
  });
});
