import { describe, expect, test } from 'vitest';
import { createUuidV7IdSource, type EventId, err, ok, parseId, type RunId, systemClock } from '../src/index.ts';

const UUID_V7_HEX = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;

describe('createUuidV7IdSource', () => {
  test('mints <prefix>_<uuidv7 without dashes>, accepted by parseId', () => {
    const ids = createUuidV7IdSource();
    const runId = ids.next<'RunId'>('run');
    expect(runId).toMatch(/^run_[0-9a-f]{32}$/);
    expect(runId.slice(4)).toMatch(UUID_V7_HEX);
    expect(parseId('RunId', runId)).toEqual({ ok: true, value: runId });
    expect(parseId('EventId', ids.next<'EventId'>('evt')).ok).toBe(true);
  });

  test('embeds the wall clock in the first 48 bits', () => {
    const ids = createUuidV7IdSource({ now: () => 0x0192_f0c1_a2b3 });
    expect(ids.next('evt').slice(4, 16)).toBe('0192f0c1a2b3');
  });

  // node:crypto's randomUUIDv7 is NOT ordered inside one millisecond (about half of 300k consecutive pairs
  // are inverted on Node 24.21), which is why base carries its own generator.
  test.for(['evt', 'cmd', 'eff'])(
    'ids are strictly increasing per prefix (%s), thousands per millisecond',
    (prefix) => {
      const ids = createUuidV7IdSource();
      let previous = '';
      for (let i = 0; i < 20_000; i += 1) {
        const id = ids.next(prefix);
        expect(id > previous).toBe(true);
        previous = id;
      }
    },
  );

  test('stays increasing across interleaved prefixes', () => {
    const ids = createUuidV7IdSource();
    const tails: string[] = [];
    for (let i = 0; i < 3_000; i += 1) tails.push(ids.next(i % 2 === 0 ? 'evt' : 'cmd').slice(4));
    expect([...tails].sort()).toEqual(tails);
    expect(new Set(tails).size).toBe(tails.length);
  });

  test('stays increasing when the wall clock stalls or steps back', () => {
    const times = [1_000, 1_000, 1_000, 900, 5, 1_001];
    let call = 0;
    const ids = createUuidV7IdSource({ now: () => times[Math.min(call++, times.length - 1)] ?? 0 });
    const minted: EventId[] = [];
    for (let i = 0; i < times.length; i += 1) minted.push(ids.next<'EventId'>('evt'));
    expect([...minted].sort()).toEqual(minted);
    expect(new Set(minted).size).toBe(minted.length);
  });

  test('rolls into the next millisecond when the counter space of one millisecond is exhausted', () => {
    const allOnes = (bytes: Uint8Array): void => {
      bytes.fill(0xff);
    };
    const ids = createUuidV7IdSource({ now: () => 1_000, random: allOnes });
    const a = ids.next('evt');
    const b = ids.next('evt');
    const c = ids.next('evt');
    expect(a < b && b < c).toBe(true);
    for (const id of [a, b, c]) expect(id.slice(4)).toMatch(UUID_V7_HEX);
  });

  test('two sources do not collide', () => {
    const a = createUuidV7IdSource();
    const b = createUuidV7IdSource();
    const minted = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) {
      minted.add(a.next('evt'));
      minted.add(b.next('evt'));
    }
    expect(minted.size).toBe(10_000);
  });

  test.for(['', 'Run', 'run_', 'a-b', '1a', 'x'.repeat(17)])('refuses the prefix %j', (prefix) => {
    expect(() => createUuidV7IdSource().next(prefix)).toThrow(TypeError);
  });
});

describe('systemClock', () => {
  test('now() is an IsoInstant close to Date.now()', () => {
    const now = systemClock.now();
    expect(parseId('IsoInstant', now)).toEqual({ ok: true, value: now });
    expect(Math.abs(Date.parse(now) - Date.now())).toBeLessThan(5_000);
  });

  test('monotonicMs() never goes back', () => {
    const a = systemClock.monotonicMs();
    const b = systemClock.monotonicMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test('sleep resolves after the delay', async () => {
    const before = systemClock.monotonicMs();
    await systemClock.sleep(20);
    expect(systemClock.monotonicMs() - before).toBeGreaterThanOrEqual(15);
  });

  test('sleep rejects with the abort reason, at once when already aborted', async () => {
    const reason = new Error('stop');
    await expect(systemClock.sleep(60_000, AbortSignal.abort(reason))).rejects.toBe(reason);

    const controller = new AbortController();
    const sleeping = systemClock.sleep(60_000, controller.signal);
    controller.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
  });

  test('an aborted sleep leaves no listener behind', async () => {
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners += 1;
      add(...args);
    }) as typeof add;
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listeners -= 1;
      remove(...args);
    }) as typeof remove;
    await systemClock.sleep(1, controller.signal);
    expect(listeners).toBe(0);
  });
});

describe('Result', () => {
  test('ok and err build the two arms', () => {
    const good = ok('run_1' as RunId);
    const bad = err('nope');
    expect(good).toEqual({ ok: true, value: 'run_1' });
    expect(bad).toEqual({ ok: false, error: 'nope' });
  });
});
