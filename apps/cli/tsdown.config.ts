// apps/cli/tsdown.config.ts — DESIGN 1.4 step 3, DESIGN 1.2 net 4 "bundle allowlist". Two SEPARATE build configs
// (tsdown accepts an array, one bundle each) because the two entries need DIFFERENT `deps.onlyImport` allowlists:
// `cli.mjs` must never be able to import Pi (that is what keeps a read-only verb under francois.md's 10 s / 4 MiB
// one-shot budget), and `agent-host.mjs` is the only file allowed to import it (DESIGN 1.2 net 3 rule b).
//
// `define`s `__ASSETS_TREE_SHA256__` / `__COHORTE_VERSION__` from `apps/cli/assets/manifest.json` and
// `apps/cli/package.json`, written just before this config is loaded (`scripts/embed-assets.ts`, step 2 of DESIGN
// 1.4, always runs before step 3). Running `tsdown` directly, before assets exist, still produces a bundle: the
// definitions fall back to `'unknown'`, which is what `apps/cli/src/assets/index.ts` treats as "not bundled".
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsdown';

const here = import.meta.dirname;
const packageJsonPath = join(here, 'package.json');

// `scripts/build.ts --out <dir>` sets this so a PRIVATE unit/E2E build (PLAN §3 rule 6: never a shared
// `apps/cli/dist`) reads its own `<dir>/assets/manifest.json` and writes `<dir>/dist`, never the shared
// `apps/cli/{assets,dist}` that only the lead's un-prefixed `pnpm build` (DESIGN 10.1 rule 6) touches.
const privateOutDir = process.env.COHORTE_BUILD_OUT_DIR;
const manifestPath = privateOutDir
  ? join(privateOutDir, 'assets', 'manifest.json')
  : join(here, 'assets', 'manifest.json');
const outDir = privateOutDir ? join(privateOutDir, 'dist') : 'dist';

function readAssetsTreeSha256(): string {
  if (!existsSync(manifestPath)) return 'unknown';
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const treeSha256 = (manifest as { treeSha256?: unknown }).treeSha256;
  return typeof treeSha256 === 'string' ? treeSha256 : 'unknown';
}

function readCohorteVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const version = (pkg as { version?: unknown }).version;
  return typeof version === 'string' ? version : 'unknown';
}

const define = {
  __ASSETS_TREE_SHA256__: JSON.stringify(readAssetsTreeSha256()),
  __COHORTE_VERSION__: JSON.stringify(readCohorteVersion()),
};

const shared = {
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'node24.16',
  outDir,
  dts: false,
  sourcemap: true,
  define,
  // DESIGN 1.4 step 3: "code-split chunks allowed under dist/chunks/". `lazy.ts` emits one chunk per verb, so
  // without this the 34 verb chunks would sit beside the two entries and the tarball allowlist / bundle-manifest
  // readers (which are written against the DESIGN layout) would have to learn every hashed file name.
  outputOptions: { chunkFileNames: 'chunks/[name]-[hash].mjs' },
};

// `@cohorte/*` packages are private and bundled (workspace.md "net 4 ... the allowlist says nothing about them"):
// tsdown externalizes anything listed under `apps/cli/package.json` "dependencies" BY DEFAULT (an ordinary
// library-bundler default, unrelated to the source-first-resolves-outside-node_modules mechanic) and every
// `@cohorte/*` package IS listed there (U0.01, frozen) — so without `alwaysBundle` they would be left as bare
// `@cohorte/*` imports the published package can never resolve. `onlyImport` still refuses anything else that
// slips through unbundled.
const ALWAYS_BUNDLE_WORKSPACE = [/^@cohorte\//];

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    clean: true,
    // No explicit `banner`: `src/cli.ts` already starts with `#!/usr/bin/env node` and tsdown auto-detects it
    // from the entry chunk (a duplicate banner here was a `SyntaxError` at run time, not a warning).
    deps: {
      alwaysBundle: ALWAYS_BUNDLE_WORKSPACE,
      onlyBundle: [],
      onlyImport: ['commander', 'yaml', 'picomatch', 'typebox'],
    },
  },
  {
    ...shared,
    entry: { 'agent-host': '../../packages/runtime-pi/src/child/entry.ts' },
    // Both configs write into the SAME dist/: only the `cli` build cleans it first (order below).
    clean: false,
    deps: {
      alwaysBundle: ALWAYS_BUNDLE_WORKSPACE,
      onlyBundle: [],
      onlyImport: [
        '@earendil-works/pi-coding-agent',
        '@earendil-works/pi-ai',
        '@earendil-works/pi-agent-core',
        'typebox',
      ],
    },
  },
]);
