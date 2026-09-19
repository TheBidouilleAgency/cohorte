import { describe, expect, test } from 'vitest';
import { createReviewCalculator } from '../../src/review/index.ts';

describe('review calculator', () => {
  test('an empty finding set is clean when every surface was reviewed', () => {
    const result = createReviewCalculator({}).compute([], []);
    expect(result.clean).toBe(true);
    expect(result.blocking).toBe(0);
  });
});
