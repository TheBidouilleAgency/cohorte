import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { test as vitestTest } from 'vitest';
import { gitEnv } from '../git-env/index.ts';

const run = promisify(execFile);

const TEMP_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A fresh directory under the OS temp root, as a REAL path. On macOS the temp root sits behind a symlink
 * (/var -> /private/var) and git reports canonical paths, so a comparison with an un-canonicalised path fails.
 */
export async function makeTempDir(prefix = 'cohorte-'): Promise<string> {
  if (!TEMP_PREFIX.test(prefix)) throw new TypeError(`makeTempDir: invalid prefix ${JSON.stringify(prefix)}`);
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** `rm -rf`, but only ever STRICTLY below the OS temp root: a wrong variable in a test must not cost a checkout or a home. */
export async function removeTempDir(dir: string): Promise<void> {
  const target = await realpath(dir).catch(() => resolve(dir));
  const roots = [await realpath(tmpdir()), resolve(tmpdir())];
  if (!roots.some((root) => target.startsWith(root + sep))) {
    throw new Error(`removeTempDir: refusing to delete ${target}: not below the temp root ${roots[0]}`);
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

export interface TempRepo {
  /** Real path of the work tree. */
  readonly root: string;
  /** The throwaway HOME every command of this repository runs with. */
  readonly home: string;
  /** `gitEnv({ home })`: pass it to any process the test spawns itself. */
  readonly env: NodeJS.ProcessEnv;
  /** Runs `git <args>` in `root` (or `cwd`) with `env`. Rejects, stderr included, on a non-zero exit. */
  git(args: readonly string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>;
  /** Writes a file below `root`, creating its directories; returns its absolute path. */
  write(path: string, content: string | Uint8Array): Promise<string>;
  /** `git add -A` + commit; returns the new commit id. */
  commit(message: string, options?: { allowEmpty?: boolean }): Promise<string>;
  /** The commit id of HEAD. Rejects while the repository has no commit. */
  head(): Promise<string>;
}

export interface TempRepoOptions {
  /** A directory the caller owns and removes; never the real HOME. */
  home: string;
  /** Default `main`. */
  initialBranch?: string;
  /** Default true: one empty commit `initial`, because `git worktree add` and most plumbing need a HEAD. */
  initialCommit?: boolean;
}

/** `git init` in `dir` (created if missing) with the hermetic environment. The caller owns `dir` and `options.home`. */
export async function createTempRepo(dir: string, options: TempRepoOptions): Promise<TempRepo> {
  await mkdir(dir, { recursive: true });
  const root = await realpath(dir);
  const home = options.home;
  const env = gitEnv({ home });

  const git: TempRepo['git'] = async (args, gitOptions = {}) => {
    const { stdout, stderr } = await run('git', [...args], {
      cwd: gitOptions.cwd ?? root,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr };
  };
  const head: TempRepo['head'] = async () => (await git(['rev-parse', '--verify', 'HEAD'])).stdout.trim();

  const repo: TempRepo = {
    root,
    home,
    env,
    git,
    head,
    async write(path, content) {
      const target = resolve(root, path);
      if (path === '' || isAbsolute(path) || !target.startsWith(root + sep)) {
        throw new TypeError(`TempRepo.write: ${JSON.stringify(path)} is not a path below the repository`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return target;
    },
    async commit(message, commitOptions = {}) {
      await git(['add', '-A']);
      await git(['commit', '--quiet', ...(commitOptions.allowEmpty ? ['--allow-empty'] : []), '-m', message]);
      return head();
    },
  };

  await git(['init', '--quiet', `--initial-branch=${options.initialBranch ?? 'main'}`]);
  if (options.initialCommit ?? true) await repo.commit('initial', { allowEmpty: true });
  return repo;
}

const slug = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'test';

/**
 * vitest's `test`, extended with PER-TEST fixtures (DESIGN 7.0: never a shared mutable fixture — concurrent hooks
 * that share a `let root` delete each other's repository). Each test that names a fixture gets its own directory,
 * removed when the test ends. Use `test.for` for tables: `test.each` does not pass the fixture context.
 *
 *   tempDir   an empty directory (real path)
 *   tempHome  a throwaway HOME (real path), for anything that would otherwise touch ~/.cohorte or ~/.pi
 *   tempRepo  a git repository on `main` with one empty commit, whose HOME is `tempHome`
 *
 * Extend it further with `test.extend('name', async ({ tempRepo }, { onCleanup }) => ...)`.
 */
export const test = vitestTest
  .extend('tempDir', async ({ task }, { onCleanup }) => {
    const dir = await makeTempDir(`cohorte-${slug(task.name)}-`);
    onCleanup(() => removeTempDir(dir));
    return dir;
  })
  .extend('tempHome', async ({ task }, { onCleanup }) => {
    const dir = await makeTempDir(`cohorte-home-${slug(task.name)}-`);
    onCleanup(() => removeTempDir(dir));
    return dir;
  })
  .extend('tempRepo', async ({ task, tempHome }, { onCleanup }) => {
    const dir = await makeTempDir(`cohorte-repo-${slug(task.name)}-`);
    onCleanup(() => removeTempDir(dir));
    return createTempRepo(dir, { home: tempHome });
  });
