import { describe, expect, it } from 'vitest';
import { createBudgetTracker } from '../../src/budgets/index.ts';

describe('BudgetTracker', () => {
  it('reads the projected remaining counters without exposing mutable state', () => {
    const counters = { toolCalls: 2, wallClockMs: 1_500 };
    const tracker = createBudgetTracker({
      store: {} as never,
      billing: {} as never,
      readRemaining: (level, id) => {
        expect(level).toBe('agent');
        expect(id).toBe('agt_1');
        return counters;
      },
    });

    const result = tracker.remaining('agent', 'agt_1');
    expect(result).toEqual(counters);
    expect(result).not.toBe(counters);
  });

  it('fails open to an empty projection before the first budget snapshot exists', () => {
    const tracker = createBudgetTracker({ store: {} as never, billing: {} as never });
    expect(tracker.remaining('run', 'run_1')).toEqual({});
  });
});
