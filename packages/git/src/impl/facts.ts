import { realpath } from 'node:fs/promises';
import { type CanonicalPath, MIN_GIT_VERSION, type RepoFacts } from '../contract.ts';
import type { GitPortOptions } from './context.ts';
import { splitNul } from './nul-split.ts';
import { runGit } from './runner.ts';
import { isAtLeast, parseGitVersion } from './version.ts';

const canonical = async (path: string): Promise<CanonicalPath> => (await realpath(path)) as CanonicalPath;

/**
 * `git worktree list` keeps reporting a linked worktree until `git worktree prune` runs, so its directory may be
 * gone (user cleanup, a crashed run, gc mid-flight — DESIGN 5.9). `facts` is what resume, doctor and MergeService
 * call to discover a run's worktrees: one stale entry must not make the whole repository unreadable, so an
 * unresolvable path is reported as git itself reports it (same rule as `resetHardClean`).
 */
const canonicalOrAsReported = async (path: string): Promise<CanonicalPath> =>
  (await realpath(path).catch(() => path)) as CanonicalPath;

interface WorktreeBlock {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
}

/** In order: the local branch names a repository's default is expected to carry when no remote records one. */
const LOCAL_DEFAULT_BRANCHES: readonly string[] = Object.freeze(['main', 'master']);

const WORKTREE_PREFIX = 'worktree ';
const HEAD_PREFIX = 'HEAD ';
const BRANCH_PREFIX = 'branch refs/heads/';

/** `git worktree list --porcelain -z`: blocks are consecutive non-empty lines, separated by an empty line. */
function parseWorktreeList(raw: string): WorktreeBlock[] {
  const blocks: WorktreeBlock[] = [];
  let current: WorktreeBlock | null = null;
  for (const line of splitNul(raw)) {
    if (line === '') {
      current = null;
      continue;
    }
    if (line.startsWith(WORKTREE_PREFIX)) {
      current = {
        path: line.slice(WORKTREE_PREFIX.length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
      };
      blocks.push(current);
      continue;
    }
    if (!current) continue; // a line before any `worktree ` header: malformed input, defensively ignored
    if (line.startsWith(HEAD_PREFIX)) current.head = line.slice(HEAD_PREFIX.length);
    else if (line.startsWith(BRANCH_PREFIX)) current.branch = line.slice(BRANCH_PREFIX.length);
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
  }
  return blocks;
}

/** `facts` (DESIGN 5): version, default branch, HEAD kind, every worktree — one call, read-only. */
export async function facts(repo: CanonicalPath, ctx: GitPortOptions): Promise<RepoFacts> {
  const run = (args: readonly string[]) =>
    runGit({
      gitBinary: ctx.gitBinary,
      path: ctx.path,
      cwd: repo,
      args,
      timeoutMs: ctx.timeoutMs,
      allowExitCodes: [1],
    });

  const versionOut = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: repo,
    args: ['--version'],
    timeoutMs: ctx.timeoutMs,
  });
  const version = parseGitVersion(versionOut.stdout);
  const supported = isAtLeast(version, MIN_GIT_VERSION);

  const commonDirOut = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: repo,
    args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    timeoutMs: ctx.timeoutMs,
  });
  const commonDir = await canonical(commonDirOut.stdout.trim());

  let head: RepoFacts['head'];
  const headSha = await run(['rev-parse', '--verify', '-q', 'HEAD']);
  if (headSha.exitCode !== 0) {
    head = { kind: 'unborn' };
  } else {
    const sha = headSha.stdout.trim();
    const symbolic = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    head = symbolic.exitCode === 0 ? { kind: 'branch', name: symbolic.stdout.trim(), sha } : { kind: 'detached', sha };
  }

  /**
   * DESIGN 5.1: "Base = `origin/<default>` when it verifies, else local `<default>`". `refs/remotes/origin/HEAD`
   * is written by `clone` (not `--single-branch`) and by an explicit `remote set-head`, and by nothing else — not
   * by `remote add` + `push -u`, and never in a local-only repository. The local fallback is therefore the common
   * case, not the exception, and `config --get init.defaultBranch` cannot serve as one: 5.0 runs git with
   * `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1`, and that key is in practice a global setting.
   * `null` is left for a repository that has neither a conventional default branch nor a branch checked out.
   */
  let defaultBranch: string | null = null;
  const originHead = await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead.exitCode === 0) {
    const short = originHead.stdout.trim();
    defaultBranch = short.startsWith('origin/') ? short.slice('origin/'.length) : short || null;
  }
  if (defaultBranch === null) {
    for (const candidate of LOCAL_DEFAULT_BRANCHES) {
      const verified = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      if (verified.exitCode === 0) {
        defaultBranch = candidate;
        break;
      }
    }
  }
  if (defaultBranch === null && head.kind === 'branch') defaultBranch = head.name;

  const listOut = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: repo,
    args: ['worktree', 'list', '--porcelain', '-z'],
    timeoutMs: ctx.timeoutMs,
  });
  const blocks = parseWorktreeList(listOut.stdout);
  const worktrees = await Promise.all(
    blocks.map(async (block) => ({
      path: await canonicalOrAsReported(block.path),
      branch: block.detached || block.bare ? null : block.branch,
      head: block.head,
      locked: block.locked,
    })),
  );

  return { gitVersion: version.raw, supported, commonDir, defaultBranch, head, worktrees };
}
