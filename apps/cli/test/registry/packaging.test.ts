// apps/cli/test/registry/packaging.test.ts — PLAN U0.10 test list: "build guard: adding a Pi import to a file
// reachable from cli.ts fails the build (fixture); build.ts without --out refuses"; "acceptance = the packed
// tarball installs in an empty dir and both entries run"; "linked build: from .build/u0-10, with the network
// unavailable, both entries run; deleting the node_modules link reproduces ERR_MODULE_NOT_FOUND".
//
// `scripts/build.ts` and `scripts/pack-check.ts` are run as SUBPROCESSES (`node scripts/....ts ...`), never
// imported: `check-layers` rule a refuses a relative import that leaves `apps/cli` (`scripts/` is not a
// `@cohorte/*` package, so there is no "import by name" alternative either). The acceptance / linked-build /
// pack-check cases build ONCE (`beforeAll`) into a throwaway directory OUTSIDE the repo (never `.build/u0-10`,
// which is the literal `check` command's own artifact) and share it: each real build + `npm pack` + `npm install`
// is seconds, not milliseconds.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { UserConfig } from 'tsdown';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { COHORTE_VERSION } from '../../src/cli.ts';
import { VERBS } from '../../src/contract/index.ts';
import tsdownConfig from '../../tsdown.config.ts';

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const APP_DIR = join(REPO_ROOT, 'apps/cli');
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts/build.ts');
const PACK_CHECK_SCRIPT = join(REPO_ROOT, 'scripts/pack-check.ts');

/** DESIGN 1.2 net 4, transcribed BY HAND: "tsdown `deps.onlyImport` per entry: `cli` -> commander, yaml, picomatch,
 * typebox; `agent-host` -> `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
 * typebox." The point of writing it out is that adding Pi to the cli entry's allowlist must fail HERE. */
const DESIGN_CLI_ONLY_IMPORT = ['commander', 'yaml', 'picomatch', 'typebox'];
const DESIGN_AGENT_HOST_ONLY_IMPORT = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  'typebox',
];

/** The REAL `apps/cli/tsdown.config.ts` entry for one bundle — not a copy of it in a test fixture. */
function bundleConfig(configs: readonly UserConfig[], entryName: string): UserConfig {
  const found = configs.find((config) => {
    const entry = config.entry;
    return typeof entry === 'object' && !Array.isArray(entry) && entryName in entry;
  });
  if (!found) throw new Error(`apps/cli/tsdown.config.ts declares no "${entryName}" entry`);
  return found;
}

/** `deps.onlyImport` as the plain string allowlist DESIGN 1.2 net 4 describes (its declared type also admits a
 * bare string and `RegExp`s, neither of which this config may use: a pattern would be an unreadable allowlist). */
function onlyImportOf(config: UserConfig): readonly string[] {
  const allowed = config.deps?.onlyImport;
  if (!Array.isArray(allowed) || allowed.some((name) => typeof name !== 'string')) {
    throw new Error('apps/cli/tsdown.config.ts: deps.onlyImport must be an array of package names (DESIGN 1.2 net 4)');
  }
  return allowed as readonly string[];
}

interface BuildResult {
  readonly outDir: string;
  readonly publishDir: string;
  readonly cliVersionOutput: string;
  readonly agentHostSelftestOutput: string;
}
interface PackCheckResult {
  readonly tarballPath: string;
  readonly packedTopLevelPaths: readonly string[];
  readonly cliVersionOutput: string;
  readonly cliBinPath: string;
  readonly agentHostSelftestOutput: string;
  readonly verbProbe: { readonly status: number | null; readonly stderr: string };
}

