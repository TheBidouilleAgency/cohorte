import { describe, expect, test } from 'vitest';
import { sanitizeHuman } from '../../src/render/sanitize.ts';

describe('human output sanitization', () => {
  test('keeps line structure but escapes C0, DEL and C1 controls', () => {
    expect(sanitizeHuman('ok\nnext\t\x1b[2K\u009b31m')).toBe('ok\nnext\t\\x1B[2K\\x9B31m');
  });
});
