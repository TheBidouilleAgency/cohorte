#!/usr/bin/env node
// scripts/stage-publish.ts — DESIGN 1.4 step 4: `<dir>/.publish/{dist,assets,LICENSE,README.md,package.json}`.
// The generated `package.json` carries ONLY what a published package needs (name, version, license, type, bin,
// files, engines, dependencies, repository) — no `devDependencies`, no `scripts`, no `@cohorte/*` name (the
// toolchain-prototype leak this closes: pnpm rewrites `workspace:*` into a devDependency that names every private
// package). Dependency VERSIONS are read from the installed `apps/cli/node_modules/<pkg>/package.json`, so the
// staged manifest is always the exact version this build actually ran against (F-6: Pi's three packages and
// `typebox` are pinned exact; the same read gives an exact version for `commander`/`yaml`/`picomatch` too).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The union of both `tsdown.config.ts` entries' `deps.onlyImport` allowlists (DESIGN 1.2 net 4). */
export const RUNTIME_DEPENDENCY_NAMES = [
  'commander',
  'yaml',
  'picomatch',
  'typebox',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
] as const;

export interface StagePublishOptions {
  readonly repoRoot: string;
  readonly appDir: string; // apps/cli
  readonly distDir: string; // <outDir>/dist, already built
  readonly assetsDir: string; // <outDir>/assets, already embedded
  readonly publishDir: string; // <outDir>/.publish
}

function resolvedVersion(appNodeModules: string, name: string): string {
  const pkgPath = join(appNodeModules, ...name.split('/'), 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`stage-publish: ${name} is not installed under ${appNodeModules}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error(`stage-publish: ${name}'s package.json has no version`);
  return pkg.version;
}

export function stagePublish(options: StagePublishOptions): void {
  const { repoRoot, appDir, distDir, assetsDir, publishDir } = options;
  if (existsSync(publishDir)) rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(publishDir, { recursive: true });

  cpSync(distDir, join(publishDir, 'dist'), { recursive: true });
  cpSync(assetsDir, join(publishDir, 'assets'), { recursive: true });

  const licensePath = join(repoRoot, 'LICENSE');
  if (existsSync(licensePath)) cpSync(licensePath, join(publishDir, 'LICENSE'));
  const readmePath = join(repoRoot, 'README.md');
  if (existsSync(readmePath)) cpSync(readmePath, join(publishDir, 'README.md'));

  const appPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license: string;
    type: string;
    bin: Record<string, string>;
    engines: Record<string, string>;
    repository: unknown;
  };

  const appNodeModules = join(appDir, 'node_modules');
  const dependencies = Object.fromEntries(
    RUNTIME_DEPENDENCY_NAMES.map((name) => [name, resolvedVersion(appNodeModules, name)]),
  );

  const published = {
    name: appPkg.name,
    version: appPkg.version,
    license: appPkg.license,
    type: appPkg.type,
    bin: appPkg.bin,
    files: ['dist', 'assets'],
    engines: appPkg.engines,
    dependencies,
    repository: appPkg.repository,
  };
  writeFileSync(join(publishDir, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = args[0];
  if (!out) {
    process.stderr.write('usage: stage-publish.ts <out-dir>\n');
    process.exitCode = 2;
    return;
  }
  const repoRoot = process.cwd();
  const appDir = join(repoRoot, 'apps/cli');
  stagePublish({
    repoRoot,
    appDir,
    distDir: join(out, 'dist'),
    assetsDir: join(out, 'assets'),
    publishDir: join(out, '.publish'),
  });
  process.stdout.write(`stage-publish: wrote ${join(out, '.publish')}\n`);
}

// `import.meta.main` (node >= 24.2), not a hand-rolled `import.meta.url === `file://${argv[1]}``: the latter is
// false whenever the file is reached through a symlink (how npm installs a `bin`) and breaks on any path
// carrying a space or a non-ASCII character (`import.meta.url` is percent-encoded, `argv[1]` is not).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `stage-publish failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
