import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REPO_ROOT } from './support/tree.ts';

// Structural facts of the scaffold that no other test pins: where V2 went, what stayed, what is
// ignored, and what the CI skeleton runs. The seven V2 suites themselves are run by
// `pnpm legacy:test` (the unit's check and the `legacy-v2` CI job), not from here.

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
const exists = (path: string) => existsSync(join(REPO_ROOT, path));

describe('legacy move (DESIGN D8, ADR-0014, PLAN PC-2)', () => {
  test.for(['bin', 'core', 'lib', 'profile', 'scripts', 'install.sh', 'install.ps1', 'package.json', '.npmignore'])(
    '%s lives under legacy/v2',
    (entry) => {
      expect(exists(join('legacy/v2', entry))).toBe(true);
    },
  );

  test('nothing of V2 is left at the root, and the root scripts/ holds only V3 tooling', () => {
    for (const gone of ['bin', 'core', 'lib', 'profile', 'install.sh', 'install.ps1', '.npmignore']) {
      expect(exists(gone), gone).toBe(false);
    }
    expect(readdirSync(join(REPO_ROOT, 'scripts')).filter((name) => /\.(mjs|sh|template)$/.test(name))).toEqual([]);
    expect(JSON.parse(read('package.json')).name).not.toBe('cohorte');
    expect(JSON.parse(read('legacy/v2/package.json'))).toMatchObject({ name: 'cohorte', version: '2.10.0' });
  });

  test.for(['LICENSE', 'CHANGELOG.md', 'README.md', 'docs', '.github', 'assets'])('%s stays at the root', (entry) => {
    expect(exists(entry)).toBe(true);
  });

  test('legacy/v2/README.md says reference only, and `legacy:test` runs the seven suites from legacy/v2', () => {
    expect(read('legacy/v2/README.md')).toMatch(/Nothing in here is on the V3 execution path/);
    expect(JSON.parse(read('package.json')).scripts['legacy:test']).toBe('node legacy/v2/run-suites.mjs');
    const runner = read('legacy/v2/run-suites.mjs');
    const suites = [...runner.matchAll(/^ {2}"([a-z-]+)",$/gm)].map((match) => match[1]);
    expect(suites).toEqual([
      'validate-core',
      'test-workflows',
      'test-adapter',
      'test-gate',
      'test-lib',
      'test-kanban',
      'test-metrics',
    ]);
    for (const suite of suites) expect(exists(`legacy/v2/scripts/${suite}.mjs`), suite).toBe(true);
    expect(runner).toMatch(/HOME: home/);
  });
});

describe('exclusions (PLAN §3 rule 12)', () => {
  const SHARED = ['legacy', '.cohorte', '.build', '**/dist', '**/node_modules'];

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

  test('.gitignore covers every generated directory, and re-points the two V2 script ignores', () => {
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
      'legacy/v2/scripts/new-feature.sh',
      'legacy/v2/scripts/remove-feature.sh',
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
        'legacy:test',
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

  test('keeps a legacy-v2 job that runs the V2 suites from legacy/v2', () => {
    expect(ci).toMatch(/^ {2}legacy-v2:$/m);
    expect(ci).toMatch(/working-directory: legacy\/v2/);
    expect(ci).toMatch(/pnpm ci:legacy-v2/);
  });

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
