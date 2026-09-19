// DESIGN 2.6.3 step 7 / 2.6.1 `GlobMatcher`. The semantics table below is the verified probe of
// `<SCRATCH>/understand/toolchain.md` §7 (`schema-probe/glob.mjs`), re-proved here against the shipped matcher.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { GlobSet } from '../../../src/contract/index.ts';
import { createGlobMatcher } from '../../../src/decide/paths/index.ts';
import { emptySet, grantOf, setOf } from './helpers.ts';

describe('createGlobMatcher — matches (glob semantics table)', () => {
  const matcher = createGlobMatcher();

  test.for<[pattern: string, path: string, expected: boolean]>([
    ['src/backend/**', 'src/backend/auth/login.ts', true],
    ['src/backend/**', 'src/backend', true], // a trailing double-star matches the bare directory itself
    ['src/backend/**', 'src/backend/.env', true], // dot:true
    ['src/backend/**', 'src/backend-evil/x.ts', false], // SEGMENT containment, not a string prefix (S-11 shape)
    ['src/backend/**', 'src/backend/../../etc/passwd', false],
    ['SRC/backend/**', 'src/backend/a.ts', false], // case-sensitive: nocase is false
  ])('%s vs %s => %s', ([pattern, path, expected]) => {
    expect(matcher.matches(path, setOf([pattern]))).toBe(expected);
  });

  test('a slash-less pattern means "at any depth", gitignore-style', () => {
    // The spec's own example (`.env*`, root-anchored as written) is unsafe: it would miss `config/.env`.
    const set = setOf(['.env*']);
    expect(matcher.matches('.env', set)).toBe(true);
    expect(matcher.matches('config/.env', set)).toBe(true);
    expect(matcher.matches('config/env.txt', set)).toBe(false);
  });

  test('a pattern that already contains a slash is used exactly as written (no any-depth rewrite)', () => {
    const set = setOf(['config/.env']);
    expect(matcher.matches('config/.env', set)).toBe(true);
    expect(matcher.matches('nested/config/.env', set)).toBe(false);
  });

  test('exclude re-includes what include denied, for the SAME GlobSet', () => {
    const set = setOf(['**/*.log'], ['debug.log']);
    expect(matcher.matches('app.log', set)).toBe(true);
    expect(matcher.matches('debug.log', set)).toBe(false);
  });

  test('an empty include list matches nothing (not everything)', () => {
    expect(matcher.matches('anything.txt', emptySet())).toBe(false);
  });

  test('the same GlobSet object, and an equal freshly-built one, keep identical semantics once compiled', () => {
    // The compiled predicate is memoized (per GlobSet object and per pattern list); the cache must not change
    // an answer, and must not leak between two sets that share an `include` but differ in `exclude`.
    const set = setOf(['**/*.log'], ['debug.log']);
    expect(matcher.matches('debug.log', set)).toBe(false);
    expect(matcher.matches('debug.log', setOf(['**/*.log']))).toBe(true);
    expect(matcher.matches('debug.log', set)).toBe(false);
    expect(matcher.matches('debug.log', setOf(['**/*.log'], ['debug.log']))).toBe(false);
  });
});

