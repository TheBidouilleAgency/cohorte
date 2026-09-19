import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { verifyPinnedInstall } from '../../src/pin/index.ts';

describe('pinned install verification', () => {
  test('accepts matching files and rejects tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-pin-'));
    await mkdir(join(root, 'dist'), { recursive: true });
    const path = join(root, 'dist', 'cli.mjs');
    const bytes = 'pinned';
    await writeFile(path, bytes);
    const install = {
      installDir: () => root,
      bundleManifest: async () => [{ file: 'dist/cli.mjs', sha256: sha256Hex(bytes) as never, bytes: bytes.length }],
    };
    expect((await verifyPinnedInstall(install, root)).ok).toBe(true);
    await writeFile(path, 'tampered');
    const result = await verifyPinnedInstall(install, root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('security/runtime-pin-mismatch');
  });
});
