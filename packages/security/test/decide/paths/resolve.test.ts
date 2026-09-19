// DESIGN 2.6.3 (spec 23), 7.4 S-01..S-13 + the path-table case. `S-06` (symlink swapped between gate and use) is
// exercised in use-time.test.ts: it is a property of `openVerified`, not of `resolve()`. `src/backend-evil` vs
// `src/backend/**` is a GLOB semantics case, exercised in glob.test.ts against `createGlobMatcher`.
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SYMLINK_POLICY } from '@cohorte/config/schema';
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type {
  CanonicalPath,
  PathIntent,
  PathResolver,
  PathViolation,
  ResolvedPath,
} from '../../../src/contract/index.ts';
import { createGlobMatcher, createPathResolver } from '../../../src/decide/paths/index.ts';
import { grantOf, isUnder, mulberry32, resolverFor, setOf, siblingDir } from './helpers.ts';

type Outcome = 'ok' | PathViolation['code'];

function assertOutcome(result: { ok: boolean; value?: ResolvedPath; error?: PathViolation }, expected: Outcome): void {
  if (expected === 'ok') {
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  } else {
    expect(result.ok, result.ok ? JSON.stringify(result.value) : '').toBe(false);
    if (!result.ok) expect(result.error?.code).toBe(expected);
  }
}

