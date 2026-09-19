import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { afterAll, describe, expect } from 'vitest';
import { createTempRepo, GIT_ENV_VARS, makeTempDir, removeTempDir, test } from '../../src/index.ts';

describe('makeTempDir', () => {
  test('returns a real path: on macOS /tmp is a symlink and git reports canonical paths', async () => {
    const dir = await makeTempDir('cohorte-probe-');
    try {
      expect(isAbsolute(dir)).toBe(true);
      expect(await realpath(dir)).toBe(dir);
      expect(dir.startsWith(`${await realpath(tmpdir())}${sep}cohorte-probe-`)).toBe(true);
    } finally {
      await removeTempDir(dir);
    }
    expect(existsSync(dir)).toBe(false);
  });

  test.for(['', 'a/b', '../x', '..'])('refuses the prefix %j', async (prefix) => {
    await expect(makeTempDir(prefix)).rejects.toThrow(TypeError);
  });
});

describe('removeTempDir', () => {
  test('only ever deletes below the temp root', async ({ tempDir }) => {
    await expect(removeTempDir(homedir())).rejects.toThrow(/refus/i);
    await expect(removeTempDir(await realpath(tmpdir()))).rejects.toThrow(/refus/i);
    await expect(removeTempDir(process.cwd())).rejects.toThrow(/refus/i);
    await expect(removeTempDir(join(tempDir, '..', '..', '..'))).rejects.toThrow(/refus/i);
    expect(existsSync(tempDir)).toBe(true);
  });

  test('is idempotent', async () => {
    const dir = await makeTempDir();
    await removeTempDir(dir);
    await removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('fixtures', () => {
  const seen: string[] = [];
  afterAll(() => {
    expect(seen.length).toBeGreaterThan(0);
    for (const dir of seen) expect(existsSync(dir), `${dir} should have been removed`).toBe(false);
  });

  test('tempDir is an empty, realpath’d directory removed after the test', async ({ tempDir }) => {
    seen.push(tempDir);
    expect(await realpath(tempDir)).toBe(tempDir);
    await writeFile(join(tempDir, 'probe'), 'x');
    expect(existsSync(join(tempDir, 'probe'))).toBe(true);
  });

  test('tempHome is a throwaway HOME, never the real one', async ({ tempHome }) => {
    seen.push(tempHome);
    expect(await realpath(tempHome)).toBe(tempHome);
    expect(tempHome).not.toBe(homedir());
    expect(tempHome.startsWith(homedir() + sep)).toBe(false);
  });

  test('tempRepo is a git repository on `main` with one commit, a throwaway HOME and a hermetic env', async ({
    tempRepo,
    tempHome,
  }) => {
    seen.push(tempRepo.root, tempRepo.home);
    expect(await realpath(tempRepo.root)).toBe(tempRepo.root);
    expect(tempRepo.home).toBe(tempHome);
    expect(tempRepo.env).toMatchObject({ ...GIT_ENV_VARS, HOME: tempHome, XDG_CONFIG_HOME: join(tempHome, '.config') });

    // git reports the canonical path: the comparison only holds because root went through realpath.
    expect((await tempRepo.git(['rev-parse', '--show-toplevel'])).stdout.trim()).toBe(tempRepo.root);
    expect((await tempRepo.git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('main');
    expect((await tempRepo.git(['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('1');
    expect((await tempRepo.git(['status', '--porcelain=v2'])).stdout).toBe('');
    expect(await tempRepo.head()).toMatch(/^[0-9a-f]{40}$/);
  });

  test('write + commit', async ({ tempRepo }) => {
    const file = await tempRepo.write('src/deep/a.txt', 'hello\n');
    expect(file).toBe(join(tempRepo.root, 'src', 'deep', 'a.txt'));
    expect(await readFile(file, 'utf8')).toBe('hello\n');
    const before = await tempRepo.head();
    const sha = await tempRepo.commit('add a');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe(before);
    expect(await tempRepo.head()).toBe(sha);
    expect((await tempRepo.git(['log', '-1', '--format=%an <%ae>|%s'])).stdout.trim()).toBe(
      't <t@example.invalid>|add a',
    );
    expect((await tempRepo.git(['status', '--porcelain=v2'])).stdout).toBe('');
  });

  test.for(['/etc/passwd', '../outside.txt', 'a/../../outside.txt', ''])(
    'write refuses the path %j',
    async (path, { tempRepo }) => {
      await expect(tempRepo.write(path, 'x')).rejects.toThrow(TypeError);
    },
  );

  test('a failing git command rejects with its stderr', async ({ tempRepo }) => {
    await expect(tempRepo.git(['rev-parse', '--verify', 'refs/heads/nope'])).rejects.toThrow(
      /nope|Needed a single revision/,
    );
  });

  test('global config is not read, even though HOME holds a planted canary', async ({ tempRepo }) => {
    await mkdir(join(tempRepo.home, '.config', 'git'), { recursive: true });
    await writeFile(
      join(tempRepo.home, '.gitconfig'),
      '[canary]\n\tvalue = PLANTED\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = /nonexistent/hooks\n',
    );
    await writeFile(join(tempRepo.home, '.config', 'git', 'config'), '[canary]\n\txdg = PLANTED\n');
    await writeFile(join(tempRepo.home, '.config', 'git', 'ignore'), '*.ignored-by-user\n');

    const { stdout } = await tempRepo.git(['config', '--list', '--show-origin']);
    expect(stdout).not.toContain('PLANTED');
    expect(stdout).not.toContain('gpgsign=true');

    // A commit still works (gpgsign=true with no key would fail it).
    await tempRepo.write('b.txt', 'b');
    await expect(tempRepo.commit('unsigned')).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  test('createTempRepo can leave the repository without any commit', async ({ tempDir, tempHome }) => {
    const repo = await createTempRepo(join(tempDir, 'bare-start'), {
      home: tempHome,
      initialCommit: false,
      initialBranch: 'trunk',
    });
    expect((await repo.git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('trunk');
    await expect(repo.head()).rejects.toThrow();
  });
});

describe.concurrent('concurrent tests do not share state', () => {
  const roots = new Set<string>();
  const homes = new Set<string>();

  test.for([1, 2, 3, 4, 5, 6, 7, 8])('worker %i sees only its own repository', async (n, { tempRepo, tempDir }) => {
    roots.add(tempRepo.root);
    homes.add(tempRepo.home);
    expect(tempDir).not.toBe(tempRepo.root);

    await tempRepo.write(`only-${n}.txt`, String(n));
    await writeFile(join(tempDir, `dir-${n}`), String(n));
    // Let the siblings interleave: a shared fixture would show their files here.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await tempRepo.commit(`worker ${n}`);

    const files = (await tempRepo.git(['ls-files'])).stdout.trim().split('\n');
    expect(files).toEqual([`only-${n}.txt`]);
    expect((await tempRepo.git(['log', '--format=%s'])).stdout.trim().split('\n')).toEqual([`worker ${n}`, 'initial']);
    expect((await tempRepo.git(['worktree', 'list', '--porcelain'])).stdout).toContain(`worktree ${tempRepo.root}\n`);
  });

  afterAll(() => {
    expect(roots.size).toBe(8);
    expect(homes.size).toBe(8);
    for (const dir of [...roots, ...homes]) expect(existsSync(dir)).toBe(false);
  });
});
