import { createLoopController } from '@cohorte/core/loop';
import { describe, expect, test } from 'vitest';

describe('retry loop', () => {
  test('a clean test result continues toward the next transition', () => {
    const result = createLoopController({}).decideAfterTest(
      [{ name: 'test', status: 'passed', argv: ['true'], treeDigest: 'a'.repeat(64), durationMs: 1 }],
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
        maxDeniedCallsPerAgent: 2,
        runWallClockMs: 60_000,
        escalation: { sameFailureCount: 1, ladder: [], maxPerRun: 0 },
      },
    );
    expect(result.kind).toBe('continue');
  });
});
