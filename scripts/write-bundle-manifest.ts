#!/usr/bin/env node
// scripts/write-bundle-manifest.ts — DESIGN 1.4 step 5: `.publish/dist/bundle-manifest.json { "<file>": sha256 }`
// for every file under `dist/` (the tarball's own integrity map, independent of npm's `dist.integrity`).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';

export type BundleManifest = Readonly<Record<string, string>>;

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const abs = join(current, name);
      if (statSync(abs).isDirectory()) visit(abs);
      else found.push(abs);
    }
  };
  if (existsSync(dir)) visit(dir);
  return found;
}

/** `distDir` is `.publish/dist`. Excludes `bundle-manifest.json` itself: it cannot hash its own final bytes. */
export function writeBundleManifest(distDir: string): BundleManifest {
  const manifest: Record<string, string> = {};
  for (const abs of filesUnder(distDir)) {
    const rel = relative(distDir, abs).split(sep).join('/');
    if (rel === 'bundle-manifest.json') continue;
    manifest[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex');
  }
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(manifest).sort()) sorted[key] = manifest[key] as string;
  writeFileSync(join(distDir, 'bundle-manifest.json'), `${JSON.stringify(sorted, null, 2)}\n`);
  return sorted;
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const distDir = positionals[0];
  if (!distDir) {
    process.stderr.write('usage: write-bundle-manifest.ts <dist-dir>\n');
    process.exitCode = 2;
    return;
  }
  const manifest = writeBundleManifest(distDir);
  process.stdout.write(`write-bundle-manifest: ${Object.keys(manifest).length} file(s)\n`);
}

// `import.meta.main` (node >= 24.2), not a hand-rolled `import.meta.url === `file://${argv[1]}``: the latter is
// false whenever the file is reached through a symlink (how npm installs a `bin`) and breaks on any path
// carrying a space or a non-ASCII character (`import.meta.url` is percent-encoded, `argv[1]` is not).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `write-bundle-manifest failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
