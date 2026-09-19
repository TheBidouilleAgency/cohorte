// apps/cli/src/assets/index.ts — AREA barrel: the `AssetSource` port (DESIGN 1.2 "embedded prompts/skills/
// schemas/migrations + manifest verification"). `__ASSETS_TREE_SHA256__` / `__COHORTE_VERSION__` are the DESIGN
// 1.4 step-3 bundle <-> assets cross-check: `tsdown.config.ts` `define`s them from `assets/manifest.json` at
// build time, so the bundled `cli.mjs` can assert its own tree hash without reading the manifest twice. Wave-0
// stub: filled by `U4.01`, which owns `apps/cli/src/assets/**`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { err, errorOf, ok, type Sha256, sha256Hex } from '@cohorte/base';
import type { AssetSource } from '../contract/index.ts';

declare global {
  /** injected by `apps/cli/tsdown.config.ts` (DESIGN 1.4 step 3); `'unknown'` when run un-bundled (tsc, vitest). */
  const __ASSETS_TREE_SHA256__: string;
  const __COHORTE_VERSION__: string;
}

/** `'unknown'` outside a tsdown bundle, where the `define`d globals do not exist. */
export const BUNDLED_ASSETS_TREE_SHA256: string =
  typeof __ASSETS_TREE_SHA256__ === 'string' ? __ASSETS_TREE_SHA256__ : 'unknown';
export const BUNDLED_COHORTE_VERSION: string =
  typeof __COHORTE_VERSION__ === 'string' ? __COHORTE_VERSION__ : 'unknown';

const ASSET_ROOTS = ['prompts', 'skills', 'schemas', 'migrations'] as const;
const bundledAssetCandidates = [
  resolve(import.meta.dirname, '../assets'),
  resolve(import.meta.dirname, '../../assets'),
];
const sourceAssetRoot = resolve(import.meta.dirname, '../../../../');
const assetRoot =
  bundledAssetCandidates.find((candidate) => existsSync(join(candidate, 'manifest.json'))) ?? sourceAssetRoot;
const safeId = (id: string): string[] => {
  const parts = id.split('/');
  if (
    parts.length < 1 ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\\'))
  )
    throw new Error(`invalid embedded asset id: ${id}`);
  return parts;
};
const findAsset = (root: (typeof ASSET_ROOTS)[number], id: string): { path: string; sha256: Sha256; bytes: number } => {
  const parts = safeId(id);
  const candidates = [
    join(assetRoot, root, ...parts),
    join(assetRoot, root, ...parts.slice(0, -1), `${parts.at(-1)}.md`),
  ];
  const path = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (path === undefined) throw new Error(`embedded asset not found: ${root}/${id}`);
  const rootPath = resolve(assetRoot, root);
  if (!path.startsWith(`${rootPath}/`) || !existsSync(path) || !statSync(path).isFile())
    throw new Error(`embedded asset not found: ${root}/${id}`);
  const bytes = readFileSync(path);
  return { path, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
};

export function createAssetSource(): AssetSource {
  return {
    prompt: async (id) => findAsset('prompts', id),
    skill: async (id) => findAsset('skills', id),
    schema: async (id) => findAsset('schemas', id),
    migration: async (id) => findAsset('migrations', id),
    treeSha256: () => {
      const manifestPath = join(assetRoot, 'manifest.json');
      if (!existsSync(manifestPath)) return sha256Hex(new Uint8Array()) as Sha256;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { treeSha256?: string };
      return (manifest.treeSha256 ?? '') as Sha256;
    },
    async verify() {
      const manifestPath = join(assetRoot, 'manifest.json');
      if (!existsSync(manifestPath))
        return err(errorOf('security/asset-hash-mismatch', 'embedded asset manifest is missing'));
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        files?: readonly { path: string; size: number; sha256: string }[];
        treeSha256?: string;
      };
      const mismatches = (manifest.files ?? []).filter((file) => {
        const path = join(assetRoot, file.path);
        if (!existsSync(path) || !statSync(path).isFile()) return true;
        const bytes = readFileSync(path);
        return bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256;
      });
      if (
        mismatches.length > 0 ||
        (BUNDLED_ASSETS_TREE_SHA256 !== 'unknown' && BUNDLED_ASSETS_TREE_SHA256 !== manifest.treeSha256)
      )
        return err(errorOf('security/asset-hash-mismatch', 'embedded assets do not match their manifest'));
      return ok(true);
    },
  };
}
