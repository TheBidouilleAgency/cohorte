import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { checkLayers, loadLayers } from '../check-layers.ts';
import { mirrorScaffold } from './support/mirror.ts';
import { REPO_ROOT, type TempTree, test } from './support/tree.ts';

// DESIGN 1.2, net 2 (TypeScript project references): what `tsc -b` really refuses in THIS scaffold,
// and what it lets through. Measured with TypeScript 7.0.2 on a mirror of the real configuration
// (support/mirror.ts), so that docs/v3/workspace.md cannot promise a net that does not exist.
//
//   refused         a reference cycle (TS6202); a RELATIVE import into another package (TS6059, TS6307)
//   NOT refused     an import BY NAME of a workspace package the importer does not reference — undeclared,
//                   or declared under devDependencies only. The name resolves through a node_modules
//                   symlink to the other package's `.ts` sources (source-first exports), TypeScript
//                   treats them as an external library and compiles them into the importer's program.
//
// For that second case `check-layers` is the ONLY net, which is why `unit:check` runs it as well.

const TSC = join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
const layers = loadLayers(join(REPO_ROOT, 'layers.json'));
const SLOW = 120_000;

const tsc = (tree: TempTree, ...args: string[]) => {
  const done = spawnSync(process.execPath, [TSC, ...args, '--pretty', 'false'], { cwd: tree.root, encoding: 'utf8' });
  return { status: done.status, output: `${done.stdout}${done.stderr}` };
};

const importing = (specifier: string) =>
  `import { marker } from '${specifier}';\n\nexport const planted: string = marker;\n`;

const IF_THIS_FAILS =
  'tsc -b started to refuse this import: net 2 got stronger. Update docs/v3/workspace.md, DESIGN 1.2 and this test.';

describe('tsc -b over the project references (DESIGN 1.2, net 2)', () => {
  test('the mirrored scaffold builds, and a declared edge is read from the declarations of its reference', {
    timeout: SLOW,
  }, async ({ tree }) => {
    mirrorScaffold(tree, layers);
    await tree.write({ 'packages/git/src/declared.ts': importing('@cohorte/base') });
    expect(tsc(tree, '-b')).toEqual({ status: 0, output: '' });
    expect(checkLayers({ root: tree.root, layers }).violations).toEqual([]);

    const inputs = tsc(tree, '-p', 'packages/git', '--listFilesOnly').output;
    expect(inputs).toContain(join(tree.root, 'packages/base/dist-types/index.d.ts'));
    expect(inputs).not.toContain(join(tree.root, 'packages/base/src/index.ts'));
  });

  test.for([
    ['an UNDECLARED workspace package', 'packages/git', '@cohorte/security', 'packages/security', 'a'],
    ['a DEV-ONLY workspace package', 'packages/core', '@cohorte/runtime-fake', 'packages/runtime-fake', 'd'],
    ['an undeclared AREA subpath', 'packages/git', '@cohorte/security/contract', 'packages/security', 'a'],
  ] as const)(
    'src/** importing %s by name is NOT refused by tsc -b; check-layers alone reports it',
    { timeout: SLOW },
    async ([, importer, specifier, imported, rule], { tree }) => {
      mirrorScaffold(tree, layers);
      await tree.write({
        [`${importer}/src/planted.ts`]: importing(specifier),
        'packages/security/src/contract/index.ts': "export const marker: string = 'contract';\n",
      });

      const build = tsc(tree, '-b');
      expect(build.output, IF_THIS_FAILS).not.toMatch(/TS6307|TS6059|TS2307/);
      expect(build.status, IF_THIS_FAILS).toBe(0);
      // The other package's SOURCES became inputs of the importer's own program.
      const inputs = tsc(tree, '-p', importer, '--listFilesOnly').output;
      expect(inputs).toContain(join(tree.root, imported, 'src'));

      const { violations } = checkLayers({ root: tree.root, layers });
      expect(violations.map((v) => `${v.rule} ${v.file}`)).toEqual([`${rule} ${importer}/src/planted.ts`]);
    },
  );

  test('a RELATIVE import into another package is refused: outside rootDir (TS6059) and outside the project (TS6307)', {
    timeout: SLOW,
  }, async ({ tree }) => {
    mirrorScaffold(tree, layers);
    await tree.write({ 'packages/git/src/planted.ts': importing('../../security/src/index.ts') });
    const build = tsc(tree, '-b');
    expect(build.status).not.toBe(0);
    expect(build.output).toMatch(/packages\/git\/src\/planted\.ts\(1,\d+\): error TS6059/);
    expect(build.output).toMatch(/packages\/git\/src\/planted\.ts\(1,\d+\): error TS6307/);
    expect(checkLayers({ root: tree.root, layers }).violations.map((v) => v.rule)).toEqual(['a']);
  });

  test('a reference cycle is refused (TS6202)', { timeout: SLOW }, ({ tree }) => {
    mirrorScaffold(tree, layers);
    // git references base; make base reference git.
    const path = join(tree.root, 'packages/base/tsconfig.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.references = [...(config.references ?? []), { path: '../git' }];
    writeFileSync(path, JSON.stringify(config));
    const build = tsc(tree, '-b', '--dry');
    expect(build.status).not.toBe(0);
    expect(build.output).toContain('TS6202');
  });
});
