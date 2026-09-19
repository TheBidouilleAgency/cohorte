// Program resolution: `Node`, `./node`, a PATH-planted binary, a symlinked shim (DESIGN 2.6.4 step 1, EV-07).
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, describe, expect } from 'vitest';
import { createProgramResolver } from '../../../src/decide/commands/index.ts';

/** A per-test scratch directory (RULES §3 rule 9: `test.extend` fixtures, `realpath(mkdtemp())`, no shared state). */
const test = base.extend<{ scratch: string }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest reads the fixture's dependencies from this pattern
  scratch: async ({}, use) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-u1-03-')));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
});

function makeDir(scratch: string, ...segments: string[]): string {
  const dir = join(scratch, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeExecutable(path: string, contents = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

describe('createProgramResolver', () => {
  test('finds a program by bare name and returns its realpath', ({ scratch }) => {
    const binDir = makeDir(scratch, 'bin');
    makeExecutable(join(binDir, 'node'));

    const resolver = createProgramResolver({ pathDirs: [binDir] });
    expect(resolver.resolve('node')).toBe(realpathSync(join(binDir, 'node')));
  });

  test('"Node" (wrong case) does not resolve: the resolver does no case-folding of its own', () => {
    // The real host filesystem's case sensitivity varies (APFS is case-INSENSITIVE by default, so this cannot be
    // demonstrated portably against real files on disk): a fake `fs` proves the resolver itself never folds case
    // — it defers entirely to what `accessSync` says about the exact candidate path it built.
    const fs = {
      accessSync(path: string): void {
        if (!path.endsWith('/bin/node')) throw new Error('ENOENT');
      },
      realpathSync: (path: string): string => path,
    };
    const resolver = createProgramResolver({ pathDirs: ['/bin'], fs });
    expect(resolver.resolve('node')).toBe('/bin/node');
    expect(resolver.resolve('Node')).toBeUndefined();
  });

  test('"./node" (and any bareName carrying a path separator) never resolves: defence in depth', ({ scratch }) => {
    // `evaluate()` already rejects any argv[0] containing "/" BEFORE ever calling `programs.resolve`
    // (DESIGN 2.6.4 step 1). The resolver refuses it too, so that a caller which skipped that step still cannot
    // have `node:path.join` silently normalise `./node` or `../node` down to a real candidate.
    const binDir = makeDir(scratch, 'bin');
    makeExecutable(join(binDir, 'node'));

    const resolver = createProgramResolver({ pathDirs: [binDir] });
    expect(resolver.resolve('./node')).toBeUndefined();
    expect(resolver.resolve('../bin/node')).toBeUndefined();
  });

  test('a PATH-planted binary: whichever pinned directory comes first wins, exactly like the OS', ({ scratch }) => {
    const plantedDir = makeDir(scratch, 'planted');
    const realDir = makeDir(scratch, 'real');
    makeExecutable(join(plantedDir, 'node'), '#!/bin/sh\necho planted\n');
    makeExecutable(join(realDir, 'node'), '#!/bin/sh\necho real\n');

    // The pinned PATH lists `plantedDir` first: this is not something the resolver can defend against by itself
    // (I4/EV-07 protect against a repo-local shim or a directory OUTSIDE the pin, not against the pin's own
    // order) — it is the caller's job to pin a trustworthy PATH at run start.
    const resolver = createProgramResolver({ pathDirs: [plantedDir, realDir] });
    expect(resolver.resolve('node')).toBe(realpathSync(join(plantedDir, 'node')));
    expect(resolver.resolve('node')).not.toBe(realpathSync(join(realDir, 'node')));
  });

  test('a symlinked shim resolves to its REALPATH, never the raw symlink path', ({ scratch }) => {
    const binDir = makeDir(scratch, 'bin');
    const targetDir = makeDir(scratch, 'target');
    const target = join(targetDir, 'real-node');
    makeExecutable(target);
    symlinkSync(target, join(binDir, 'node'));

    const resolver = createProgramResolver({ pathDirs: [binDir] });
    const resolved = resolver.resolve('node');
    expect(resolved).toBe(realpathSync(target));
    expect(resolved).not.toBe(join(binDir, 'node'));
  });

  test('a repo-local shim never stands in: it is simply not in the pinned PATH', ({ scratch }) => {
    const worktreeBin = makeDir(scratch, 'worktree', 'node_modules', '.bin');
    const binDir = makeDir(scratch, 'bin');
    makeExecutable(join(worktreeBin, 'node'), '#!/bin/sh\necho shim\n');
    makeExecutable(join(binDir, 'node'), '#!/bin/sh\necho real\n');

    // The pinned PATH the caller supplies never includes a worktree-relative directory: it is a snapshot of the
    // run's real system PATH, taken at run start.
    const resolver = createProgramResolver({ pathDirs: [binDir] });
    expect(resolver.resolve('node')).toBe(realpathSync(join(binDir, 'node')));
  });

  test('memoises: a program removed after the first resolve() still resolves the same way', ({ scratch }) => {
    const binDir = makeDir(scratch, 'bin');
    makeExecutable(join(binDir, 'pnpm'));
    const resolver = createProgramResolver({ pathDirs: [binDir] });
    const first = resolver.resolve('pnpm');
    rmSync(join(binDir, 'pnpm'));
    expect(resolver.resolve('pnpm')).toBe(first);
  });

  test('an unresolvable name resolves to undefined', ({ scratch }) => {
    const binDir = makeDir(scratch, 'bin');
    const resolver = createProgramResolver({ pathDirs: [binDir] });
    expect(resolver.resolve('does-not-exist')).toBeUndefined();
  });
});
