import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunId, sha256Hex } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { createRunFiles } from '../../src/files/index.ts';

describe('file-backed RunFiles', () => {
  test('writes an artifact in its run directory with a stable digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-files-'));
    try {
      const files = createRunFiles({ dir: root });
      const id = 'run_file_test' as RunId;
      const bytes = new TextEncoder().encode('artifact\n');
      const record = await files.writeArtifact(id, 'artifacts/check.log', bytes);
      expect(record).toMatchObject({ path: 'artifacts/check.log', sha256: sha256Hex(bytes) });
      await expect(
        readFile(join(root, id, 'artifacts', 'check.log')).then((value) => new Uint8Array(value)),
      ).resolves.toEqual(bytes);
      await expect(files.writeArtifact(id, '../escape', bytes)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
