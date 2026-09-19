import type { SurfaceId } from '@cohorte/base';
import {
  type ArtifactDraft,
  type CanonicalPath,
  type FileTouch,
  GIT_DIFF_HARDENING_ARGS,
  GIT_PORCELAIN_ARGS,
  type SurfaceMap,
} from '../contract.ts';
import type { GitPortOptions } from './context.ts';
import { splitNul } from './nul-split.ts';
import { runGit } from './runner.ts';

/**
 * Splits a porcelain v2 `-z` line into its first `count` single-space-separated fields, plus the remainder as one
 * last element (the path, which under `-z` is neither quoted nor escaped and may itself contain spaces).
 */
function splitFixed(line: string, count: number): string[] {
  const fields: string[] = [];
  let rest = line;
  for (let index = 0; index < count; index += 1) {
    const spaceIndex = rest.indexOf(' ');
    if (spaceIndex === -1) {
      fields.push(rest);
      rest = '';
      continue;
    }
    fields.push(rest.slice(0, spaceIndex));
    rest = rest.slice(spaceIndex + 1);
  }
  fields.push(rest);
  return fields;
}

function opOfXY(xy: string): 'create' | 'modify' | 'delete' {
  if (xy.includes('A')) return 'create';
  if (xy.includes('D')) return 'delete';
  return 'modify';
}

/**
 * `git status --porcelain=v2 -z`, exact parsing (DESIGN 5): every changed, untracked-but-not-ignored path.
 *
 * No `--ignore-submodules`: its default value is `all`, which would hide every submodule change (pointer move,
 * dirty submodule worktree) from the ownership audit of DESIGN 5.3 (b) and 5.4 (2) — a write into a submodule
 * would pass both enforcements unseen. Submodule entries are ordinary porcelain-v2 `1`/`2` records (the `<sub>`
 * field this parser skips at position 2), and `isDirty` agrees: the two status calls of this package see the same
 * set of changes.
 */
export async function changedPaths(worktree: CanonicalPath, ctx: GitPortOptions): Promise<FileTouch[]> {
  const out = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: worktree,
    args: ['status', ...GIT_PORCELAIN_ARGS, '--untracked-files=all'],
    timeoutMs: ctx.timeoutMs,
  });
  const lines = splitNul(out.stdout);
  const touches: FileTouch[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    index += 1;
    if (line === '') continue;
    const kind = line.charAt(0);
    if (kind === '1') {
      const fields = splitFixed(line, 8);
      touches.push({ path: fields[8] ?? '', op: opOfXY(fields[1] ?? '') });
    } else if (kind === '2') {
      // Renamed/copied: the `-z` new-path field is followed by one MORE NUL-terminated field, the origin path.
      const fields = splitFixed(line, 9);
      const origPath = lines[index] ?? '';
      index += 1;
      touches.push({ path: origPath, op: 'delete' });
      touches.push({ path: fields[9] ?? '', op: 'create' });
    } else if (kind === 'u') {
      const fields = splitFixed(line, 10);
      touches.push({ path: fields[10] ?? '', op: 'modify' });
    } else if (kind === '?') {
      touches.push({ path: line.slice(2), op: 'create' });
    }
    // '!' (ignored) is never emitted: `--ignored` is not passed, so git never reports one.
  }
  return touches;
}

export async function diffBySurface(
  req: { repo: CanonicalPath; base: string; head: string; surfaces: SurfaceMap },
  ctx: GitPortOptions,
): Promise<{ surface: SurfaceId | 'shared'; files: string[]; patch: ArtifactDraft }[]> {
  const nameStatusOut = await runGit({
    gitBinary: ctx.gitBinary,
    path: ctx.path,
    cwd: req.repo,
    args: ['diff', ...GIT_DIFF_HARDENING_ARGS, '--name-status', '-z', req.base, req.head],
    timeoutMs: ctx.timeoutMs,
  });
  const fields = splitNul(nameStatusOut.stdout);
  const bySurface = new Map<SurfaceId | 'shared', string[]>();
  const addPath = (path: string): void => {
    const surface = req.surfaces.surfaceOf(path);
    const bucket = bySurface.get(surface);
    if (bucket) bucket.push(path);
    else bySurface.set(surface, [path]);
  };
  let index = 0;
  while (index < fields.length) {
    const status = fields[index] ?? '';
    index += 1;
    if (status === '') continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      addPath(fields[index] ?? '');
      index += 1;
      addPath(fields[index] ?? '');
      index += 1;
    } else {
      addPath(fields[index] ?? '');
      index += 1;
    }
  }

  const results: { surface: SurfaceId | 'shared'; files: string[]; patch: ArtifactDraft }[] = [];
  for (const [surface, files] of bySurface) {
    const patchOut = await runGit({
      gitBinary: ctx.gitBinary,
      path: ctx.path,
      cwd: req.repo,
      args: ['diff', ...GIT_DIFF_HARDENING_ARGS, req.base, req.head, '--', ...files],
      timeoutMs: ctx.timeoutMs,
      binary: true,
    });
    results.push({
      surface,
      files,
      patch: { kind: 'diff', mediaType: 'text/x-diff', bytes: patchOut.stdoutBytes ?? new Uint8Array() },
    });
  }
  return results;
}