/** Every file under `dir`, as a `/`-joined path relative to it. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const child of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, child.name);
      if (child.isDirectory()) visit(abs);
      else out.push(relative(dir, abs).split(/[\\/]/).join('/'));
    }
  };
  visit(dir);
  return out.sort();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('build.ts usage', () => {
  test('refuses to write the shared apps/cli directory (exit 2, nothing written)', () => {
    const done = spawnSync(process.execPath, [BUILD_SCRIPT, '--out', APP_DIR], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, COHORTE_ALLOW_SHARED_DIST: '' },
    });
    expect(done.status).toBe(2);
    expect(done.stderr).toMatch(/shared apps\/cli/);
  });

  test('refuses with no --out (exit 2)', () => {
    const done = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(done.status).toBe(2);
    expect(done.stderr).toMatch(/--out/);
  });
});

const cliEntry = bundleConfig(tsdownConfig, 'cli');
const hostEntry = bundleConfig(tsdownConfig, 'agent-host');

// DESIGN 1.2 net 4, the invariant these tests exist for: `cli.mjs` can never import Pi. The first three read the
// SHIPPED config (adding `@earendil-works/*` to the cli entry's allowlist fails them); the last proves the mechanism
// the config relies on really rejects an un-allowlisted import, using that same real allowlist.
describe('build guard: onlyImport', () => {
  test('the cli entry allows exactly DESIGN 1.2 net 4, and no @earendil-works/* package', () => {
    const allowed = onlyImportOf(cliEntry);
    expect(allowed).toEqual(DESIGN_CLI_ONLY_IMPORT);
    expect(allowed.some((name) => name.startsWith('@earendil-works/'))).toBe(false);
  });

  test('the agent-host entry allows exactly the three Pi packages plus typebox', () => {
    expect(onlyImportOf(hostEntry)).toEqual(DESIGN_AGENT_HOST_ONLY_IMPORT);
  });

  // `onlyBundle: []` is the silent-inlining guard (toolchain.md §3-5): NOTHING from node_modules may be inlined, so
  // a dependency that stops being external becomes a build error instead of a silently fattened bundle.
  test('both entries bundle nothing from node_modules (deps.onlyBundle: [])', () => {
    expect(cliEntry.deps?.onlyBundle).toEqual([]);
    expect(hostEntry.deps?.onlyBundle).toEqual([]);
  });

  test('a Pi import in a file reachable from the cli entry fails the build', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-build-guard-')));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        `${JSON.stringify(
          { name: 'guard-fixture', private: true, type: 'module', dependencies: { '@earendil-works/pi-ai': '0.85.1' } },
          null,
          2,
        )}\n`,
      );
      writeFileSync(join(dir, 'entry.ts'), "import '@earendil-works/pi-ai';\nexport const ok = 1;\n");
      // Inline config (`config: false`): a `tsdown.config.ts` file in the fixture would itself need to
      // `import 'tsdown'` resolvable from the temp dir; this process already has it (repo root devDependency).
      const { build: tsdownBuild } = await import('tsdown');
      await expect(
        tsdownBuild({
          cwd: dir,
          config: false,
          entry: { cli: 'entry.ts' },
          format: 'esm',
          platform: 'node',
          outDir: 'dist',
          dts: false,
          logLevel: 'silent',
          // The REAL cli entry's allowlist, not a hand-written stand-in: whatever the shipped config allows is what
          // this fixture is built against, so the test cannot drift from the guard it is supposed to prove.
          deps: { onlyBundle: [], onlyImport: [...onlyImportOf(cliEntry)] },
        }),
      ).rejects.toThrow(/onlyImport/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('a real build', () => {
  let outDir: string;
  let build: BuildResult;

  beforeAll(() => {
    outDir = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-u010-build-')));
    const done = spawnSync(process.execPath, [BUILD_SCRIPT, '--out', outDir, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (done.status !== 0) throw new Error(`build.ts --out ${outDir} failed: ${done.stderr}\n${done.stdout}`);
    build = JSON.parse(done.stdout);
  }, 120_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  // DESIGN 1.4 step 4, verbatim: "generated package.json has only name, version, license AGPL-3.0-only, type, bin,
  // files, engines, dependencies (Pi x3 exact, typebox 1.3.7 exact), repository — no devDependencies, no scripts,
  // no @cohorte/* names". `pack-check` proves the tarball INSTALLS; only this proves the manifest stayed minimal.
  test('the staged publish manifest is exactly DESIGN 1.4 step 4', () => {
    const pkg = JSON.parse(readFileSync(join(build.publishDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(pkg).sort()).toEqual([
      'bin',
      'dependencies',
      'engines',
      'files',
      'license',
      'name',
      'repository',
      'type',
      'version',
    ]);
    expect(pkg.scripts).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.name).toBe('cohorte');
    expect(pkg.version).toBe(COHORTE_VERSION);
    expect(pkg.license).toBe('AGPL-3.0-only');
    expect(pkg.type).toBe('module');
    expect(pkg.files).toEqual(['dist', 'assets']);
    expect(pkg.bin).toEqual({ cohorte: 'dist/cli.mjs' });
  });

  test('every published dependency is an EXACT version, and no @cohorte/* name leaks', () => {
    const pkg = JSON.parse(readFileSync(join(build.publishDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const names = Object.keys(pkg.dependencies).sort();
    expect(names.some((name) => name.startsWith('@cohorte/'))).toBe(false);
    // The union of both entries' allowlists (DESIGN 1.2 net 4): exactly what the bundles keep as bare imports.
    expect(names).toEqual([...new Set([...DESIGN_CLI_ONLY_IMPORT, ...DESIGN_AGENT_HOST_ONLY_IMPORT])].sort());
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      // No `^`, no `~`, no range: DESIGN 1.4 / PLAN F-6 — a caret on a 0.x Pi could install two `pi-ai` copies and
      // break `instanceof ModelsError`, and the same reasoning pins typebox (one `TSchema` identity).
      expect(version, `${name} must be pinned to an exact version, got "${version}"`).toMatch(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      );
    }
  });

  test('build.ts own offline self-run already proved both entries work', () => {
    expect(build.cliVersionOutput).toBe(COHORTE_VERSION);
    expect(build.agentHostSelftestOutput).toContain('pi=0.85.1');
  });

  test('the linked build runs both entries offline from <out>/.publish, independently of build.ts', () => {
    const publishDir = build.publishDir;
    const version = spawnSync(process.execPath, [join(publishDir, 'dist/cli.mjs'), '--version'], {
      cwd: publishDir,
      encoding: 'utf8',
      env: {}, // no PATH, no registry credentials: proves this needs no network
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(COHORTE_VERSION);

    const selftest = spawnSync(process.execPath, [join(publishDir, 'dist/agent-host.mjs'), '--selftest'], {
      cwd: publishDir,
      encoding: 'utf8',
      env: {},
    });
    expect(selftest.status).toBe(0);
    expect(selftest.stdout).toContain('pi=0.85.1');
  });

  // The blocker this whole file exists for: a runtime-computed `import()` specifier emits NO verb chunk, so the
  // built cli.mjs cannot execute a single verb — it tries to load a `.ts` file next to dist/, and the catch-all in
  // `cli.ts` turns ERR_MODULE_NOT_FOUND into the very exit code and message the stubs are supposed to produce.
  // Only running a verb through the BUILT bundle sees it. `loadCommandModule` runs BEFORE the `CliContext` is
  // composed, so a resolution failure would land here whatever a later wave makes the verb itself do.
  test('rolldown emits one chunk per verb under dist/chunks/', () => {
    // tsdown `chunkFileNames: 'chunks/[name]-[hash].mjs'`; `[name]` is the verb's own directory. Structural, and
    // deliberately so: it proves each `commands/<verb>/index.ts` really became a lazily loadable chunk.
    const chunks = walk(join(build.publishDir, 'dist/chunks')).filter((file) => file.endsWith('.mjs'));
    // Matched on the FULL hashed name, never on a prefix: `run-tool-CWZcC-bK.mjs` also starts with `run-`, so a
    // prefix test would let the `run` chunk disappear while staying green.
    const missing = VERBS.map((verb) => verb.name).filter(
      (name) => !chunks.some((chunk) => new RegExp(`^${escapeRegExp(name)}-[A-Za-z0-9_-]+\\.mjs$`).test(chunk)),
    );
    expect(missing, 'verbs with no code-split chunk in the built bundle').toEqual([]);
  });

  test.for(VERBS.map((verb) => verb.name))('the built cli.mjs resolves the %s command module', (verb) => {
    const done = spawnSync(process.execPath, [join(build.publishDir, 'dist/cli.mjs'), verb], {
      cwd: build.publishDir,
      encoding: 'utf8',
    });
    expect(done.stderr).not.toContain('Cannot find module');
    expect(done.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(done.stderr).not.toContain('.ts');
    // Every verb resolves to a command module and returns a classified/ordinary CLI status; the exact status belongs
    // to the command's own contract, not to the packaging/lazy-loader check.
    // `run` may reach the real project-policy gate after an earlier probe has created a config in the shared
    // throwaway publish directory; that is still a classified command result, not a lazy-loader failure.
    expect([0, 1, 2, 3, 4, 10, 13]).toContain(done.status);
  });

  test('every non-entry file under dist/ lives in dist/chunks/ (DESIGN 1.4 step 3)', () => {
    const entries = new Set(['cli.mjs', 'cli.mjs.map', 'agent-host.mjs', 'agent-host.mjs.map']);
    const stray = walk(join(build.publishDir, 'dist')).filter(
      (file) => !entries.has(file) && !file.startsWith('chunks/') && file !== 'bundle-manifest.json',
    );
    expect(stray, 'code-split chunks belong under dist/chunks/').toEqual([]);
  });

  // DESIGN 1.4 step 3's "bundle <-> assets cross-check". `apps/cli/src/assets/index.ts` (the `AssetSource` port) is
  // the consumer, and no bundle entry reaches it yet (Wave 4 wires it in), so both constants are tree-shaken out of
  // today's bundles — a typo in a define key, or a manifest path that stops resolving, would surface only then.
  // These two tests hold the config to its contract now, from the build that actually ran.
  test('both entries define __COHORTE_VERSION__ as the shipped version literal', () => {
    for (const entry of [cliEntry, hostEntry]) {
      expect(entry.define?.__COHORTE_VERSION__).toBe(JSON.stringify(COHORTE_VERSION));
    }
  });

  test('both entries define __ASSETS_TREE_SHA256__ as the manifest THIS build embedded', async () => {
    const manifest = JSON.parse(readFileSync(join(build.outDir, 'assets/manifest.json'), 'utf8')) as {
      treeSha256: string;
    };
    expect(manifest.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    // The config reads `COHORTE_BUILD_OUT_DIR` at module scope (that is how `build.ts --out` points it at a private
    // build), so the value is observable only by re-evaluating it with the same environment the build used.
    const previous = process.env.COHORTE_BUILD_OUT_DIR;
    process.env.COHORTE_BUILD_OUT_DIR = build.outDir;
    vi.resetModules();
    try {
      const reloaded = (await import('../../tsdown.config.ts')).default;
      for (const entryName of ['cli', 'agent-host']) {
        const define = bundleConfig(reloaded, entryName).define;
        expect(define?.__ASSETS_TREE_SHA256__, `${entryName}'s __ASSETS_TREE_SHA256__`).toBe(
          JSON.stringify(manifest.treeSha256),
        );
      }
    } finally {
      if (previous === undefined) delete process.env.COHORTE_BUILD_OUT_DIR;
      else process.env.COHORTE_BUILD_OUT_DIR = previous;
      vi.resetModules();
    }
  });

  test('deleting the node_modules link reproduces ERR_MODULE_NOT_FOUND (the regression F-7 guards)', () => {
    const link = join(build.publishDir, 'node_modules');
    rmSync(link, { recursive: true, force: true });
    const version = spawnSync(process.execPath, [join(build.publishDir, 'dist/cli.mjs'), '--version'], {
      cwd: build.publishDir,
      encoding: 'utf8',
    });
    expect(version.status).not.toBe(0);
    expect(version.stderr).toContain('ERR_MODULE_NOT_FOUND');
    // Restore it: the pack-check test below packs from the SAME .publish/dist and .publish/assets, which the
    // symlink never touches, but leaving the tree as `build.ts` left it is the honest thing for a failed run.
    symlinkSync(join(APP_DIR, 'node_modules'), link, 'dir');
  });

  test('pack-check: the packed tarball installs in an empty directory and both entries run', () => {
    const done = spawnSync(process.execPath, [PACK_CHECK_SCRIPT, outDir, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (done.status !== 0) throw new Error(`pack-check.ts ${outDir} failed: ${done.stderr}\n${done.stdout}`);
    const result: PackCheckResult = JSON.parse(done.stdout);
    expect(result.packedTopLevelPaths).not.toContain('node_modules');
    // Printed by the INSTALLED bin (`node_modules/.bin/cohorte`, a symlink), not by `dist/cli.mjs`: `bin` is the
    // only user-facing entry point of the package, and a main-module guard that a symlink defeats makes it print
    // nothing and exit 0 — which `dist/cli.mjs --version` would never have noticed.
    expect(result.cliBinPath).toMatch(/node_modules\/\.bin\/cohorte$/);
    expect(result.cliVersionOutput).toBe(build.cliVersionOutput);
    expect(result.agentHostSelftestOutput).toContain('pi=0.85.1');
    // A verb through the installed bin: the module resolves, whatever its command-level outcome.
    expect([0, 1, 2, 3, 4, 10]).toContain(result.verbProbe.status);
    expect(result.verbProbe.stderr).not.toContain('Cannot find module');
  }, 120_000);
});
