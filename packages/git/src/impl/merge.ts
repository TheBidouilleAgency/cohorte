// DESIGN 5.4/5.5, ADR-0008 — plumbing merge: `merge-tree --write-tree` (no working tree) -> `commit-tree` ->
// `update-ref` compare-and-swap. No hook ever runs (5.0's hardened config args cover every call here too).
import type { CanonicalPath } from '../contract.ts';
import type { GitPortOptions } from './context.ts';
import { splitNul } from './nul-split.ts';
import { GitCommandError, runGit } from './runner.ts';

export async function mergeTree(
  repo: CanonicalPath,
  ours: string,
  theirs: string,
  ctx: GitPortOptions,
): Promise<{ clean: true; tree: string } | { clean: false; files: string[] }> {
  const out = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: repo,
    args: ['merge-tree', '--write-tree', '--name-only', '-z', ours, theirs],
    timeoutMs: ctx.timeoutMs,
    allowExitCodes: [1],
  });
  const fields = splitNul(out.stdout);
  const tree = fields[0];
  if (tree === undefined) throw new Error('mergeTree: git produced no output');
  if (out.exitCode === 0) return { clean: true, tree };

  // `--name-only -z`: OID, then the conflicted paths, NUL-terminated, ending with one empty field before the
  // informational messages (Auto-merging / CONFLICT lines) we do not need here.
  const files: string[] = [];
  for (let index = 1; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === '') break;
    files.push(field);
  }
  return { clean: false, files };
}

export async function commitTree(
  repo: CanonicalPath,
  tree: string,
  parents: string[],
  message: string,
  trailers: Record<string, string>,
  ctx: GitPortOptions,
): Promise<string> {
  const block = Object.entries(trailers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  const fullMessage = block ? `${message}\n\n${block}\n` : `${message}\n`;
  // `commit-tree` reads its message from stdin when neither -m nor -F is given.
  const args = ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])];
  const out = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: repo,
    args,
    timeoutMs: ctx.timeoutMs,
    identity: ctx.mergeIdentity,
    input: fullMessage,
  });
  return out.stdout.trim();
}

/**
 * The three messages git produces for a LOST compare-and-swap, and nothing else. Measured on git 2.50.1:
 *   - `cannot lock ref '<r>': reference already exists`                      (empty oldvalue, the ref is there)
 *   - `cannot lock ref '<r>': is at <sha> but expected <sha>`                (oldvalue no longer current)
 *   - `cannot lock ref '<r>': unable to resolve reference '<r>'`             (oldvalue given, the ref is gone)
 * Plain lock-file contention (`cannot lock ref '<r>': Unable to create '<r>.lock': File exists.`) shares the
 * `cannot lock ref` prefix but is NOT a CAS loss: DESIGN 5.4 step (1) turns a `moved` into
 * `unexpected-repo-change`, so reporting contention as `moved` would tell the human the repository changed under
 * the run. It stays a `GitCommandError`, which the caller can retry.
 */
const CAS_LOST =
  /cannot lock ref .*(?:reference already exists|is at [0-9a-f]+ but expected|unable to resolve reference)/i;

/** Atomic compare-and-swap. `expectedOld: null` means "the ref must not already exist" (git's empty-oldvalue rule). */
export async function updateRefCas(
  repo: CanonicalPath,
  ref: string,
  next: string,
  expectedOld: string | null,
  ctx: GitPortOptions,
): Promise<'ok' | 'moved'> {
  try {
    await runGit({
      gitBinary: ctx.gitBinary,
      path: ctx.path,
      cwd: repo,
      args: ['update-ref', ref, next, expectedOld ?? ''],
      timeoutMs: ctx.timeoutMs,
    });
    return 'ok';
  } catch (error) {
    if (error instanceof GitCommandError && CAS_LOST.test(error.stderr)) return 'moved';
    throw error;
  }
}

/** `refs/cohorte/<runId>/review/<n>` — never updated during the run (DESIGN 5.5): minted once, CAS-created. */
export async function createRef(repo: CanonicalPath, ref: string, sha: string, ctx: GitPortOptions): Promise<void> {
  const result = await updateRefCas(repo, ref, sha, null, ctx);
  if (result === 'moved') throw new Error(`createRef: ${ref} already exists in ${repo}`);
}
