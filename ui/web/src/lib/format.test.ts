import { describe, expect, it } from 'vitest';
import { ago, usd } from './format';

describe('ago', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  it.each([['2026-01-01T11:59:50Z', 'just now'], ['2026-01-01T11:55:00Z', '5m ago'], ['2026-01-01T09:00:00Z', '3h ago'], ['2025-12-29T12:00:00Z', '3d ago'], ['nope', '']])('%s → %j', (iso, out) => { expect(ago(iso, now)).toBe(out); });
  it('formats money', () => { expect(usd(1.234)).toBe('$1.23'); expect(usd(null)).toBe('–'); });
});
