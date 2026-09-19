import { describe, expect, test } from 'vitest';
import { createLoopController } from '../../src/loop/index.ts';

describe('loop controller', () => {
  test('environmental check errors stop before retry decisions', () => {
    const controller = createLoopController({});
    const decision = controller.decideAfterTest(
      [{ name: 'vitest', status: 'errored', treeDigest: 'tree' } as never],
      {
        fixRounds: 0,
        reviewRounds: 0,
        history: [],
        seenFingerprints: [],
        escalations: [],
        deniedCalls: {},
        startedAtMs: 0,
      },
      {
        maxFixRounds: 3,
        noProgressWindow: 2,
        maxDeniedCallsPerAgent: 1,
        runWallClockMs: 60_000,
        escalation: { maxPerRun: 0, ladder: [], sameFailureCount: 1 },
      },
    );
    expect(decision).toMatchObject({ kind: 'stop', stop: { reason: 'check-environment' } });
  });
});