describe('createPathResolver — S-01..S-13 (DESIGN 7.4)', () => {
  test.for<[id: string, setup: (root: string) => { input: string; intent?: PathIntent }, expected: Outcome]>([
    ['S-01 ../ escape', () => ({ input: '../escaped.txt' }), 'outside-roots'],
    ['S-02 absolute path outside every root', () => ({ input: '/etc/hosts' }), 'outside-roots'],
    [
      'S-09 hardlinked file on write is refused (default hardlinksOnWrite: deny)',
      (root) => {
        writeFileSync(join(root, 'target.txt'), 'x');
        linkSync(join(root, 'target.txt'), join(root, 'link.txt'));
        return { input: 'link.txt', intent: 'write' };
      },
      'hardlink-multiply-linked',
    ],
    ['S-10 NUL byte', () => ({ input: 'foo\u0000bar' }), 'nul-byte'],
    [
      'S-12a .git as a FILE (worktree gitdir pointer) is a protected root',
      (root) => {
        writeFileSync(join(root, '.git'), 'gitdir: ../elsewhere/.git/worktrees/x\n');
        return { input: '.git' };
      },
      'protected-root',
    ],
    [
      'S-12b nested .git directory is a protected root',
      (root) => {
        mkdirSync(join(root, 'sub', '.git'), { recursive: true });
        writeFileSync(join(root, 'sub', '.git', 'HEAD'), 'ref: refs/heads/main\n');
        return { input: 'sub/.git/HEAD' };
      },
      'protected-root',
    ],
    [
      'S-13 .cohorte/state/cohorte.db is a protected root',
      (root) => {
        mkdirSync(join(root, '.cohorte', 'state'), { recursive: true });
        writeFileSync(join(root, '.cohorte', 'state', 'cohorte.db'), '');
        return { input: '.cohorte/state/cohorte.db' };
      },
      'protected-root',
    ],
  ])('%s', ([, setup, expected], { tempDir }) => {
    const { input, intent } = setup(tempDir);
    const resolver = resolverFor(tempDir);
    const result = resolver.resolve(input, tempDir as CanonicalPath, intent ?? 'read');
    assertOutcome(result, expected);
  });

  test('S-03 an outgoing symlink is refused under deny-outgoing (the default)', async ({ tempDir }) => {
    const outside = siblingDir(tempDir);
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    symlinkSync(outside, join(tempDir, 'link'));
    const result = resolverFor(tempDir).resolve('link/secret.txt', tempDir as CanonicalPath, 'read');
    assertOutcome(result, 'symlink-escape');
  });

  test('S-04 a symlink to a sibling surface is refused by SEGMENT containment, not startsWith', async ({ tempDir }) => {
    // `${tempDir}-gateway` shares a long STRING prefix with `tempDir` but is a different directory: exactly the
    // `apps/api` vs `apps/api-gateway` shape DESIGN 2.6.3 step 4 calls out.
    const sibling = `${tempDir}-gateway`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'x.ts'), 'export {};\n');
    symlinkSync(sibling, join(tempDir, 'link'));
    const result = resolverFor(tempDir).resolve('link/x.ts', tempDir as CanonicalPath, 'read');
    assertOutcome(result, 'symlink-escape');
  });

  test('S-05 a symlink as the final component is refused on write, even pointing in-bounds', async ({ tempDir }) => {
    writeFileSync(join(tempDir, 'target.txt'), 'x');
    symlinkSync(join(tempDir, 'target.txt'), join(tempDir, 'link'));
    const readResult = resolverFor(tempDir).resolve('link', tempDir as CanonicalPath, 'read');
    assertOutcome(readResult, 'ok'); // reading through an in-bounds symlink is fine
    const writeResult = resolverFor(tempDir).resolve('link', tempDir as CanonicalPath, 'write');
    assertOutcome(writeResult, 'symlink-final-write');
  });

  test('S-07 .ENV resolves to the on-disk case, defeating a case-insensitive-volume deny-glob bypass', async ({
    tempDir,
  }) => {
    writeFileSync(join(tempDir, '.env'), 'X=1');
    const caseInsensitiveVolume = existsSync(join(tempDir, '.ENV'));
    const result = resolverFor(tempDir).resolve('.ENV', tempDir as CanonicalPath, 'read');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (caseInsensitiveVolume) {
      // realpath returns on-disk case: the deny-glob layer sees the TRUE name, whatever case was requested.
      expect(result.value.relative).toBe('.env');
      expect(result.value.exists).toBe(true);
    } else {
      // A genuinely case-sensitive volume: `.ENV` really does not exist. Not a security matter here.
      expect(result.value.exists).toBe(false);
    }
  });

  test('S-08 NFC: a decomposed request finds a precomposed name', async ({ tempDir }) => {
    const composed = 'e\u0301lan.txt'.normalize('NFC'); // "élan.txt"
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    writeFileSync(join(tempDir, composed), 'x'); // created NFC, matching what `resolve` itself normalises to
    const result = resolverFor(tempDir).resolve(decomposed, tempDir as CanonicalPath, 'read');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exists).toBe(true);
      expect(result.value.relative).toBe(composed);
    }
  });

  test('a worktree root inside a protected root is protected-root (why U2.09 refuses that git.worktreeRoot)', async ({
    tempDir,
  }) => {
    // DESIGN 2.6.3 step 5: `.cohorte/**` carries no carve-out for `.cohorte/worktrees`, so a config resolver
    // that tries a CANDIDATE `git.worktreeRoot` from the PROJECT root — exactly what U2.09 does before ever
    // handing that root to an agent — finds every path under it protected-root, i.e. legal but unusable.
    const projectRoot = tempDir;
    const candidateWorktreeRoot = join(projectRoot, '.cohorte', 'worktrees', 'agent-1');
    mkdirSync(candidateWorktreeRoot, { recursive: true });
    writeFileSync(join(candidateWorktreeRoot, 'src.ts'), 'export {};\n');
    const result = resolverFor(projectRoot).resolve(
      '.cohorte/worktrees/agent-1/src.ts',
      projectRoot as CanonicalPath,
      'read',
    );
    assertOutcome(result, 'protected-root');
  });

  test('an absolute protected root (install dir shape) is refused even inside an allowed read-only root', async ({
    tempDir,
  }) => {
    const readOnlyRoot = join(tempDir, 'usr-local');
    const installDir = join(readOnlyRoot, 'cohorte-install');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'cohorte'), '#!/bin/sh\n');
    const resolver = createPathResolver({
      roots: [readOnlyRoot as CanonicalPath],
      symlinks: DEFAULT_SYMLINK_POLICY,
      protectedRoots: [installDir as CanonicalPath],
    });
    const result = resolver.resolve('cohorte-install/cohorte', readOnlyRoot as CanonicalPath, 'read');
    assertOutcome(result, 'protected-root');
  });

  test("Pi's auth.json path shape (~/.pi/agent) is refused as an absolute protected root", async ({ tempDir }) => {
    const fakeHome = join(tempDir, 'home');
    const piAgentDir = join(fakeHome, '.pi', 'agent');
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(join(piAgentDir, 'auth.json'), '{}');
    const resolver = createPathResolver({
      roots: [fakeHome as CanonicalPath],
      symlinks: DEFAULT_SYMLINK_POLICY,
      protectedRoots: [piAgentDir as CanonicalPath],
    });
    const result = resolver.resolve('.pi/agent/auth.json', fakeHome as CanonicalPath, 'read');
    assertOutcome(result, 'protected-root');
  });

  test('FIFO/device: a FIFO is refused as a special file', async ({ tempDir, skip }) => {
    const fifoPath = join(tempDir, 'pipe');
    try {
      execFileSync('mkfifo', [fifoPath]);
    } catch {
      skip('mkfifo unavailable on this machine: the FIFO case cannot be built here');
    }
    const result = resolverFor(tempDir).resolve('pipe', tempDir as CanonicalPath, 'read');
    assertOutcome(result, 'special-file');
  });

  test('deny-all rejects every symlink, even one pointing in-bounds', async ({ tempDir }) => {
    writeFileSync(join(tempDir, 'target.txt'), 'x');
    symlinkSync(join(tempDir, 'target.txt'), join(tempDir, 'link'));
    const resolver = createPathResolver({
      roots: [tempDir as CanonicalPath],
      symlinks: { mode: 'deny-all', hardlinksOnWrite: 'deny' },
      protectedRoots: [],
    });
    const result = resolver.resolve('link', tempDir as CanonicalPath, 'read');
    assertOutcome(result, 'symlink-denied');
  });

  test('allow skips the per-component containment check but never hands back a path outside every root', async ({
    tempDir,
  }) => {
    // `allow` lifts step 3's per-component check, NOT step 4's containment: the final canonical path is still
    // tested against the roots, so `resolve()` can never report a path the caller has no root for. (Deviation
    // D-2 of this unit: the alternative — an ok result whose `canonical` lies outside every root — cannot
    // produce an honest `root`/`relative` pair, and the deny-glob layer downstream matches on `relative`.)
    const outside = siblingDir(tempDir);
    writeFileSync(join(outside, 'file.txt'), 'x');
    symlinkSync(outside, join(tempDir, 'link'));
    const resolver = createPathResolver({
      roots: [tempDir as CanonicalPath],
      symlinks: { mode: 'allow', hardlinksOnWrite: 'deny' },
      protectedRoots: [],
    });
    assertOutcome(resolver.resolve('link/file.txt', tempDir as CanonicalPath, 'read'), 'outside-roots');
  });

  test('allow lets a chain hop out of the roots and back in, where deny-outgoing refuses the first hop', async ({
    tempDir,
  }) => {
    const root = join(tempDir, 'root');
    mkdirSync(join(root, 'real'), { recursive: true });
    writeFileSync(join(root, 'real', 'file.txt'), 'x');
    const outside = siblingDir(tempDir);
    mkdirSync(join(outside, 'inner'), { recursive: true });
    symlinkSync(join(outside, 'inner'), join(root, 'hop'));
    symlinkSync(join(root, 'real'), join(outside, 'inner', 'back'));

    const permissive = createPathResolver({
      roots: [root as CanonicalPath],
      symlinks: { mode: 'allow', hardlinksOnWrite: 'deny' },
      protectedRoots: [],
    });
    const result = permissive.resolve('hop/back/file.txt', root as CanonicalPath, 'read');
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (result.ok) {
      expect(result.value.canonical).toBe(`${root}/real/file.txt`);
      expect(result.value.relative).toBe('real/file.txt');
      expect(result.value.viaSymlink).toBe(true);
    }
    assertOutcome(resolverFor(root).resolve('hop/back/file.txt', root as CanonicalPath, 'read'), 'symlink-escape');
  });

  test('a symlink swapped mid-chain does not defeat deny-outgoing containment', async ({ tempDir }) => {
    const outside = siblingDir(tempDir);
    mkdirSync(join(outside, 'inner'), { recursive: true });
    symlinkSync(join(outside, 'inner'), join(tempDir, 'hop1'));
    const result = resolverFor(tempDir).resolve('hop1/x.txt', tempDir as CanonicalPath, 'read');
    assertOutcome(result, 'symlink-escape');
  });

  test('a create whose name collides, case-insensitively, with an existing sibling is refused', async ({
    tempDir,
    skip,
  }) => {
    writeFileSync(join(tempDir, 'Report.md'), '# x');
    const result = resolverFor(tempDir).resolve('report.md', tempDir as CanonicalPath, 'create');
    if (result.ok && result.value.exists) {
      // A case-insensitive volume (APFS) resolved straight to the existing `Report.md`: the on-disk case of
      // step 4 already closed the hole, and the `case-collision` branch is unreachable here.
      skip('case-insensitive volume: `report.md` resolves to the existing `Report.md`, so nothing collides');
    }
    assertOutcome(result, 'case-collision');
  });

  test.for(['~', 'a/~/b', '~root', '~/secrets'])(
    'a home-directory shorthand segment is never expanded: %j',
    (input, { tempDir }) => {
      const result = resolverFor(tempDir).resolve(input, tempDir as CanonicalPath, 'read');
      assertOutcome(result, 'outside-roots');
    },
  );

  // A tilde that is not the home shorthand is an ordinary filename character: an emacs/vim backup, an Office
  // lock file, a name that simply contains one. DESIGN 2.6.3 step 1 targets the home shorthand, which is a
  // SEGMENT of the form `~` or `~user` — refusing every `~` made those files unaddressable.
  test.for(['notes.txt~', 'a~b.ts', '~report.docx', 'src/a~'])(
    'an ordinary tilde in a filename resolves: %j',
    (name, { tempDir }) => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, name), 'x');
      const result = resolverFor(tempDir).resolve(name, tempDir as CanonicalPath, 'read');
      assertOutcome(result, 'ok');
      if (result.ok) expect(result.value.relative).toBe(name);
    },
  );

  test('an Office lock file (~$name) is still refused — by the env-syntax rule, not the tilde rule', async ({
    tempDir,
  }) => {
    // `$report` is what step 1 refuses as shell/env syntax; nothing is ever expanded, so the name stays
    // unaddressable. Recorded as deviation D-4 / request note N3: narrowing THAT rule is not this unit's call.
    const result = resolverFor(tempDir).resolve('~$report.docx', tempDir as CanonicalPath, 'read');
    assertOutcome(result, 'outside-roots');
    if (!result.ok) expect(result.error.detail).toContain('environment-variable syntax');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal on purpose — proving ${...} is rejected, not expanded.
  test.for(['$HOME/x', '${HOME}/x', '%APPDATA%\\x'])(
    'environment-variable syntax is never expanded: %j',
    (input, { tempDir }) => {
      const result = resolverFor(tempDir).resolve(input, tempDir as CanonicalPath, 'read');
      assertOutcome(result, 'outside-roots');
    },
  );

  test.for(['C:\\Windows\\System32', '\\\\server\\share\\file'])(
    'Windows drive/UNC forms are refused: %j',
    (input, { tempDir }) => {
      const result = resolverFor(tempDir).resolve(input, tempDir as CanonicalPath, 'read');
      assertOutcome(result, 'outside-roots');
    },
  );

  test('a path over the length limit is refused', async ({ tempDir }) => {
    const result = resolverFor(tempDir).resolve('a'.repeat(4097), tempDir as CanonicalPath, 'read');
    assertOutcome(result, 'too-long');
  });

  test('the length limit is counted in BYTES, so multi-byte characters cannot smuggle a longer path', async ({
    tempDir,
  }) => {
    const input = 'é'.repeat(2049); // 2049 UTF-16 code units, 4098 UTF-8 bytes
    expect(input.length).toBeLessThan(4096);
    expect(Buffer.byteLength(input, 'utf8')).toBeGreaterThan(4096);
    assertOutcome(resolverFor(tempDir).resolve(input, tempDir as CanonicalPath, 'read'), 'too-long');
  });

  test('resolving "." to the root itself succeeds with an empty relative path', async ({ tempDir }) => {
    const result = resolverFor(tempDir).resolve('.', tempDir as CanonicalPath, 'list');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canonical).toBe(tempDir);
      expect(result.value.relative).toBe('');
      expect(result.value.exists).toBe(true);
    }
  });

  // The two halves of this unit composed: what `resolve` returns for the workspace root must be usable by the
  // matcher the same unit ships. `relative` is the empty string there, which no picomatch pattern matches, so
  // `isDenied` has to treat it as the surface itself — otherwise `list_files` / `search` / `WorkspaceReader` on
  // the agent's own workspace root (U2.03) would be refused for every possible grant (fix round 2).
  test.for<['read' | 'write', PathIntent]>([
    ['read', 'list'],
    ['read', 'read'],
    ['write', 'create'],
  ])(
    'the relative path of the root itself is permitted by a `**/*` grant (%s / %s)',
    ([intent, pathIntent], { tempDir }) => {
      const result = resolverFor(tempDir).resolve('.', tempDir as CanonicalPath, pathIntent);
      assertOutcome(result, 'ok');
      if (!result.ok) return;
      expect(result.value.relative).toBe('');
      const grant = grantOf({ read: setOf(['**/*']), write: setOf(['**/*']), denyRead: setOf(['**/.env*']) });
      expect(createGlobMatcher().isDenied(result.value.relative, grant, intent)).toBe(false);
    },
  );

  test('a nonexistent nested path resolves ok with exists: false, ready for `create`', async ({ tempDir }) => {
    const result = resolverFor(tempDir).resolve('new/nested/file.txt', tempDir as CanonicalPath, 'create');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exists).toBe(false);
      expect(result.value.canonical).toBe(`${tempDir}/new/nested/file.txt`);
      expect(result.value.identity).toBeUndefined();
    }
  });

  test('never throws, and never resolves outside the roots, over a deterministic fuzz table', async ({ tempDir }) => {
    const resolver = resolverFor(tempDir);
    const alphabet = [
      'a',
      'b',
      '.',
      '/',
      '..',
      '~',
      '$',
      '{',
      '}',
      '%',
      '\\',
      ':',
      '\u0000',
      '\u0007',
      'é',
      '𝕏',
      ' ',
      '-',
      '_',
      '\n',
      '\r',
    ];
    const rand = mulberry32(0xc0d3);
    for (let i = 0; i < 300; i += 1) {
      const length = 1 + Math.floor(rand() * 24);
      let input = '';
      for (let c = 0; c < length; c += 1) {
        const index = Math.floor(rand() * alphabet.length);
        input += alphabet[index];
      }
      let result: ReturnType<typeof resolver.resolve> | undefined;
      expect(
        () => {
          result = resolver.resolve(input, tempDir as CanonicalPath, 'read');
        },
        `input ${JSON.stringify(input)} threw`,
      ).not.toThrow();
      if (result?.ok) {
        expect(
          isUnder(result.value.canonical, tempDir),
          `${JSON.stringify(input)} escaped to ${result.value.canonical}`,
        ).toBe(true);
      }
    }
  });
});

