import { describe, expect, test } from 'vitest';
import { RESPONSE_HEADER_ALLOWLIST } from '../../src/parent/defaults.ts';

describe('Pi auth boundary', () => {
  test('keeps response headers allowlisted', () => {
    expect(RESPONSE_HEADER_ALLOWLIST).toContain('retry-after');
    expect(RESPONSE_HEADER_ALLOWLIST).not.toContain('authorization');
  });
});
