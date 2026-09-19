import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadLayers } from '../check-layers.ts';
import { REPO_ROOT } from './support/tree.ts';

// DESIGN 1.1 / PLAN PC-8: the package table is proven mechanically. `layers.json` is the table;
// every package.json, every tsconfig.json and the installed node_modules layout must agree with it.

const layers = loadLayers(join(REPO_ROOT, 'layers.json'));
const NAMES = Object.keys(layers.packages);
const pkg = (name: string) => {
  const found = layers.packages[name];
  if (!found) throw new Error(`unknown package ${name}`);
  return found;
};
const dirOf = (name: string) => join(REPO_ROOT, pkg(name).dir);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const workspaceEdges = (name: string) => [...pkg(name).normal, ...Object.keys(pkg(name).typeOnly)];
const allEdges = (name: string) => [...new Set([...workspaceEdges(name), ...pkg(name).dev])];
const sorted = (values: Iterable<string>) => [...values].sort();

/** Where Node finds the package `specifier` when the importing file lives in `fromDir`. */
function locate(specifier: string, fromDir: string): string | undefined {
  try {
    return findPackageJSON(specifier, pathToFileURL(join(fromDir, 'package.json')));
  } catch {
    return undefined;
  }
}

/** Canonical form of a path whose tail may not exist yet. */
function canonical(path: string): string {
  const missing: string[] = [];
  let existing = path;
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

/**
 * Resolves through `exports` with Node's own resolver. The contract files behind `./contract`-style
 * subpaths are written by later Wave-0 units: until then Node reports the mapped target as missing,
 * and the path it names is exactly what proves the mapping.
 */
function resolveTarget(specifier: string, fromDir: string): string {
  try {
    return realpathSync(createRequire(join(fromDir, 'noop.cjs')).resolve(specifier));
  } catch (error) {
    const missing = /^Cannot find module '([^']+)'/.exec(error instanceof Error ? error.message : '');
    if (missing?.[1] && isAbsolute(missing[1])) return canonical(missing[1]);
    throw error;
  }
}

