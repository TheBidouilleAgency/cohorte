import type { SurfaceId } from '@cohorte/base';
import type { Finding, ReviewResult } from '@cohorte/protocol';
import { calculateReview } from './normalize.ts';

export interface ReviewCalculator {
  compute(findings: readonly Finding[], unreviewed: SurfaceId[]): ReviewResult;
}
export type ReviewDeps = Record<string, never>;
export function createReviewCalculator(_deps: ReviewDeps): ReviewCalculator {
  return { compute: (findings, unreviewed) => calculateReview(findings, unreviewed) };
}
export { calculateReview, findingIdentity } from './normalize.ts';
