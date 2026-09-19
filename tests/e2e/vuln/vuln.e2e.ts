import { describe, expect, test } from 'vitest';
import { calculateReview } from '../../../packages/core/src/review/normalize.ts';

describe('vulnerability remediation', () => {
  test('preserves a reproducible security finding for approval and accepts the clean re-review', () => {
    const finding = {
      severity: 'critical',
      kind: 'security',
      rule: 'S-61',
      location: { file: 'src/auth.ts', line: 4 },
      reproduction: 'pnpm test security',
      expected: 'secret is not exposed',
      actual: 'secret is echoed to the model',
      confidence: 1,
      scope: 'in-scope',
    } as const;
    const first = calculateReview([finding], [], new Set(['src/auth.ts']));
    expect(first.clean).toBe(false);
    expect(first.verdict).toBe('needs-human');
    expect(first.blockingItems).toHaveLength(1);

    const fixed = calculateReview([], [], new Set());
    expect(fixed.clean).toBe(true);
    expect(fixed.verdict).toBe('approved');
  });
});