describe('createGlobMatcher — isDenied', () => {
  const matcher = createGlobMatcher();

  test('reads the allow and deny sets that match the given intent, not the other pair', () => {
    const g = grantOf({
      read: setOf(['**/*']),
      write: setOf(['**/*']),
      denyRead: setOf(['**/.env*']),
      denyWrite: setOf(['**/*.lock']),
    });
    expect(matcher.isDenied('.env', g, 'read')).toBe(true);
    expect(matcher.isDenied('.env', g, 'write')).toBe(false);
    expect(matcher.isDenied('pnpm.lock', g, 'write')).toBe(true);
    expect(matcher.isDenied('pnpm.lock', g, 'read')).toBe(false);
  });

  // The whole of step 7 in one call, deny sets FIRST: that is why the contract takes an `AgentGrant` and not a
  // `GlobSet`. A path no allow pattern matches is denied too — fail closed (I2), and the ownership boundary of
  // I11 must hold in tool OUTPUT filtering (`search`, `list_files`, `git_diff`), where no allow stage runs.
  test.for<[label: string, path: string, expected: boolean]>([
    ['deny beats allow: matched by BOTH read.include and denyRead.include', 'src/backend/.env', true],
    ['allowed only: matched by read.include alone', 'src/backend/auth.ts', false],
    ['matched by neither: outside the agent surface, so not permitted', 'src/frontend/app.ts', true],
    ['re-included by denyRead.exclude, so the deny no longer applies', 'src/backend/.env.example', false],
  ])('%s => isDenied %s', ([, path, expected]) => {
    const g = grantOf({ read: setOf(['src/backend/**']), denyRead: setOf(['**/.env*'], ['**/.env.example']) });
    expect(matcher.isDenied(path, g, 'read')).toBe(expected);
  });

  test('an empty allow set permits nothing: every path is denied', () => {
    const g = grantOf({});
    expect(matcher.isDenied('src/index.ts', g, 'read')).toBe(true);
    expect(matcher.isDenied('src/index.ts', g, 'write')).toBe(true);
  });

  // The workspace ROOT is what `resolve('.', root, 'list')` returns as `relative: ''` (resolve.test.ts), and NO
  // picomatch pattern matches the empty string — `**/*` and `**` included. Without an explicit rule the root of
  // the agent's own workspace would be "matched by no allow pattern", so `list_files` / `search` /
  // `WorkspaceReader` on the workspace root — the commonest call of all — would be refused (fix round 2).
  test('the workspace root (relative "") is inside the surface whenever the intent has any allow pattern', () => {
    const wide = grantOf({ read: setOf(['**/*']), denyRead: setOf(['**/.env*'], ['**/.env.example']) });
    expect(matcher.isDenied('', wide, 'read')).toBe(false);
    const narrow = grantOf({ read: setOf(['src/backend/**']), write: setOf(['src/backend/**']) });
    expect(matcher.isDenied('', narrow, 'read')).toBe(false);
    expect(matcher.isDenied('', narrow, 'write')).toBe(false);
  });

  test('the workspace root stays denied for an intent the grant permits nothing for', () => {
    const readOnly = grantOf({ read: setOf(['**/*']) }); // write allow set empty
    expect(matcher.isDenied('', readOnly, 'write')).toBe(true);
    expect(matcher.isDenied('', grantOf({}), 'read')).toBe(true);
  });
});

