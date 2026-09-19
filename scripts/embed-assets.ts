#!/usr/bin/env node
// scripts/embed-assets.ts — DESIGN 1.4 step 2: `prompts/ skills/ schemas/ migrations/` -> `apps/cli/assets/**` +
// `assets/manifest.json`, with a deterministic `treeSha256` (verified in the toolchain prototype, <SCRATCH>
// understand/toolchain.md §3). `schemas/` does not exist yet (`scripts/gen-schemas.ts` is `U0.G`'s deliverable):
// an absent root simply contributes zero files, so this script — and `scripts/build.ts`, which calls it — works
// today and picks schemas up automatically once G0 writes them, with no code change (PLAN optimistic scheduling).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

export const ASSET_ROOTS = ['prompts', 'skills', 'schemas', 'migrations'] as const;
export const MANIFEST_VERSION = 1;

export interface AssetManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface AssetManifest {
  readonly manifestVersion: number;
  readonly cohorteVersion: string;
  readonly algorithm: 'sha256';
  readonly treeSha256: string;
  readonly files: readonly AssetManifestFile[];
}

export interface EmbedAssetsOptions {
  /** Directory holding `prompts/ skills/ schemas/ migrations/` (the repository root in production). */
  readonly repoRoot: string;
  /** Directory the four roots are copied into, alongside `manifest.json` (`apps/cli/assets` in production). */
  readonly outDir: string;
  readonly cohorteVersion: string;
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Files under one root, as POSIX paths relative to `outDir`, byte-sorted for a stable walk. */
function walk(absDir: string, relPrefix: string): string[] {
  if (!existsSync(absDir)) return [];
  const found: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = `${prefix}/${name}`;
      if (statSync(abs).isDirectory()) visit(abs, rel);
      else found.push(rel);
    }
  };
  visit(absDir, relPrefix);
  return found;
}

/** Byte order, not `localeCompare` (DESIGN 1.4 / toolchain.md §3: two runs must sort identically). */
function byByteOrder(a: string, b: string): number {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return Buffer.compare(bufA, bufB);
}

export function computeTreeSha256(files: readonly AssetManifestFile[]): string {
  const lines = files.map((file) => `${file.sha256}  ${file.path}\n`).join('');
  return sha256Hex(Buffer.from(lines, 'utf8'));
}

/** Copies the four roots into `outDir` and writes `outDir/manifest.json`. Deterministic: two runs over the same
 * source tree produce byte-identical manifests (order, hashes, treeSha256). */
export function embedAssets(options: EmbedAssetsOptions): AssetManifest {
  const { repoRoot, outDir, cohorteVersion } = options;
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const relPaths: string[] = [];
  for (const root of ASSET_ROOTS) {
    const absRoot = join(repoRoot, root);
    for (const rel of walk(absRoot, root)) relPaths.push(rel);
  }
  relPaths.sort(byByteOrder);

  const files: AssetManifestFile[] = relPaths.map((rel) => {
    const src = join(repoRoot, rel);
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const bytes = readFileSync(src);
    cpSync(src, dest);
    return { path: rel, size: bytes.length, sha256: sha256Hex(bytes) };
  });

  const manifest: AssetManifest = {
    manifestVersion: MANIFEST_VERSION,
    cohorteVersion,
    algorithm: 'sha256',
    treeSha256: computeTreeSha256(files),
    files,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export interface AssetMismatch {
  readonly path: string;
  readonly reason: 'missing' | 'hash-mismatch' | 'extra';
}

/** Re-hashes every file the manifest names (and lists any embedded file the manifest does not) — the toolchain
 * prototype's `verifyAssets`, minus the caveat it already states: this detects drift and partial updates in
 * `outDir`, not a rewrite of the manifest itself alongside it. */
export function verifyAssets(outDir: string): { ok: boolean; mismatches: AssetMismatch[] } {
  const manifestPath = join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, mismatches: [{ path: 'manifest.json', reason: 'missing' }] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AssetManifest;
  const mismatches: AssetMismatch[] = [];
  const seen = new Set<string>();
  for (const file of manifest.files) {
    seen.add(file.path);
    const abs = join(outDir, file.path);
    if (!existsSync(abs)) {
      mismatches.push({ path: file.path, reason: 'missing' });
      continue;
    }
    if (sha256Hex(readFileSync(abs)) !== file.sha256) mismatches.push({ path: file.path, reason: 'hash-mismatch' });
  }
  for (const rel of walk(outDir, '').map((p) => p.slice(1))) {
    if (rel === 'manifest.json' || seen.has(rel)) continue;
    mismatches.push({ path: rel, reason: 'extra' });
  }
  return { ok: mismatches.length === 0, mismatches };
}

function readCohorteVersion(repoRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'apps/cli/package.json'), 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : 'unknown';
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'repo-root': { type: 'string', default: process.cwd() },
      'out-dir': { type: 'string' },
      'cohorte-version': { type: 'string' },
      verify: { type: 'string' }, // pass a directory to verify instead of embedding
    },
  });
  if (values.verify) {
    const result = verifyAssets(values.verify as string);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const repoRoot = values['repo-root'] as string;
  const outDir = (values['out-dir'] as string | undefined) ?? join(repoRoot, 'apps/cli/assets');
  const cohorteVersion = (values['cohorte-version'] as string | undefined) ?? readCohorteVersion(repoRoot);
  const manifest = embedAssets({ repoRoot, outDir, cohorteVersion });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

// `import.meta.main` (node >= 24.2), not a hand-rolled `import.meta.url === `file://${argv[1]}``: the latter is
// false whenever the file is reached through a symlink (how npm installs a `bin`) and breaks on any path
// carrying a space or a non-ASCII character (`import.meta.url` is percent-encoded, `argv[1]` is not).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `embed-assets failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
