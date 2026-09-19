import { describe, expect, test } from 'vitest';
import { REPO_ROOT, selfCheck } from '../../../scripts/schema-compat.ts';

describe('schema compatibility', () => {
  test('all published schemas and current goldens validate independently with AJV', () => {
    const result = selfCheck({ repoRoot: REPO_ROOT });
    expect(result.ok, JSON.stringify(result.problems)).toBe(true);
    expect(result.schemasChecked).toBe(24);
    expect(result.fixturesChecked).toBeGreaterThan(0);
  });
});