describe('createGlobMatcher — toExcludeArgs round-trip', () => {
  const matcher = createGlobMatcher();
  const fixtureFiles: Record<string, string> = {
    'src/backend/a.ts': 'a',
    'src/backend/.env': 'b',
    'src/backend/.env.example': 'c',
    '.env': 'd',
    '.env.example': 'e',
    'secrets/key.pem': 'f',
    'README.md': 'g',
    'vendor/lib.js': 'h',
  };
  const allPaths = Object.keys(fixtureFiles);

  interface Row {
    label: string;
    denySet: GlobSet;
    /** what `isDenied` rejects for a grant whose allow set is `**​/*` — i.e. exactly what `matches` rejects */
    denied: string[];
    /** what the external enumerator drops with the rendered args: a SUPERSET of `denied` (fail closed) */
    dropped: string[];
  }

  // The plan asks for "a table of deny sets", and the second row is the one that matters: a deny set with a
  // re-include. Neither dialect can express a re-include (see `toExcludeArgs`), so the delegation OVER-excludes
  // there — never under-excludes. `denied ⊆ dropped` is asserted below for every row.
  const rows: Row[] = [
    {
      label: 'deny set without a re-include',
      denySet: setOf(['**/.env*', 'secrets/**']),
      denied: ['.env', '.env.example', 'src/backend/.env', 'src/backend/.env.example', 'secrets/key.pem'],
      dropped: ['.env', '.env.example', 'src/backend/.env', 'src/backend/.env.example', 'secrets/key.pem'],
    },
    {
      label: 'deny set with a re-include (**/.env.example)',
      denySet: setOf(['**/.env*', 'secrets/**'], ['**/.env.example']),
      denied: ['.env', 'src/backend/.env', 'secrets/key.pem'],
      dropped: ['.env', '.env.example', 'src/backend/.env', 'src/backend/.env.example', 'secrets/key.pem'],
    },
  ];

  const grantFor = (denySet: GlobSet) => grantOf({ read: setOf(['**/*']), denyRead: denySet });
  const sorted = (paths: Iterable<string>): string[] => [...paths].sort();

  function plantFixture(root: string): void {
    for (const [path, content] of Object.entries(fixtureFiles)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }

  test.for(rows)('$label: the rendered args never drop LESS than isDenied rejects', (row) => {
    expect(sorted(row.denied.filter((path) => row.dropped.includes(path)))).toEqual(sorted(row.denied));
  });

  test.for(rows)('$label: isDenied rejects exactly the paths the deny set matches, under a `**/*` grant', (row) => {
    const g = grantFor(row.denySet);
    for (const path of allPaths) {
      expect(matcher.isDenied(path, g, 'read')).toBe(row.denied.includes(path));
      expect(matcher.matches(path, row.denySet)).toBe(row.denied.includes(path));
    }
  });

  test.for(rows)('$label: the rendered args are subtractive only — no positive pathspec, no re-include glob', (row) => {
    for (const arg of matcher.toExcludeArgs(row.denySet, 'git-pathspec'))
      expect(arg.startsWith(':(exclude,glob)')).toBe(true);
    for (const arg of matcher.toExcludeArgs(row.denySet, 'rg-glob')) expect(arg.startsWith('!')).toBe(true);
  });

  test.for(rows)(
    '$label: `git ls-files` with the rendered pathspecs drops every path isDenied rejects',
    async (row, { tempRepo }) => {
      plantFixture(tempRepo.root);
      await tempRepo.commit('fixture');
      const g = grantFor(row.denySet);
      const args = matcher.toExcludeArgs(row.denySet, 'git-pathspec');
      const { stdout } = await tempRepo.git(['ls-files', '--', '.', ...args]);
      const kept = new Set(stdout.split('\n').filter(Boolean));
      for (const path of allPaths) if (matcher.isDenied(path, g, 'read')) expect(kept.has(path)).toBe(false);
      expect(sorted(kept)).toEqual(sorted(allPaths.filter((path) => !row.dropped.includes(path))));
    },
  );

  test.for(rows)(
    '$label: the same pathspecs enumerate the tree when the caller passes NO positive pathspec of its own',
    async (row, { tempRepo }) => {
      // A `:(glob)` re-include entry would have turned this into an empty listing with exit 0 — a silent, total
      // loss of output for `git_diff` / `git grep` (fix round 2).
      plantFixture(tempRepo.root);
      await tempRepo.commit('fixture');
      const args = matcher.toExcludeArgs(row.denySet, 'git-pathspec');
      const { stdout } = await tempRepo.git(['ls-files', '--', ...args]);
      const kept = new Set(stdout.split('\n').filter(Boolean));
      expect(sorted(kept)).toEqual(sorted(allPaths.filter((path) => !row.dropped.includes(path))));
    },
  );

  test.for(rows)(
    '$label: rg --glob with the rendered globs drops every path isDenied rejects',
    async (row, { tempDir, skip }) => {
      const probe = spawnSync('rg', ['--version']);
      if (probe.error || probe.status !== 0) {
        skip('no ripgrep on PATH (PLAN F-1): the rg dialect cannot be proved here');
      }
      plantFixture(tempDir);
      const g = grantFor(row.denySet);
      const args = matcher.toExcludeArgs(row.denySet, 'rg-glob');
      const rgArgs = ['--files', '--hidden', '-uu', ...args.flatMap((glob) => ['--glob', glob]), '.'];
      const run = spawnSync('rg', rgArgs, { cwd: tempDir, encoding: 'utf8' });
      expect(run.status === 0 || run.status === 1).toBe(true); // 1 = "no files matched", still a clean run
      const kept = new Set(
        run.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => line.replace(/^\.\//, '')),
      );
      for (const path of allPaths) if (matcher.isDenied(path, g, 'read')) expect(kept.has(path)).toBe(false);
      expect(sorted(kept)).toEqual(sorted(allPaths.filter((path) => !row.dropped.includes(path))));
    },
  );
});
