import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock, SeqIds } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { createController } from '../../src/control/index.ts';

describe('Controller', () => {
  test('enqueues start and creates the durable initial run atomically', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cohorte-controller-'));
    let enqueued = false;
    let runCreated = false;
    const store = {
      async transact(_scope: unknown, _lease: unknown, callback: (tx: unknown) => unknown) {
        const result = await callback({
          enqueueCommand: () => {
            enqueued = true;
            return 'enqueued';
          },
          putRun: () => {
            runCreated = true;
          },
        });
        return result;
      },
      async close() {},
    };
    const controller = createController({
      openStore: async () => store as never,
      clock: new FixedClock('2026-09-19T00:00:00.000Z'),
      ids: new SeqIds(),
      cwd: home,
      home,
      pinnedInstallDir: '/opt/cohorte/dist',
    });
    const result = await controller.send('start', { profile: 'feature', unattended: true });
    expect(result.status).toBe('pending');
    expect(enqueued).toBe(true);
    expect(runCreated).toBe(true);
  });
});
