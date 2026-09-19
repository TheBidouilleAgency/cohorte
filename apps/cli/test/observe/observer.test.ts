import { describe, expect, test } from 'vitest';
import { createObserver } from '../../src/observe/index.ts';

describe('Observer', () => {
  test('replays durable events from the requested sequence without writing', async () => {
    let closed = 0;
    const store = {
      readEvents: async () => [
        { sequence: 1, sub: 0, type: 'run.created', payload: {} },
        { sequence: 2, sub: 0, type: 'run.state.changed', payload: {} },
      ],
      close: async () => {
        closed += 1;
      },
    };
    const values: unknown[] = [];
    for await (const value of createObserver(async () => store as never).follow({ runId: 'run_1', replay: 1 })) {
      values.push(value);
    }
    expect(values).toHaveLength(1);
    expect(closed).toBe(1);
  });
});
