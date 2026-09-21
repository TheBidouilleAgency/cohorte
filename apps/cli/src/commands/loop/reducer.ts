import type { ReviewResult } from '@cohorte/protocol';

export type LoopReducerDecision =
  | { outcome: 'ship' }
  | { outcome: 'continue'; key: string }
  | { outcome: 'abort'; reason: string };

/**
 * The V2 loop reducer, kept pure so a CLI invocation and a resumed run apply
 * exactly the same safety rules. A missing/invalid review never counts as a
 * clean review.
 */
export function decideLoop(
  review: ReviewResult | null,
  lastKey: string | undefined,
  round: number,
  maxRounds: number,
): LoopReducerDecision {
  if (!review) return { outcome: 'abort', reason: 'review-died' };
  if (review.verdict === 'needs-human' && review.unreviewed.length > 0) {
    return { outcome: 'abort', reason: 'unreviewed' };
  }
  if (review.unreviewed.length > 0) return { outcome: 'abort', reason: 'unreviewed' };
  if (review.verdict === 'needs-human' || review.deferred.length > 0) {
    return { outcome: 'abort', reason: 'approval-required' };
  }
  if (review.clean && review.blocking === 0) return { outcome: 'ship' };
  if (!Number.isInteger(review.blocking) || review.blocking < 0) {
    return { outcome: 'abort', reason: 'no-verdict' };
  }
  if (review.blocking === 0) return { outcome: 'ship' };
  const key = review.blockingItems.join('\n');
  if (!key) return { outcome: 'abort', reason: 'no-verdict' };
  if (lastKey !== undefined && key === lastKey) return { outcome: 'abort', reason: 'treading-water' };
  if (round >= maxRounds) return { outcome: 'abort', reason: 'max-rounds' };
  return { outcome: 'continue', key };
}

/** Extract only a closed ReviewResult from a controller/report payload. */
export function readReview(value: unknown): ReviewResult | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ReviewResult>;
  if (
    (candidate.verdict !== 'approved' && candidate.verdict !== 'findings' && candidate.verdict !== 'needs-human') ||
    !Array.isArray(candidate.unreviewed) ||
    !Array.isArray(candidate.deferred) ||
    !Array.isArray(candidate.blockingItems) ||
    typeof candidate.blocking !== 'number' ||
    typeof candidate.clean !== 'boolean'
  ) {
    return null;
  }
  return candidate as ReviewResult;
}
