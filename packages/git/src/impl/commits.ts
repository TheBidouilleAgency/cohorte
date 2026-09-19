import { type CanonicalPath, GIT_DIFF_HARDENING_ARGS, type GitIdentity } from '../contract.ts';
import type { GitPortOptions } from './context.ts';
import { splitNul } from './nul-split.ts';
import { GitCommandError, runGit } from './runner.ts';
import { treeDigest } from './tree-digest.ts';

/** DESIGN 5.8: `treeDigest` at every Cohorte checkpoint (agent exit, commit, merge, ...) uses this default. */
export const DEFAULT_TREE_DIGEST_EXCLUDES: readonly string[] = Object.freeze(['.cohorte']);

function trailerBlock(trailers: Record<string, string>, coAuthoredBy: string | undefined): string {
  const lines = Object.entries(trailers).map(([key, value]) => `${key}: ${value}`);
  if (coAuthoredBy !== undefined) lines.push(`Co-authored-by: ${coAuthoredBy}`);
  return lines.join('\n');
}

function withTrailers(message: string, trailers: Record<string, string>, coAuthoredBy: string | undefined): string {
  const block = trailerBlock(trailers, coAuthoredBy);
  return block ? `${message}\n\n${block}\n` : `${message}\n`;
}

/** DESIGN 5.3: ownership audit, secret scan and the audit trail are the caller's job. `commitAll` only commits. */
export async function commitAll(
  req: {
    worktree: CanonicalPath;
    message: string;
    trailers: Record<string, string>;
    identity: GitIdentity;
    paths: string[];
  },
  ctx: GitPortOptions,
): Promise<{ sha: string; treeDigest: string } | { kind: 'nothing' }> {
  if (req.paths.length === 0) return { kind: 'nothing' };

  const run = (args: readonly string[], extra: { input?: string; allowExitCodes?: readonly number[] } = {}) =>
    runGit({
      gitBinary: ctx.gitBinary,
      path: ctx.path,
      cwd: req.worktree,
      args,
      timeoutMs: ctx.timeoutMs,
      identity: req.identity,
      ...extra,
    });

  await run(['add', '-A', '--', ...req.paths]);
  // `--quiet` reports "differences exist" as exit 1: content-idempotent by construction (E1-style: a second call
  // with the same content stages nothing new and diffs to nothing).
  const diff = await run(['diff', '--cached', ...GIT_DIFF_HARDENING_ARGS, '--quiet', '--', ...req.paths], {
    allowExitCodes: [1],
  });
  if (diff.exitCode === 0) return { kind: 'nothing' };

  // The pathspec on the COMMIT, not only on the `add`, is what makes 5.3 true: the commit holds exactly the audited
  // paths. Agents cannot commit, but `git add` is not in the built-in deny list of ADR-0007 §2, so the index may hold
  // foreign staged content; a bare `git commit` would sweep it into Cohorte's commit, unaudited and unscanned.
  await run(['commit', '-q', '-F', '-', '--', ...req.paths], {
    input: withTrailers(req.message, req.trailers, req.identity.coAuthoredBy),
  });
  const shaOut = await run(['rev-parse', 'HEAD']);
  const sha = shaOut.stdout.trim();
  const digest = await treeDigest(req.worktree, { exclude: [...DEFAULT_TREE_DIGEST_EXCLUDES] }, ctx);
  return { sha, treeDigest: digest };
}

const TRAILER_ENTRY_SEP = '\x01';
const TRAILER_VALUE_SEP = '%x02';

/** First commit of `branch` (most-recent-first, matching `git log`'s own order) whose `key` trailer equals `value`. */
export async function findCommitByTrailer(
  repo: CanonicalPath,
  branch: string,
  key: string,
  value: string,
  ctx: GitPortOptions,
): Promise<string | null> {
  let out: Awaited<ReturnType<typeof runGit>>;
  try {
    out = await runGit({
      gitBinary: ctx.gitBinary,
      path: ctx.path,
      cwd: repo,
      args: [
        'log',
        branch,
        '-z',
        `--format=%H${TRAILER_ENTRY_SEP}%(trailers:key=${key},valueonly,unfold,separator=${TRAILER_VALUE_SEP})`,
      ],
      timeoutMs: ctx.timeoutMs,
    });
  } catch (error) {
    // An empty/unborn branch: `git log` on it fails outright rather than printing nothing.
    if (error instanceof GitCommandError && /unknown revision|bad revision/i.test(error.stderr)) return null;
    throw error;
  }
  for (const entry of splitNul(out.stdout)) {
    const sep = entry.indexOf(TRAILER_ENTRY_SEP);
    if (sep === -1) continue;
    const sha = entry.slice(0, sep);
    const found = entry.slice(sep + 1);
    if (found === value) return sha;
  }
  return null;
}
