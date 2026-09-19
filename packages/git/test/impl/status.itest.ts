import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SurfaceId } from '@cohorte/base';
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { CanonicalPath, SurfaceMap } from '../../src/contract.ts';
import { testGitPort } from './helpers.ts';

describe('changedPaths', () => {
  test('exact whole-line porcelain match: modify, add, delete, untracked', async ({ tempRepo }) => {
    const port = testGitPort();
    await tempRepo.write('modify-me.txt', 'v1\n');
    await tempRepo.write('delete-me.txt', 'v1\n');
    await tempRepo.commit('setup');

    await tempRepo.write('modify-me.txt', 'v2\n');
    await tempRepo.git(['rm', '-q', 'delete-me.txt']);
    await tempRepo.write('new-untracked.txt', 'v1\n');
    await tempRepo.git(['add', 'modify-me.txt']); // stage the modification too (index + worktree both changed paths)

    const touches = await port.changedPaths(tempRepo.root as CanonicalPath);
    const byPath = new Map(touches.map((t) => [t.path, t.op]));
    expect(byPath.get('modify-me.txt')).toBe('modify');
    expect(byPath.get('delete-me.txt')).toBe('delete');
    expect(byPath.get('new-untracked.txt')).toBe('create');
  });

  test('paths with spaces and unicode survive -z parsing exactly', async ({ tempRepo }) => {
    const port = testGitPort();
    await mkdir(join(tempRepo.root, 'dir with space'), { recursive: true });
    await writeFile(join(tempRepo.root, 'dir with space', 'f 1.txt'), 'new\n');
    await writeFile(join(tempRepo.root, 'héllo.txt'), 'new\n');

    const touches = await port.changedPaths(tempRepo.root as CanonicalPath);
    const paths = touches.map((t) => t.path).sort();
    expect(paths).toEqual(['dir with space/f 1.txt', 'héllo.txt'].sort());
    for (const touch of touches) expect(touch.op).toBe('create');
  });

  test('a rename is reported as a delete of the old path and a create of the new path', async ({ tempRepo }) => {
    const port = testGitPort();
    await tempRepo.write(
      'old-name.txt',
      'stable content that git will detect as a rename, not a delete+add\n'.repeat(3),
    );
    await tempRepo.commit('setup');
    await tempRepo.git(['mv', 'old-name.txt', 'new-name.txt']);

    const touches = await port.changedPaths(tempRepo.root as CanonicalPath);
    const byPath = new Map(touches.map((t) => [t.path, t.op]));
    expect(byPath.get('old-name.txt')).toBe('delete');
    expect(byPath.get('new-name.txt')).toBe('create');
  });

  test('detached HEAD does not change how changes are reported', async ({ tempRepo }) => {
    const port = testGitPort();
    const sha = await tempRepo.head();
    await tempRepo.git(['checkout', '--detach', sha]);
    await tempRepo.write('in-detached.txt', 'x\n');
    const touches = await port.changedPaths(tempRepo.root as CanonicalPath);
    expect(touches).toEqual([{ path: 'in-detached.txt', op: 'create' }]);
  });

  test('a submodule pointer move is reported: the ownership audit must see it', async ({ tempRepo }) => {
    const port = testGitPort();
    // `--ignore-submodules` (whose omitted value is `all`) would hide this entirely, so a write into a submodule
    // would pass the audits of DESIGN 5.3 (b) and 5.4 (2) unseen.
    const sub = join(tempRepo.root, 'sub');
    await mkdir(sub, { recursive: true });
    await tempRepo.git(['init', '--quiet', '--initial-branch=main'], { cwd: sub });
    await writeFile(join(sub, 's.txt'), 'v1\n');
    await tempRepo.git(['add', '-A'], { cwd: sub });
    await tempRepo.git(['commit', '--quiet', '-m', 'sub v1'], { cwd: sub });
    await tempRepo.commit('embed the submodule as a gitlink');
    expect(await port.changedPaths(tempRepo.root as CanonicalPath)).toEqual([]);

    await writeFile(join(sub, 's.txt'), 'v2\n');
    await tempRepo.git(['add', '-A'], { cwd: sub });
    await tempRepo.git(['commit', '--quiet', '-m', 'sub v2'], { cwd: sub });

    const touches = await port.changedPaths(tempRepo.root as CanonicalPath);
    expect(touches).toEqual([{ path: 'sub', op: 'modify' }]);
  });

  test('a clean worktree reports nothing', async ({ tempRepo }) => {
    const port = testGitPort();
    const touches = await port.changedPaths(tempRepo.root as CanonicalPath);
    expect(touches).toEqual([]);
  });
});

describe('diffBySurface', () => {
  test('groups changed files by surface and returns a patch per group', async ({ tempRepo }) => {
    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;
    const base = await tempRepo.head();
    await tempRepo.write('backend/api.ts', 'backend code\n');
    await tempRepo.write('frontend/app.ts', 'frontend code\n');
    await tempRepo.write('README.md', 'shared doc\n');
    const head = await tempRepo.commit('two surfaces plus a shared file');

    const surfaces: SurfaceMap = {
      surfaceOf: (path) => {
        if (path.startsWith('backend/')) return 'backend' as SurfaceId;
        if (path.startsWith('frontend/')) return 'frontend' as SurfaceId;
        return 'shared';
      },
    };
    const groups = await port.diffBySurface({ repo, base, head, surfaces });
    const bySurface = new Map(groups.map((g) => [g.surface, g]));

    expect(bySurface.get('backend' as SurfaceId)?.files).toEqual(['backend/api.ts']);
    expect(bySurface.get('frontend' as SurfaceId)?.files).toEqual(['frontend/app.ts']);
    expect(bySurface.get('shared')?.files).toEqual(['README.md']);

    const backendPatch = bySurface.get('backend' as SurfaceId)?.patch;
    expect(backendPatch?.kind).toBe('diff');
    expect(backendPatch?.mediaType).toBe('text/x-diff');
    const text = Buffer.from(backendPatch?.bytes ?? new Uint8Array()).toString('utf8');
    expect(text).toContain('backend/api.ts');
    expect(text).toContain('+backend code');
    expect(text).not.toContain('frontend code');
  });
});
