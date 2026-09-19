import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunId } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { createEphemeralSpool } from '../../src/spool/index.ts';

describe('file-backed EphemeralSpool', () => {
  test('tails lines strictly after a stream position', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-spool-'));
    try {
      const spool = createEphemeralSpool({ dir: root });
      const id = 'run_spool_test' as RunId;
      spool.append(id, JSON.stringify({ sequence: 1, sub: 0, type: 'delta' }));
      spool.append(id, JSON.stringify({ sequence: 2, sub: 0, type: 'delta' }));
      const controller = new AbortController();
      const lines: string[] = [];
      for await (const line of spool.tail(id, { sequence: 1, sub: 0 }, controller.signal)) {
        lines.push(line);
        controller.abort();
      }
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ sequence: 2, sub: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
