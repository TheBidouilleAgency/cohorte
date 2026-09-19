import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test as base } from 'vitest';

/** The repository this test file belongs to (scripts/test/support -> three levels up). */
export const REPO_ROOT: string = realpathSync(join(import.meta.dirname, '..', '..', '..'));

export interface TempTree {
  /** Canonical absolute path (macOS: /tmp is a symlink, and git and tsc both report canonical paths). */
  readonly root: string;
  write(files: Readonly<Record<string, string>>): Promise<void>;
  /** Makes `typescript`, `vitest` and Biome resolvable from the tree without installing anything. */
  linkNodeModules(): Promise<void>;
}

async function createTempTree(prefix: string): Promise<TempTree> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return {
    root,
    async write(files) {
      for (const [relative, content] of Object.entries(files)) {
        const target = join(root, relative);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    },
    async linkNodeModules() {
      await symlink(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
    },
  };
}

/** Per-test temp tree, removed afterwards: no fixture state is shared between tests. */
export const test = base.extend<{ tree: TempTree }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest requires a destructured first argument for fixtures
  tree: async ({}, use) => {
    const tree = await createTempTree('cohorte-scripts-');
    await use(tree);
    await rm(tree.root, { recursive: true, force: true });
  },
});
