#!/usr/bin/env node
// scripts/build.ts — DESIGN 1.4, the whole packaging path under ONE output directory (PLAN §3 rule 6: "a unit
// never runs tsc -b, pnpm build without --out, gen-schemas in write mode, or pack in a shared directory"):
//   1. gen-schemas in CHECK mode (when `scripts/gen-schemas.ts` exists — U0.G; a missing script is not an error
//      here, see the note below): a build whose `schemas/` is stale is a build that must not be published
//   2. embed-assets      -> <out>/assets
//   3. tsdown, two entries (via COHORTE_BUILD_OUT_DIR, read by apps/cli/tsdown.config.ts) -> <out>/dist
//   4. stage-publish      -> <out>/.publish/{dist,assets,LICENSE,README.md,package.json}
//   5. write-bundle-manifest -> <out>/.publish/dist/bundle-manifest.json
//   6. <out>/.publish/node_modules -> symlink to apps/cli/node_modules (F-7: makes the linked build runnable
//      OFFLINE — the bundles keep commander/yaml/picomatch/typebox/Pi as bare external imports, and the repo root's
//      node_modules holds only root devDependencies)
//   7. self-run both entries offline from <out>: `cli.mjs --version`, `agent-host.mjs --selftest`
//
// DEVIATION from DESIGN 1.4's literal step numbering: step 1 (`scripts/gen-schemas.ts`) did not exist when this
// file was written — it is `U0.G`'s deliverable, and Wave 0 is sequential with `U0.10` running BEFORE `U0.G` (PLAN
// §1 shape: "... -> CLI registry + packaging path -> G0 freeze"). Per PLAN's optimistic-scheduling rule, this unit's
// own `check` had to be able to go green before that dependency existed, so the step stays soft: present -> run it;
// absent -> skip with a message and continue (embed-assets then simply finds no `schemas/` root, which is a no-op it
// already handles).
//
// It runs in CHECK mode (gate G1, docs/v3/requests/U0.G.md R6). In WRITE mode — which is what it did until G0 landed
// the script and made this step live — every private `build.ts --out .build/<unit>/` silently rewrote, and could
// `rm` under, the SHARED `schemas/**` of the working tree, against PLAN §3 rule 6 ("`schemas/` has one owner") and
// against this file's own step 1. Checking is also what DESIGN 1.4 means by "CI fails if `schemas/` is dirty".
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { embedAssets } from './embed-assets.ts';
import { stagePublish } from './stage-publish.ts';
import { writeBundleManifest } from './write-bundle-manifest.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '..');
export const APP_DIR = join(REPO_ROOT, 'apps/cli');

export class BuildUsageError extends Error {}

async function runGenSchemasIfPresent(repoRoot: string): Promise<void> {
  const genSchemasPath = join(repoRoot, 'scripts/gen-schemas.ts');
  if (!existsSync(genSchemasPath)) {
    process.stderr.write('build: scripts/gen-schemas.ts not present yet (U0.G); skipping schema check\n');
    return;
  }
  const loaded: unknown = await import(genSchemasPath);
  const generate = (
    loaded as { generateSchemas?: (options: { repoRoot: string; check: boolean }) => Promise<{ ok?: unknown }> }
  ).generateSchemas;
  if (typeof generate !== 'function') return;
  const result = await generate({ repoRoot, check: true });
  if (result.ok === false) {
    throw new BuildUsageError('build: schemas/ is out of date; run `pnpm gen:schemas` before building');
  }
}

function readCohorteVersion(appDir: string): string {
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : 'unknown';
}

/** Symlinks are recreated every build: a stale one (a prior build's target moved) must never linger. */
function relink(linkPath: string, target: string): void {
  if (existsSync(linkPath) || isBrokenSymlink(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, 'dir');
}

function isBrokenSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return !existsSync(path);
  } catch {
    return false;
  }
}

