import { describe, expect, test } from 'vitest';
import { createHostSpawner } from '../../src/host/index.ts';

describe('HostSpawner', () => {
  test('requires the store and install verification bindings', async () => {
    await expect(createHostSpawner({ cwd: '/tmp/cohorte-test' }).spawnDetached('run_missing')).rejects.toMatchObject({
      info: { code: 'configuration/unexpected' },
    });
  });
});
