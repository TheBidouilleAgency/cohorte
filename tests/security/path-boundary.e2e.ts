import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalPath } from '@cohorte/security/contract';
import { createPathResolver } from '@cohorte/security/decide/paths';
import { describe, expect, test } from 'vitest';

describe('security path boundary', () => {
  test('refuses outside roots and final symlink writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-security-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    try {
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'));

      const canonical = (await realpath(workspace)) as CanonicalPath;
      const resolver = createPathResolver({
        roots: [canonical],
        protectedRoots: [],
        symlinks: { mode: 'deny-outgoing', hardlinksOnWrite: 'deny' },
      });

      const outsideResult = resolver.resolve('../outside/secret.txt', canonical, 'read');
      expect(outsideResult.ok).toBe(false);
      if (!outsideResult.ok) expect(outsideResult.error.code).toBe('outside-roots');

      const symlinkResult = resolver.resolve('link.txt', canonical, 'write');
      expect(symlinkResult.ok).toBe(false);
      if (!symlinkResult.ok) expect(symlinkResult.error.code).toBe('symlink-final-write');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
