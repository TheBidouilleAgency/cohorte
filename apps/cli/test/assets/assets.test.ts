import { describe, expect, test } from 'vitest';
import { createAssetSource } from '../../src/assets/index.ts';

describe('AssetSource', () => {
  test('verifies the embedded asset tree and exposes stable roots', async () => {
    const assets = createAssetSource();
    // The source tree has no generated manifest; the private build validates this same source against one.
    const verification = await assets.verify();
    expect(verification.ok).toBe(false);
    if (!verification.ok) expect(verification.error.code).toBe('security/asset-hash-mismatch');
    expect(assets.treeSha256()).toMatch(/^[0-9a-f]{64}$/);
    const prompt = await assets.prompt('README.md');
    expect(prompt.bytes).toBeGreaterThan(0);
    expect(prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