function runNode(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const done = spawnSync(process.execPath, [...args], { cwd, encoding: 'utf8' });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

export interface BuildResult {
  readonly outDir: string;
  readonly publishDir: string;
  readonly assetsFileCount: number;
  readonly bundleManifestFileCount: number;
  readonly cliVersionOutput: string;
  readonly agentHostSelftestOutput: string;
}

export async function build(outArg: string, options: { allowSharedDist?: boolean } = {}): Promise<BuildResult> {
  const outDir = resolve(process.cwd(), outArg);
  const allowSharedDist = options.allowSharedDist ?? process.env.COHORTE_ALLOW_SHARED_DIST === '1';
  if (!allowSharedDist && resolve(outDir) === resolve(APP_DIR)) {
    throw new BuildUsageError(
      'build.ts refuses to write the shared apps/cli directory; pass a private --out (or COHORTE_ALLOW_SHARED_DIST=1)',
    );
  }

  mkdirSync(outDir, { recursive: true });
  await runGenSchemasIfPresent(REPO_ROOT);

  const cohorteVersion = readCohorteVersion(APP_DIR);
  const assetsDir = join(outDir, 'assets');
  const manifest = embedAssets({ repoRoot: REPO_ROOT, outDir: assetsDir, cohorteVersion });

  process.env.COHORTE_BUILD_OUT_DIR = outDir;
  const { build: tsdownBuild } = await import('tsdown');
  // No `watch: true` in either entry (apps/cli/tsdown.config.ts): a one-shot build. `handle.watch.close()` would
  // throw ("watch is only available in watch mode") if called here, so this is the whole of tsdown's step.
  await tsdownBuild({ cwd: APP_DIR, config: true, logLevel: 'warn' });
  delete process.env.COHORTE_BUILD_OUT_DIR;

  const distDir = join(outDir, 'dist');
  const publishDir = join(outDir, '.publish');
  stagePublish({ repoRoot: REPO_ROOT, appDir: APP_DIR, distDir, assetsDir, publishDir });
  const bundleManifest = writeBundleManifest(join(publishDir, 'dist'));

  relink(join(publishDir, 'node_modules'), join(APP_DIR, 'node_modules'));

  const version = runNode([join(publishDir, 'dist/cli.mjs'), '--version'], publishDir);
  if (version.status !== 0) {
    throw new Error(`build: offline self-run of cli.mjs --version failed (exit ${version.status}): ${version.stderr}`);
  }
  const selftest = runNode([join(publishDir, 'dist/agent-host.mjs'), '--selftest'], publishDir);
  if (selftest.status !== 0) {
    throw new Error(
      `build: offline self-run of agent-host.mjs --selftest failed (exit ${selftest.status}): ${selftest.stderr}`,
    );
  }

  return {
    outDir,
    publishDir,
    assetsFileCount: manifest.files.length,
    bundleManifestFileCount: Object.keys(bundleManifest).length,
    cliVersionOutput: version.stdout.trim(),
    agentHostSelftestOutput: selftest.stdout.trim(),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, json: { type: 'boolean' } } });
  if (!values.out) {
    process.stderr.write('usage: build.ts --out <dir> [--json]\n');
    process.exitCode = 2;
    return;
  }
  const result = await build(values.out);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(
    `build: ${result.assetsFileCount} asset file(s), ${result.bundleManifestFileCount} bundle file(s) -> ${result.publishDir}\n` +
      `build: ${result.cliVersionOutput}\n` +
      `build: ${result.agentHostSelftestOutput}\n`,
  );
}

// `import.meta.main` (node >= 24.2), not a hand-rolled `import.meta.url === `file://${argv[1]}``: the latter is
// false whenever the file is reached through a symlink (how npm installs a `bin`) and breaks on any path
// carrying a space or a non-ASCII character (`import.meta.url` is percent-encoded, `argv[1]` is not).
if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof BuildUsageError) {
      process.stderr.write(`build: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`build failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