describe('createPathResolver — containment is decided on the CANONICAL path, with more than one root', () => {
  // The normal `AgentGrant` shape: a workspace plus read-only roots (DESIGN 2.6.1), with an in-workspace symlink
  // pointing into one of the agent's OWN read-only roots. The link leaves no root, so `deny-outgoing` lets it
  // through — and step 4 must then pick the root that really CONTAINS the canonical path. Picking the lexical
  // (pre-walk) root instead made `relative` climb with `..`, which no double-star protected-repo pattern matches:
  // the non-overridable protected roots of step 5 and every relative deny-glob stopped applying (I4, I11).
  function twoRoots(tempDir: string): { workspace: CanonicalPath; readOnly: CanonicalPath; resolver: PathResolver } {
    const workspace = join(tempDir, 'ws');
    const readOnly = join(tempDir, 'ro');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(readOnly, { recursive: true });
    symlinkSync(readOnly, join(workspace, 'link'));
    const resolver = createPathResolver({
      roots: [workspace as CanonicalPath, readOnly as CanonicalPath],
      symlinks: DEFAULT_SYMLINK_POLICY,
      protectedRoots: [],
    });
    return { workspace: workspace as CanonicalPath, readOnly: readOnly as CanonicalPath, resolver };
  }

  test('a symlink into a second root cannot smuggle `.git` past the protected repository paths', async ({
    tempDir,
  }) => {
    const { workspace, readOnly, resolver } = twoRoots(tempDir);
    mkdirSync(join(readOnly, '.git'), { recursive: true });
    writeFileSync(join(readOnly, '.git', 'config'), '[core]\n');
    assertOutcome(resolver.resolve('link/.git/config', workspace, 'read'), 'protected-root');
  });

  test('S-13 through a symlink into a second root: .cohorte/state/cohorte.db stays protected', async ({ tempDir }) => {
    const { workspace, readOnly, resolver } = twoRoots(tempDir);
    mkdirSync(join(readOnly, '.cohorte', 'state'), { recursive: true });
    writeFileSync(join(readOnly, '.cohorte', 'state', 'cohorte.db'), '');
    assertOutcome(resolver.resolve('link/.cohorte/state/cohorte.db', workspace, 'read'), 'protected-root');
  });

  test('an ok result names the root that really contains it, and `relative` never climbs with ".."', async ({
    tempDir,
  }) => {
    const { workspace, readOnly, resolver } = twoRoots(tempDir);
    writeFileSync(join(readOnly, 'notes.txt'), 'x');
    for (const intent of ['read', 'write'] as const) {
      const result = resolver.resolve('link/notes.txt', workspace, intent);
      expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
      if (!result.ok) continue;
      expect(result.value.root).toBe(readOnly);
      expect(result.value.relative).toBe('notes.txt');
      expect(result.value.relative.startsWith('..')).toBe(false);
      expect(isUnder(result.value.canonical, result.value.root)).toBe(true);
    }
  });

  test('a path whose canonical form leaves every root is refused even when its lexical form was in one', async ({
    tempDir,
  }) => {
    const { workspace, resolver } = twoRoots(tempDir);
    const outside = siblingDir(tempDir);
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(outside, join(workspace, 'away'));
    assertOutcome(resolver.resolve('away/secret.txt', workspace, 'read'), 'symlink-escape');
  });
});
