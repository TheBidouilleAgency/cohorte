import { type Clock, parseId } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { FixedClock } from '../../src/index.ts';

describe('FixedClock', () => {
  test('is a Clock that starts at a fixed, documented instant and never moves on its own', async () => {
    const clock: Clock = new FixedClock();
    expect(clock.now()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(clock.now()).toBe('2026-01-01T00:00:00.000Z');
    expect(parseId('IsoInstant', clock.now()).ok).toBe(true);
  });

  test.for<readonly [string, ConstructorParameters<typeof FixedClock>[0], string]>([
    ['an ISO string', '2026-09-18T10:20:30.123Z', '2026-09-18T10:20:30.123Z'],
    ['epoch milliseconds', 0, '1970-01-01T00:00:00.000Z'],
    ['a Date', new Date('2030-01-02T03:04:05.006Z'), '2030-01-02T03:04:05.006Z'],
  ])('starts from %s', ([, start, expected]) => {
    expect(new FixedClock(start).now()).toBe(expected);
  });

  test('refuses an invalid start', () => {
    expect(() => new FixedClock('yesterday')).toThrow(RangeError);
  });

  test('advance moves both clocks by exactly that much', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    clock.advance(1_500);
    expect(clock.now()).toBe('2026-01-01T00:00:01.500Z');
    expect(clock.monotonicMs()).toBe(1_500);
    clock.advance(8 * 3_600_000);
    expect(clock.now()).toBe('2026-01-01T08:00:01.500Z');
  });

  test.for([-1, Number.NaN, Number.POSITIVE_INFINITY])('time never goes back: advance(%s) is refused', (ms) => {
    expect(() => new FixedClock().advance(ms)).toThrow(RangeError);
  });

  test('setWallClock moves now() without touching the monotonic clock or the sleepers', () => {
    const clock = new FixedClock();
    clock.advance(10);
    clock.setWallClock('2020-01-01T00:00:00.000Z');
    expect(clock.now()).toBe('2020-01-01T00:00:00.000Z');
    expect(clock.monotonicMs()).toBe(10);
  });

  test('a sleeper wakes only when advance crosses its deadline', async () => {
    const clock = new FixedClock();
    let woken = false;
    const sleeping = clock.sleep(1_000).then(() => {
      woken = true;
    });
    expect(clock.pendingSleeps()).toBe(1);

    clock.advance(999);
    await Promise.resolve();
    expect(woken).toBe(false);

    clock.advance(1);
    await sleeping;
    expect(woken).toBe(true);
    expect(clock.pendingSleeps()).toBe(0);
  });

  test('sleepers wake in deadline order, first come first served on a tie', async () => {
    const clock = new FixedClock();
    const order: string[] = [];
    const all = Promise.all([
      clock.sleep(300).then(() => order.push('c')),
      clock.sleep(100).then(() => order.push('a1')),
      clock.sleep(200).then(() => order.push('b')),
      clock.sleep(100).then(() => order.push('a2')),
    ]);
    clock.advance(1_000);
    await all;
    expect(order).toEqual(['a1', 'a2', 'b', 'c']);
  });

  test('sleep(0) and a negative delay resolve without an advance', async () => {
    const clock = new FixedClock();
    await clock.sleep(0);
    await clock.sleep(-5);
    expect(clock.pendingSleeps()).toBe(0);
  });

  test('an aborted sleep rejects with the abort reason and is forgotten', async () => {
    const clock = new FixedClock();
    const reason = new Error('cancelled');
    await expect(clock.sleep(10, AbortSignal.abort(reason))).rejects.toBe(reason);

    const controller = new AbortController();
    const sleeping = clock.sleep(10, controller.signal);
    controller.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
    expect(clock.pendingSleeps()).toBe(0);
    clock.advance(100);
  });

  test('tick wakes sleepers AT their deadline and lets their continuations run, including the sleeps they start', async () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const seen: string[] = [];
    const worker = (async () => {
      for (let i = 0; i < 3; i += 1) {
        await clock.sleep(60_000);
        seen.push(clock.now());
      }
    })();

    await clock.tick(10 * 60_000);
    await worker;

    expect(seen).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z']);
    expect(clock.now()).toBe('2026-01-01T00:10:00.000Z');
    expect(clock.monotonicMs()).toBe(600_000);
  });

  test('autoAdvance: a sleep moves the clock itself, so retry back-offs do not hang a test', async () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z', { autoAdvance: true });
    await clock.sleep(30_000);
    await clock.sleep(1_500);
    expect(clock.now()).toBe('2026-01-01T00:00:31.500Z');
    expect(clock.pendingSleeps()).toBe(0);
  });

  test('two clocks share nothing', () => {
    const a = new FixedClock();
    const b = new FixedClock();
    a.advance(5);
    expect(b.monotonicMs()).toBe(0);
  });
});
