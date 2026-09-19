import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('AC-08 assets are packaged through a manifest with hashes', async () => {
  const buildDir = process.env.COHORTE_E2E_BUILD_DIR;
  if (!buildDir) return;
  const manifest = JSON.parse(await readFile(`${buildDir}/assets/manifest.json`, 'utf8')) as {
    files?: readonly { path: string; sha256: string }[];
    treeSha256?: string;
  };
  expect(manifest.treeSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.files?.some((file) => file.path === 'prompts/agents/implementer.md')).toBe(true);
});
