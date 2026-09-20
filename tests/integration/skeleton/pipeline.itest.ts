// PLAN U3.INT / G3: named integration coverage for the composed pipeline path.
// This deliberately uses the same production engine composition as the skeleton, including the phase executor and
// tool effect, instead of asserting only individual orchestration units.
import { afterEach, describe, expect, it } from 'vitest';
import { eventTypes, HOST_B, openSkeleton, seedIdleRun, signedStart } from './support.ts';

describe('pipeline composition', () => {
  let skeleton: Awaited<ReturnType<typeof openSkeleton>> | undefined;

  afterEach(async () => {
    await skeleton?.close();
  });

  it('completes the composed phase and emits the durable lifecycle', async () => {
    skeleton = await openSkeleton();
    await seedIdleRun(skeleton);
    await skeleton.store.enqueueCommand(signedStart(skeleton));

    await skeleton.runHost(HOST_B);

    const types = await eventTypes(skeleton.store, skeleton.runId);
    expect(types).toContain('run.state.changed');
    expect(types).toContain('tool.completed');
    await expect(skeleton.store.verifyChain(skeleton.runId, skeleton.projectKey)).resolves.toMatchObject({ ok: true });
  });
});
