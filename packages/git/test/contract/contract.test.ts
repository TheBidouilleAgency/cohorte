import type { Sha256, SurfaceId } from '@cohorte/base';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { ArtifactDraft, CanonicalPath, FileTouch, GitPort, RepoFacts, SurfaceMap } from '../../src/contract.ts';
import * as barrel from '../../src/index.ts';
import {
  createGitPort,
  GIT_DIFF_HARDENING_ARGS,
  GIT_HARDENED_CONFIG_ARGS,
  GIT_HARDENED_ENV,
  GIT_PORCELAIN_ARGS,
  MIN_GIT_VERSION,
} from '../../src/index.ts';

describe('the hardened-runner constants (DESIGN 5.0)', () => {
  test('six -c pairs, hooks off first', () => {
    const pairs: string[] = [];
    for (let at = 0; at < GIT_HARDENED_CONFIG_ARGS.length; at += 2) {
      expect(GIT_HARDENED_CONFIG_ARGS[at]).toBe('-c');
      pairs.push(GIT_HARDENED_CONFIG_ARGS[at + 1] ?? '');
    }
    expect(pairs).toEqual([
      'core.hooksPath=/dev/null',
      'core.fsmonitor=',
      'core.sshCommand=false',
      'protocol.allow=never',
      'commit.gpgsign=false',
      'core.pager=cat',
    ]);
  });

  test('the env ignores every ambient config and never prompts', () => {
    expect(GIT_HARDENED_ENV).toEqual({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    });
  });

  test('parsing and diff flags; the git floor', () => {
    expect([...GIT_PORCELAIN_ARGS]).toEqual(['--porcelain=v2', '-z']);
    expect([...GIT_DIFF_HARDENING_ARGS]).toEqual(['--no-ext-diff', '--no-textconv']);
    expect(MIN_GIT_VERSION).toBe('2.38.0');
  });

  test('all frozen', () => {
    for (const data of [GIT_HARDENED_CONFIG_ARGS, GIT_HARDENED_ENV, GIT_PORCELAIN_ARGS, GIT_DIFF_HARDENING_ARGS]) {
      expect(Object.isFrozen(data)).toBe(true);
    }
  });
});

describe('GitPort (DESIGN 5)', () => {
  test('exactly the fourteen methods of DESIGN 5', () => {
    expectTypeOf<keyof GitPort>().toEqualTypeOf<
      | 'facts'
      | 'treeDigest'
      | 'addWorktree'
      | 'switchToNewBranch'
      | 'removeWorktree'
      | 'resetHardClean'
      | 'commitAll'
      | 'findCommitByTrailer'
      | 'mergeTree'
      | 'commitTree'
      | 'updateRefCas'
      | 'createRef'
      | 'diffBySurface'
      | 'changedPaths'
    >();
  });

  test('signatures', () => {
    expectTypeOf<GitPort['facts']>().toEqualTypeOf<(repo: CanonicalPath) => Promise<RepoFacts>>();
    expectTypeOf<GitPort['removeWorktree']>().parameters.toEqualTypeOf<[CanonicalPath, { force: false }]>();
    expectTypeOf<GitPort['removeWorktree']>().returns.resolves.toEqualTypeOf<'removed' | 'dirty-kept'>();
    expectTypeOf<GitPort['updateRefCas']>().parameters.toEqualTypeOf<[CanonicalPath, string, string, string | null]>();
    expectTypeOf<GitPort['updateRefCas']>().returns.resolves.toEqualTypeOf<'ok' | 'moved'>();
    expectTypeOf<GitPort['mergeTree']>().returns.resolves.toEqualTypeOf<
      { clean: true; tree: string } | { clean: false; files: string[] }
    >();
    expectTypeOf<GitPort['commitAll']>().returns.resolves.toEqualTypeOf<
      { sha: string; treeDigest: string } | { kind: 'nothing' }
    >();
    expectTypeOf<GitPort['changedPaths']>().returns.resolves.toEqualTypeOf<FileTouch[]>();
    expectTypeOf<GitPort['diffBySurface']>().returns.resolves.toEqualTypeOf<
      { surface: SurfaceId | 'shared'; files: string[]; patch: ArtifactDraft }[]
    >();
    expectTypeOf<SurfaceMap['surfaceOf']>().returns.toEqualTypeOf<SurfaceId | 'shared'>();
  });

  test('FileTouch has the fields of the protocol one', () => {
    const touch: FileTouch = { path: 'a.ts', op: 'modify', beforeSha256: 'a'.repeat(64) as Sha256, bytes: 3 };
    expect(Object.keys(touch)).toEqual(['path', 'op', 'beforeSha256', 'bytes']);
    expectTypeOf<FileTouch['op']>().toEqualTypeOf<'read' | 'create' | 'modify' | 'delete'>();
  });
});

describe('the Wave-0 frozen barrel of @cohorte/git', () => {
  // Wave 0 froze the name ahead of U1.05, which fills it. What must hold for good is that the
  // export exists under its final name and never fails silently: before U1.05 it refuses with
  // NotImplemented, after U1.05 it builds a port.
  test('createGitPort has its final name and is a live export', () => {
    expect(Object.keys(barrel)).toContain('createGitPort');
    expect(createGitPort).toBeTypeOf('function');
    let thrown: unknown;
    try {
      createGitPort({
        gitBinary: '/usr/bin/git',
        path: '/usr/bin:/bin',
        mergeIdentity: { name: 'Cohorte', email: 'cohorte@localhost' },
        worktreeRoot: '/tmp/cohorte-worktrees' as CanonicalPath,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof TypeError, String(thrown)).toBe(false);
  });
});
