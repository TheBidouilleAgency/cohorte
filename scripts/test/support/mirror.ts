import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LayersFile } from '../../check-layers.ts';
import { REPO_ROOT, type TempTree } from './tree.ts';

/**
 * Rebuilds the scaffold inside a temp tree, as `tsc -b` and check-layers see it: the REAL
 * tsconfig.base.json, root tsconfig.json and layers.json, the REAL package.json and tsconfig.json of
 * every package, and the workspace links `pnpm install` creates — each package's declared edges in its
 * own node_modules, and every `@cohorte/*` package in the ROOT node_modules (PLAN PC-9: the root
 * declares them all for tests/** and scripts/**).
 *
 * Only the sources are placeholders: every package exports one `marker` constant and imports nothing,
 * so no third-party module is needed and a planted file is the only thing a test has to reason about.
 */
export function mirrorScaffold(tree: TempTree, layers: LayersFile): void {
  const link = (target: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, 'junction');
  };

  for (const file of ['tsconfig.base.json', 'tsconfig.json', 'layers.json']) {
    copyFileSync(join(REPO_ROOT, file), join(tree.root, file));
  }
  // `types: ["node"]` in the base config.
  link(join(REPO_ROOT, 'node_modules/@types'), join(tree.root, 'node_modules/@types'));

  for (const [name, entry] of Object.entries(layers.packages)) {
    const dir = join(tree.root, entry.dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const file of ['package.json', 'tsconfig.json'])
      copyFileSync(join(REPO_ROOT, entry.dir, file), join(dir, file));
    writeFileSync(join(dir, 'src/index.ts'), `export const marker: string = '${name}';\n`);
    for (const dependency of new Set([...entry.normal, ...Object.keys(entry.typeOnly), ...entry.dev])) {
      const target = layers.packages[dependency];
      if (target) link(join(tree.root, target.dir), join(dir, 'node_modules', dependency));
    }
  }
  for (const name of layers.root.dev) {
    const target = layers.packages[name];
    if (target) link(join(tree.root, target.dir), join(tree.root, 'node_modules', name));
  }
}
