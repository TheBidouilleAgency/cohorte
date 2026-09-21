import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REPO_ROOT } from './support/tree.ts';

// Structural facts of the V3 scaffold that no other test pins: what stayed at the root, what is
// ignored, and what the CI skeleton runs.

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
const exists = (path: string) => existsSync(join(REPO_ROOT, path));

describe('V3 workspace layout', () => {
  test('the retired V2 tree and installers are absent', () => {
    expect(exists('legacy')).toBe(false);
    for (const gone of ['bin', 'core', 'lib', 'profile', 'install.sh', 'install.ps1', '.npmignore']) {
      expect(exists(gone), gone).toBe(false);
    }
    expect(readdirSync(join(REPO_ROOT, 'scripts')).filter((name) => /\.(mjs|sh|template)$/.test(name))).toEqual([]);
    expect(JSON.parse(read('package.json')).name).not.toBe('cohorte');
  });

  test.for(['LICENSE', 'CHANGELOG.md', 'README.md', 'docs', '.github', 'assets'])('%s stays at the root', (entry) => {
    expect(exists(entry)).toBe(true);
  });

  test('the V3 package has no legacy test command', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['legacy:test']).toBeUndefined();
    expect(scripts['ci:legacy-v2']).toBeUndefined();
  });
});

describe('exclusions (PLAN §3 rule 12)', () => {
  const SHARED = ['.cohorte', '.build', '**/dist', '**/node_modules'];

  test('Biome ignores the shared set, plus docs/ (VitePress) and the brand assets/', () => {
    const includes: string[] = JSON.parse(read('biome.json')).files.includes;
    for (const pattern of [...SHARED, 'docs', 'assets']) expect(includes, pattern).toContain(`!${pattern}`);
  });

  test('vitest and the root tsconfigs exclude the shared set', () => {
    for (const config of ['vitest.config.ts', 'vitest.live.config.ts']) {
      for (const pattern of SHARED) expect(read(config), `${config}: ${pattern}`).toContain(`'${pattern}/**'`);
    }
    const excluded: string[] = JSON.parse(read('tsconfig.tests.json')).exclude;
    for (const pattern of SHARED) expect(excluded).toContain(`${pattern}/**`);
  });

  test('.gitignore covers every generated directory', () => {
    const ignored = read('.gitignore').split('\n');
    for (const line of [
      'node_modules/',
      '.build/',
      '.cohorte/state/',
      'apps/cli/dist/',
      'apps/cli/assets/',
      'apps/cli/.publish/',
      '*.tsbuildinfo',
      'dist-types/',
    ]) {
      expect(ignored, line).toContain(line);
    }
    expect(ignored).not.toContain('scripts/new-feature.sh');
  });
});

describe('toolchain configuration (ADR-0016)', () => {
  test('tsconfig.base.json carries the verified flags, with isolatedDeclarations off', () => {
    expect(JSON.parse(read('tsconfig.base.json')).compilerOptions).toEqual({
      target: 'es2023',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      lib: ['es2023'],
      types: ['node'],
      strict: true,
      composite: true,
      declaration: true,
      declarationMap: true,
      emitDeclarationOnly: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      isolatedDeclarations: false,
      erasableSyntaxOnly: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
    });
  });

  // noFloatingPromises is OFF, see docs/v3/requests/LEAD.md L1: Biome 2.5.14's type-aware analysis
  // overflows its worker stack on ordinary code AND still exits 0, so a crashed lint passed as a
  // clean one. What must hold instead is that a crash can never be read as green again.
  test('Biome is pinned by its schema, and a crashed lint is a failed lint', () => {
    const biome = JSON.parse(read('biome.json'));
    expect(biome.$schema).toContain('/2.5.14/');
    expect(biome.linter.rules.nursery.noFloatingPromises).toBe('off');
    const unitCheck = read('scripts/unit-check.ts');
    expect(unitCheck).toContain('overflowed its stack');
    expect(unitCheck).toContain('fatal runtime error');
  });

  // Existence only: the integrators add scripts later (`ci:local` and `ci:<job>` at G6, PLAN §4).
  test('root scripts: every name of PLAN U0.01 exists', () => {
    expect(Object.keys(JSON.parse(read('package.json')).scripts)).toEqual(
      expect.arrayContaining([
        'typecheck',
        'lint',
        'test',
        'test:e2e',
        'test:live',
        'verify',
        'unit:check',
        'build',
        'pack:check',
        'gen:schemas',
        'checkpoint',
      ]),
    );
  });

  test('apps/daemon is a README and not a workspace package', () => {
    expect(exists('apps/daemon/README.md')).toBe(true);
    expect(exists('apps/daemon/package.json')).toBe(false);
  });
});

describe('.github/workflows/ci.yml', () => {
  const ci = read('.github/workflows/ci.yml');

  test('has the verification jobs on a frozen lockfile', () => {
    for (const job of ['lint', 'typecheck', 'unit']) expect(ci).toMatch(new RegExp(`^ {2}${job}:$`, 'm'));
    for (const job of [
      'integration',
      'schema-compat',
      'migrations',
      'packaging',
      'e2e-fake',
      'crash-matrix',
      'security',
      'dogfood',
      'acceptance',
    ])
      expect(ci).toMatch(new RegExp(`^ {2}${job}:$`, 'm'));
    for (const job of [
      'lint',
      'typecheck',
      'unit',
      'integration',
      'schema-compat',
      'migrations',
      'packaging',
      'e2e-fake',
      'crash-matrix',
      'security',
      'dogfood',
      'acceptance',
    ])
      expect(ci).toContain(`pnpm ci:${job}`);
    expect(ci).not.toMatch(/pnpm install(?! --frozen-lockfile)/);
    expect(ci).toContain("'24.16.0'");
  });
});
