// DESIGN 5.8 — V2's content-addressed digest, ported verbatim. Computed in a THROWAWAY copy of the index so the
// real index (and its stat cache) is never touched: git's own git-status/commit machinery on the real worktree is
// unaffected by a digest computation (test E9).
import { copyFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalPath } from '../contract.ts';
import type { GitPortOptions } from './context.ts';
import { runGit } from './runner.ts';

const RACY_WINDOW_S = 5;

export interface TreeDigestOptions {
  exclude: string[];
}

export async function treeDigest(
  worktree: CanonicalPath,
  options: TreeDigestOptions,
  ctx: GitPortOptions,
): Promise<string> {
  const run = (args: readonly string[], extraEnv: Readonly<Record<string, string>>) =>
    runGit({ gitBinary: ctx.gitBinary, path: ctx.path, cwd: worktree, args, timeoutMs: ctx.timeoutMs, extraEnv });

  const realIndexOut = await run(['rev-parse', '--path-format=absolute', '--git-path', 'index'], {});
  const realIndexPath = realIndexOut.stdout.trim();

  const tempDir = await mkdtemp(join(tmpdir(), 'cohorte-idx-'));
  const tempIndex = join(tempDir, 'index');
  try {
    // Keeps the stat cache (fast path for unchanged files), so only backdating — not a blank index — defeats racy-git.
    // A worktree whose index was never written has no index file at all (`git init` does not create one), and a
    // digest may legitimately be taken there: git creates the temp index itself from `add -A`, which is the correct
    // empty-tree semantics. Any other fs error is a real failure and must surface (5.8: "cannot compute" = not fresh).
    const copied = await copyFile(realIndexPath, tempIndex).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      },
    );
    if (copied) {
      const backdated = new Date(Date.now() - RACY_WINDOW_S * 1000);
      await utimes(tempIndex, backdated, backdated);
    }

    const env = { GIT_INDEX_FILE: tempIndex };
    if (options.exclude.length > 0) {
      await run(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...options.exclude], env);
    }
    const excludePathspecs = options.exclude.map((path) => `:(exclude)${path}`);
    await run(['add', '-A', '--', '.', ...excludePathspecs], env);
    const writeOut = await run(['write-tree'], env);
    return writeOut.stdout.trim();
  } finally {
    // Removes the temp index AND any stray `<tempIndex>.lock` git may have left behind on a failed step.
    await rm(tempDir, { recursive: true, force: true });
  }
}
