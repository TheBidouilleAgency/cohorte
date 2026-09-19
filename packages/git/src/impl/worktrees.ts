import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { type CanonicalPath, GIT_PORCELAIN_ARGS } from '../contract.ts';
import type { GitPortOptions } from './context.ts';
import { splitNul } from './nul-split.ts';
import { runGit } from './runner.ts';

const WORKTREE_PREFIX = 'worktree ';

// `git worktree add` reads and writes the shared `.git/worktrees/` administrative area (duplicate-branch checks,
// a fresh per-worktree admin directory). Two concurrent `add`s on the SAME repo can observe each other's
// half-written admin state and fail outright (`failed to read .git/worktrees/<x>/commondir`) — reproduced on this
// toolchain. Every writing agent's worktree is normally provisioned at once at run start, so this is not a rare
// path: serialize `add` per repo, in-process, rather than let the run's own parallelism corrupt itself.
//
// IN-PROCESS ONLY, and deliberately so: DESIGN 5.6 takes the `project` lock SHARED, so two host processes may run
// on one repository at the same time. Their `add`s are serialised by the caller's `project` / `integration` lease
// (5.6), never by this Map, which one host process holds against itself alone.
const addWorktreeQueues = new Map<string, Promise<unknown>>();

function serializedPerRepo<T>(repo: string, task: () => Promise<T>): Promise<T> {
  const previous = addWorktreeQueues.get(repo) ?? Promise.resolve();
  const settled = previous.catch(() => undefined);
  const run = settled.then(task);
  addWorktreeQueues.set(
    repo,
    run.catch(() => undefined),
  );
  return run;
}

async function listWorktreePaths(anyWorktreeOfTheRepo: string, ctx: GitPortOptions): Promise<string[]> {
  const out = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: anyWorktreeOfTheRepo,
    args: ['worktree', 'list', '--porcelain', '-z'],
    timeoutMs: ctx.timeoutMs,
  });
  const paths: string[] = [];
  for (const line of splitNul(out.stdout)) {
    if (line.startsWith(WORKTREE_PREFIX)) paths.push(line.slice(WORKTREE_PREFIX.length));
  }
  return paths;
}

export async function addWorktree(
  req: { repo: CanonicalPath; path: CanonicalPath; branch: string | null; commit: string },
  ctx: GitPortOptions,
): Promise<void> {
  const args: string[] =
    req.branch === null
      ? ['worktree', 'add', '--detach', req.path, req.commit]
      : ['worktree', 'add', '-b', req.branch, req.path, req.commit];
  await serializedPerRepo(req.repo, () =>
    runGit({ gitBinary: ctx.gitBinary, path: ctx.path, cwd: req.repo, args, timeoutMs: ctx.timeoutMs }),
  );
}

/** A slot still holds the previous agent's uncommitted or untracked work: {@link switchToNewBranch} refuses it. */
export class WorktreeDirtyError extends Error {
  readonly worktree: string;

  constructor(worktree: string) {
    super(
      `switchToNewBranch: ${worktree} is dirty — the previous agent's uncommitted or untracked work would be ` +
        `carried onto the new branch; commit it or quarantine the slot (resetHardClean) first`,
    );
    this.name = 'WorktreeDirtyError';
    this.worktree = worktree;
  }
}

/**
 * Slot reuse: a fresh branch for the worktree's next agent, at the current integration head.
 *
 * REFUSES a dirty slot. `git checkout -b` keeps uncommitted and untracked files across the switch, so the incoming
 * agent would start on work it never did — and the next `commitAll` would attribute it to that agent, past an
 * ownership audit (5.3 b) that only notices when the leftover happens to fall outside its write globs. DESIGN 5.2 /
 * ADR-0021 §3 place the branch AT `at`; the decision to discard the leftovers is the caller's (`resetHardClean`),
 * never this method's.
 */
export async function switchToNewBranch(
  req: { worktree: CanonicalPath; branch: string; at: string },
  ctx: GitPortOptions,
): Promise<void> {
  if (await isDirty(req.worktree, ctx)) throw new WorktreeDirtyError(req.worktree);
  await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: req.worktree,
    args: ['checkout', '-q', '-b', req.branch, req.at],
    timeoutMs: ctx.timeoutMs,
  });
}

async function isDirty(worktree: CanonicalPath, ctx: GitPortOptions): Promise<boolean> {
  const status = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: worktree,
    args: ['status', ...GIT_PORCELAIN_ARGS, '--untracked-files=all'],
    timeoutMs: ctx.timeoutMs,
  });
  return status.stdout.length > 0;
}

/** `opts.force` is always `false` (the type says so): DESIGN 5 never lets Cohorte discard an agent's own work here. */
export async function removeWorktree(
  path: CanonicalPath,
  _opts: { force: false },
  ctx: GitPortOptions,
): Promise<'removed' | 'dirty-kept'> {
  if (await isDirty(path, ctx)) return 'dirty-kept';
  try {
    await runGit({
      gitBinary: ctx.gitBinary,
      path: ctx.path,
      cwd: path,
      args: ['worktree', 'remove', '--', path],
      timeoutMs: ctx.timeoutMs,
    });
    return 'removed';
  } catch (error) {
    // A race between the check above and the remove itself: re-check rather than trust git's error text.
    if (await isDirty(path, ctx)) return 'dirty-kept';
    throw error;
  }
}

/**
 * Quarantine path only (DESIGN 5.1, ADR-0021 §1), the ONE destructive method of this port. Three guards, in order:
 *
 * 1. the canonicalised target must resolve under the canonicalised `git.worktreeRoot` — the root Cohorte itself
 *    provisions. Without it "a registered worktree" is self-referential (`git worktree list` is run from the
 *    target, so the target is in its own list by construction) and ANY linked worktree of ANY repository on the
 *    machine would be accepted, uncommitted user work included. Compared at a path SEPARATOR, never as a bare
 *    string prefix: `<root>-evil` is not below `<root>`.
 * 2. it must be a registered worktree of its repository (a directory git does not know is never touched);
 * 3. it must not be the main worktree (always the first entry of `git worktree list`, per git's documented
 *    ordering), which shares the same history but is the user's own checkout.
 */
export async function resetHardClean(worktree: CanonicalPath, to: string, ctx: GitPortOptions): Promise<void> {
  const target = await realpath(worktree);
  const root = await realpath(ctx.worktreeRoot).catch(() => {
    throw new Error(`resetHardClean: the configured worktree root ${ctx.worktreeRoot} does not resolve on disk`);
  });
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`resetHardClean: refuses ${target}, which is outside the worktree root ${root}`);
  }

  const registered = await listWorktreePaths(worktree, ctx).catch(() => {
    throw new Error(`resetHardClean: ${target} is not a registered worktree of its repository`);
  });
  const resolved = await Promise.all(registered.map((candidate) => realpath(candidate).catch(() => candidate)));
  const position = resolved.indexOf(target);
  if (position === -1) {
    throw new Error(`resetHardClean: ${target} is not a registered worktree of its repository`);
  }
  if (position === 0) {
    throw new Error(`resetHardClean: refuses to operate on ${target}, the main worktree`);
  }

  await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: target,
    args: ['reset', '--hard', to],
    timeoutMs: ctx.timeoutMs,
  });
  await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: target,
    args: ['clean', '-fdx', '--'],
    timeoutMs: ctx.timeoutMs,
  });
}