describe.for(NAMES)('%s', (name) => {
  const dir = dirOf(name);
  const manifest = readJson(join(dir, 'package.json'));
  const entry = pkg(name);

  test('package.json declares exactly the edges of the table', () => {
    expect(manifest.name).toBe(name);
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(sorted(Object.keys(manifest.dependencies ?? {}))).toEqual(
      sorted([...workspaceEdges(name), ...entry.thirdParty, ...entry.declaredOnly]),
    );
    expect(sorted(Object.keys(manifest.devDependencies ?? {}))).toEqual(
      sorted(entry.dev.filter((d) => !workspaceEdges(name).includes(d))),
    );
    for (const [dep, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      expect(range, dep).toBe(NAMES.includes(dep) ? 'workspace:*' : 'catalog:');
    }
  });

  test('exports are source-first: the barrel, the contract-style entry points, and the area pattern', () => {
    const sourceFirst = (target: string) => ({ types: target, default: target });
    expect(manifest.exports).toEqual({
      '.': sourceFirst('./src/index.ts'),
      ...Object.fromEntries(Object.entries(entry.entryPoints).map(([sub, target]) => [sub, sourceFirst(target)])),
      './*': sourceFirst('./src/*/index.ts'),
    });
    expect(existsSync(join(dir, 'src/index.ts'))).toBe(true);
  });

  test('tsconfig.json is composite through the base config and references exactly the dependency edges', () => {
    const tsconfig = readJson(join(dir, 'tsconfig.json'));
    expect(tsconfig.extends).toBe('../../tsconfig.base.json');
    expect(tsconfig.include).toEqual(['src']);
    const referenced = (tsconfig.references ?? []).map((r: { path: string }) => relative(REPO_ROOT, join(dir, r.path)));
    expect(sorted(referenced)).toEqual(sorted(workspaceEdges(name).map((d) => pkg(d).dir)));
  });

  test('every module name the package may import resolves from its directory', () => {
    for (const dep of allEdges(name)) {
      const found = locate(dep, dir);
      expect(found, `${dep} from ${entry.dir}`).toBeDefined();
      expect(found?.startsWith(join(dir, 'node_modules') + sep), `${dep} is linked for ${entry.dir} itself`).toBe(true);
      expect(realpathSync(found ?? '')).toBe(join(dirOf(dep), 'package.json'));

      expect(resolveTarget(dep, dir)).toBe(join(dirOf(dep), 'src/index.ts'));
      for (const [sub, target] of Object.entries(pkg(dep).entryPoints)) {
        expect(resolveTarget(`${dep}/${sub.slice(2)}`, dir), `${dep}/${sub.slice(2)}`).toBe(join(dirOf(dep), target));
      }
      expect(resolveTarget(`${dep}/some/area`, dir)).toBe(join(dirOf(dep), 'src/some/area/index.ts'));
    }
    for (const dep of [...entry.thirdParty, ...entry.declaredOnly]) {
      const found = locate(dep, dir);
      expect(found?.startsWith(join(dir, 'node_modules') + sep), `${dep} from ${entry.dir}`).toBe(true);
    }
    for (const allowance of layers.rules.a.devToolImports) {
      if (!allowance.paths.some((p) => p.startsWith(`${entry.dir}/`))) continue;
      for (const tool of allowance.modules) expect(locate(tool, dir), `${tool} from ${entry.dir}`).toBeDefined();
    }
  });

  test('an edge absent from the table is not linked, and an absent third-party name does not resolve', () => {
    // pnpm links into a package's own node_modules only what that package declares. A workspace name
    // that is NOT declared is still reachable by walking up to the repository root (the root declares
    // every @cohorte/* package for tests/** and scripts/**, PLAN PC-9), and `tsc -b` does not refuse it
    // either (reference-net.test.ts): check-layers is the ONLY net for that case, and
    // docs/v3/workspace.md says so.
    for (const other of NAMES.filter((n) => n !== name && !allEdges(name).includes(n))) {
      expect(existsSync(join(dir, 'node_modules', other)), `${entry.dir} -> ${other}`).toBe(false);
    }
    const declared = new Set([...entry.thirdParty, ...entry.declaredOnly]);
    for (const thirdParty of layers.thirdPartyUniverse.filter((t) => !declared.has(t))) {
      expect(locate(thirdParty, dir), `${thirdParty} from ${entry.dir}`).toBeUndefined();
    }
  });
});

describe('repository root', () => {
  const manifest = readJson(join(REPO_ROOT, 'package.json'));
  const workspace = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');

  test('declares every @cohorte/* package and the dev tools, and nothing else', () => {
    expect(manifest.dependencies).toBeUndefined();
    expect(sorted(Object.keys(manifest.devDependencies))).toEqual(
      sorted([...layers.root.dev, ...layers.root.devTools]),
    );
    expect(sorted(layers.root.dev)).toEqual(sorted(NAMES.filter((n) => n.startsWith('@cohorte/'))));
    for (const dep of [...layers.root.dev, ...layers.root.devTools]) {
      expect(locate(dep, REPO_ROOT), dep).toBeDefined();
    }
    for (const thirdParty of layers.thirdPartyUniverse) {
      expect(
        locate(thirdParty, REPO_ROOT),
        `${thirdParty} must not be importable from tests/** or scripts/**`,
      ).toBeUndefined();
    }
  });

  test('pins the toolchain and the engine: packageManager, engines, catalog, overrides, allowBuilds', () => {
    expect(manifest.packageManager).toBe('pnpm@12.4.2');
    expect(manifest.engines.node).toBe('^24.16.0 || >=26.1.0');
    const line = (key: string, value: string) =>
      new RegExp(`^  '?${key.replace('/', '\\/')}'?: ${value.replace(/[.^]/g, '\\$&')}$`, 'm');
    for (const [key, value] of [
      ['typescript', '7.0.2'],
      ['tsdown', '0.23.0'],
      ['vitest', '^5.0.1'],
      ['@biomejs/biome', '2.5.14'],
      ['@types/node', '^24'],
      ['ajv', '^8.20.0'],
      ['typebox', '1.3.7'],
      ['yaml', '^2.9.1'],
      ['commander', '^15.0.0'],
      ['picomatch', '^4.0.7'],
      ['@earendil-works/pi-coding-agent', '0.85.1'],
      ['@earendil-works/pi-ai', '0.85.1'],
      ['@earendil-works/pi-agent-core', '0.85.1'],
    ] as const) {
      expect(workspace, `${key}: ${value}`).toMatch(line(key, value));
    }
    const overrides = workspace.slice(workspace.indexOf('\noverrides:'), workspace.indexOf('\nallowBuilds:'));
    for (const pinned of [
      "'@earendil-works/pi-agent-core': 0.85.1",
      "'@earendil-works/pi-ai': 0.85.1",
      "'@earendil-works/pi-coding-agent': 0.85.1",
      'typebox: 1.3.7',
    ]) {
      expect(overrides).toContain(pinned);
    }
    const allowBuilds = workspace.slice(workspace.indexOf('\nallowBuilds:'));
    for (const name of ["'@google/genai': false", 'esbuild: false', 'protobufjs: false'])
      expect(allowBuilds).toContain(name);
    expect(workspace).toMatch(/^packages:\n {2}- apps\/\*\n {2}- packages\/\*\n\n/m);
    expect(workspace).not.toMatch(/- (docs|legacy)/);
  });

  test('installs exactly one copy of each Pi package and of typebox, at the pinned version', () => {
    const lock = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    const versions = (name: string) =>
      new Set([...lock.matchAll(new RegExp(`^ {2}'?${name.replace('/', '\\/')}@([^:'(]+)`, 'gm'))].map((m) => m[1]));
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core']) {
      expect([...versions(name)], name).toEqual(['0.85.1']);
    }
    expect([...versions('typebox')]).toEqual(['1.3.7']);
    expect(lock).not.toMatch(/^ {2}'?tsx@/m);
    expect(lock).not.toMatch(/sandbox-runtime/);
  });

  test('tsconfig.json references every package, and the reference graph has no cycle (TS6202)', {
    timeout: 60_000,
  }, () => {
    const rootConfig = readJson(join(REPO_ROOT, 'tsconfig.json'));
    expect(rootConfig.files).toEqual([]);
    expect(sorted(rootConfig.references.map((r: { path: string }) => r.path))).toEqual(
      sorted(NAMES.map((n) => pkg(n).dir)),
    );

    const dry = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-b', '--dry', '--pretty', 'false'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    // The planted cycle that proves tsc reports TS6202 at all is in reference-net.test.ts.
    expect(`${dry.stdout}${dry.stderr}`).not.toContain('TS6202');
    expect(dry.status).toBe(0);
  });
});
