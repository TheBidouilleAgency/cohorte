#!/usr/bin/env node
// Install one immutable staged build side-by-side under a throwaway Cohorte HOME.
// The default test mode links dependencies to the workspace install; release mode can install the tarball.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DogfoodInstallOptions {
  readonly build: string;
  readonly home: string;
  readonly linkDeps: boolean;
}

function value(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function parse(args: readonly string[]): DogfoodInstallOptions {
  const build = value(args, '--build');
  const home = value(args, '--home');
  if (!build || !home) throw new Error('usage: dogfood-install.ts --build <dir> --home <dir> [--link-deps]');
  return { build: resolve(build), home: resolve(home), linkDeps: args.includes('--link-deps') };
}

function bundleSha8(publish: string): string {
  const manifestPath = join(publish, 'dist', 'bundle-manifest.json');
  const manifest = readFileSync(manifestPath, 'utf8');
  return createHash('sha256').update(manifest).digest('hex').slice(0, 8);
}

export function installDogfood(options: DogfoodInstallOptions): string {
  const publish = join(options.build, '.publish');
  const packagePath = join(publish, 'package.json');
  if (!existsSync(packagePath)) throw new Error(`dogfood-install: missing ${packagePath}`);
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string') throw new Error('dogfood-install: staged package has no version');

  const versions = join(options.home, '.cohorte', 'versions');
  const installDir = join(versions, `${packageJson.version}-${bundleSha8(publish)}`);
  mkdirSync(versions, { recursive: true });
  if (existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });
  cpSync(publish, installDir, { recursive: true, dereference: false });

  if (options.linkDeps) {
    const linked = join(installDir, 'node_modules');
    if (existsSync(linked) || lstatSync(linked, { throwIfNoEntry: false }))
      rmSync(linked, { recursive: true, force: true });
    symlinkSync(join(process.cwd(), 'apps', 'cli', 'node_modules'), linked, 'dir');
  }

  const pointer = { version: packageJson.version, installDir, bundleSha8: bundleSha8(publish) };
  writeFileSync(join(options.home, '.cohorte', 'pipeline.json'), `${JSON.stringify(pointer, null, 2)}\n`);
  return installDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify({ installDir: installDogfood(parse(process.argv.slice(2))) })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

export { parse as parseDogfoodOptions };
