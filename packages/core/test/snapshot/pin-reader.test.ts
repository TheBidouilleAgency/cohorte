import { sha256Hex } from '@cohorte/base';
import { createMemoryBlobStore } from '@cohorte/persistence/memory';
import { FixedClock } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { createPinReader } from '../../src/snapshot/index.ts';

describe('PinReader', () => {
  test('reads and hashes files relative to the pinned installation', async () => {
    const bytes = new TextEncoder().encode('pinned asset\n');
    const store = createMemoryBlobStore();
    const { sha256 } = await store.put(bytes);
    const reader = createPinReader({
      installInspector: { installDir: () => '/install', bundleManifest: async () => [] },
      clock: new FixedClock(),
      pinStore: store,
      pinRefs: { 'asset.txt': { path: '/install/asset.txt', bytes: bytes.byteLength, sha256 } },
    });
    await expect(reader.read('asset.txt')).resolves.toEqual(bytes);
    expect(reader.ref('asset.txt')).toEqual({ path: '/install/asset.txt', bytes: bytes.byteLength, sha256 });
    expect(sha256).toBe(sha256Hex(bytes));
  });

  test('rejects absolute and escaping logical paths', async () => {
    const reader = createPinReader({
      installInspector: { installDir: () => '/install', bundleManifest: async () => [] },
      clock: new FixedClock(),
    });
    await expect(reader.read('../outside')).rejects.toThrow('configuration/pin-not-found');
    expect(() => reader.ref('/etc/passwd')).toThrow('configuration/pin-not-found');
  });
});
