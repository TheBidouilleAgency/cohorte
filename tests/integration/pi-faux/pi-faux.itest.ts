import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createRunHost } from '../../../apps/cli/src/host/index.ts';
import type { RunId } from '../../../packages/base/src/index.ts';
import { createPiRuntimeProvider } from '../../../packages/runtime-pi/src/parent/index.ts';
import { FAKE_BRAIN_ENTRY } from '../../../packages/testkit/src/fake-brain/scripts/index.ts';
import { fakeRedactor } from '../../../packages/testkit/src/fake-redactor/index.ts';

describe('Pi faux composition seam', () => {
  test('pins the faux child and drives the real host lifecycle without credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-pi-faux-'));
    const provider = createPiRuntimeProvider({
      entryOverride: FAKE_BRAIN_ENTRY,
      redactor: fakeRedactor(),
      engine: { agentDir: join(root, 'agent'), authPath: join(root, 'auth.json') },
    });
    const pin = await provider.pin();
    expect(pin.artifacts.some((artifact) => artifact.role === 'agent-host-bundle')).toBe(true);
    let heartbeats = 0;
    const host = createRunHost({
      engine: {
        async run() {
          return { reason: 'review-clean', detail: 'faux smoke', resumable: false };
        },
      },
      runId: 'run_pi_faux' as RunId,
      cwd: root,
      targetRoot: join(root, 'target'),
      cohorteVersion: '3.0.0-test',
      heartbeat: () => {
        heartbeats += 1;
      },
    });
    await expect(host.run()).resolves.toEqual({ reason: 'review-clean', detail: 'faux smoke', resumable: false });
    expect(heartbeats).toBe(1);
  });
});
