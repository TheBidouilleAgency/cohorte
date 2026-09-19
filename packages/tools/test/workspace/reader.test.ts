import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobMatcher, createPathResolver } from '@cohorte/security';
import type { AgentGrant, CanonicalPath } from '@cohorte/security/contract';
import { describe, expect, test } from 'vitest';
import { createWorkspaceReader } from '../../src/workspace/index.ts';

function grant(root: CanonicalPath): AgentGrant {
  return {
    agentId: 'agt_reader' as never,
    role: 'implementer',
    digest: 'a'.repeat(64) as never,
    tools: ['read_file', 'list_files'],
    roots: { workspace: root, readOnly: [] },
    read: { include: ['**'], exclude: [] },
    write: { include: [], exclude: [] },
    denyRead: { include: ['.env*', 'secret/**'], exclude: [] },
    denyWrite: { include: ['**'], exclude: [] },
    commands: { default: 'deny', rules: [] },
    secrets: [],
    temporary: [],
    limits: { maxToolCalls: 10, maxCallsPerMinute: 10, perTool: {} },
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cohorte-reader-'));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'secret'));
  await writeFile(join(dir, 'src', 'main.ts'), 'hello\n');
  await writeFile(join(dir, '.env.local'), 'token=hidden\n');
  await writeFile(join(dir, 'secret', 'key.txt'), 'hidden\n');
  await symlink('/tmp', join(dir, 'outgoing'));
  const root = realpathSync.native(dir) as CanonicalPath;
  return {
    dir,
    root,
    reader: createWorkspaceReader({
      paths: createPathResolver({
        roots: [root],
        symlinks: { mode: 'deny-outgoing', hardlinksOnWrite: 'deny' },
        protectedRoots: [],
      }),
      globs: createGlobMatcher(),
    }),
  };
}

describe('WorkspaceReader', () => {
  test('reads allowed bytes, filters deny globs, and does not follow outgoing symlinks', async () => {
    const world = await setup();
    const permissions = grant(world.root);
    await expect(world.reader.read(world.root, 'src/main.ts', permissions)).resolves.toMatchObject({ ok: true });
    await expect(world.reader.read(world.root, '.env.local', permissions)).resolves.toMatchObject({ ok: false });
    await expect(world.reader.read(world.root, 'outgoing/passwd', permissions)).resolves.toMatchObject({ ok: false });
    await expect(world.reader.list(world.root, { include: ['**'], exclude: [] }, permissions)).resolves.toEqual([
      'src/main.ts',
    ]);
  });
});
