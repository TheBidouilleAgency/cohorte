import type { Finding, ReviewResult } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import type { LoopPolicy, LoopState } from '../../src/contract/types.ts';
import { createLoopController } from '../../src/loop/index.ts';

const policy: LoopPolicy = {
  maxFixRounds: 5,
  noProgressWindow: 3,
  maxDeniedCallsPerAgent: 5,
  runWallClockMs: 60_000,
  escalation: { sameFailureCount: 2, ladder: [], maxPerRun: 0 },
};

const loop: LoopState = {
  fixRounds: 0,
  reviewRounds: 0,
  history: [],
  seenFingerprints: [],
  escalations: [],
  deniedCalls: {},
  startedAtMs: 0,
};

const deferredReview: ReviewResult = {
  verdict: 'needs-human',
  kept: [],
  refuted: [],
  deferred: [{} as Finding],
  needsInvestigation: [],
  blocking: 0,
  blockingItems: [],
  fingerprint: '',
  unreviewed: [],
  clean: false,
  counts: { critical: 0, major: 0, minor: 0, info: 0 },
};

describe('LoopController', () => {
  it('stops for human approval before treating deferred findings as clean', () => {
    const decision = createLoopController({}).decideAfterReview(deferredReview, loop, policy);

    expect(decision).toEqual({
      kind: 'stop',
      stop: {
        reason: 'approval-required',
        detail: '1 deferred finding(s) need a human decision (review-leftovers)',
        resumable: true,
        resumeRequires: 'approval',
      },
    });
  });
});
