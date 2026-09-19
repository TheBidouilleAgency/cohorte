import { describe, expect, test } from 'vitest';
import { FixedClock } from '../../src/fixed-clock/index.ts';

describe('testkit harness foundation', () => {
  test('provides a deterministic clock for probes and crash fixtures', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    expect(clock.now()).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(500);
    expect(clock.now()).toBe('2026-01-01T00:00:00.500Z');
  });
});
