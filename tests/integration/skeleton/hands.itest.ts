// PLAN U2.INT / G2: named integration coverage for the real "hands" composition.
// The implementation is shared with the walking skeleton world so this test cannot silently drift to a toy-only
// substitute: it opens the real SQLite store, journal, lease manager, engine and fake runtime composition.
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_B, openSkeleton, seedIdleRun, signedStart } from './support.ts';

describe('hands composition', () => {
  let skeleton: Awaited<ReturnType<typeof openSkeleton>> | undefined;

  afterEach(async () => {
    await skeleton?.close();
  });

  it('runs a fake agent through the real gate, journal and SQLite store', async () => {
    skeleton = await openSkeleton();
    await seedIdleRun(skeleton);
    await skeleton.store.enqueueCommand(signedStart(skeleton));

    const stop = await skeleton.runHost(HOST_B);

    expect(stop.reason).toBe('review-clean');
    await expect(skeleton.store.getRun(skeleton.runId)).resolves.toMatchObject({ state: 'COMPLETED' });
    expect(skeleton.performs).toBe(1);
  });
});
