import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { createBlobStore } from '../../src/blob/index.ts';

describe('file-backed BlobStore', () => {
  test('stores content by digest and can read it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-cas-'));
    try {
      const store = createBlobStore({ dir: root });
      const bytes = new TextEncoder().encode('content-addressed');
      const address = await store.put(bytes);
      expect(address).toEqual({ sha256: sha256Hex(bytes), bytes: bytes.byteLength });
      expect(await store.read(address.sha256)).toEqual(bytes);
      expect(await store.has(address.sha256)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
