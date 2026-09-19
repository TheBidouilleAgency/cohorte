import { describe, expect, test } from 'vitest';
import { FaultInjector, InjectedFault } from '../../src/index.ts';

const hitSafely = (faults: FaultInjector, point: string): 'passed' | 'fired' => {
  try {
    faults.hit(point);
    return 'passed';
  } catch (error) {
    if (error instanceof InjectedFault) return 'fired';
    throw error;
  }
};

describe('FaultInjector', () => {
  test('is inert until armed', () => {
    const faults = new FaultInjector();
    for (let i = 0; i < 5; i += 1) faults.hit('journal.after-intent');
    expect(faults.hits('journal.after-intent')).toBe(5);
    expect(faults.fired()).toEqual([]);
  });

  test.for([1, 2, 3, 7])('fires at hit number %i only', (nth) => {
    const faults = new FaultInjector().arm('engine.before-commit', { nth });
    const outcomes: string[] = [];
    for (let i = 1; i <= 10; i += 1) outcomes.push(hitSafely(faults, 'engine.before-commit'));
    expect(outcomes.filter((o) => o === 'fired')).toHaveLength(1);
    expect(outcomes.indexOf('fired')).toBe(nth - 1);
    expect(faults.fired()).toEqual([{ point: 'engine.before-commit', occurrence: nth }]);
    expect(faults.hits('engine.before-commit')).toBe(10);
  });

  test('nth defaults to the first hit', () => {
    const faults = new FaultInjector().arm('p');
    expect(hitSafely(faults, 'p')).toBe('fired');
    expect(hitSafely(faults, 'p')).toBe('passed');
  });

  test('the nth occurrence is counted from the moment the point is armed', () => {
    const faults = new FaultInjector();
    faults.hit('p');
    faults.hit('p');
    faults.arm('p', { nth: 2 });
    expect(hitSafely(faults, 'p')).toBe('passed');
    expect(hitSafely(faults, 'p')).toBe('fired');
    expect(faults.fired()).toEqual([{ point: 'p', occurrence: 2 }]);
    expect(faults.hits('p')).toBe(4);
  });

  test('points are independent', () => {
    const faults = new FaultInjector().arm('a', { nth: 2 }).arm('b');
    expect(hitSafely(faults, 'a')).toBe('passed');
    expect(hitSafely(faults, 'c')).toBe('passed');
    expect(hitSafely(faults, 'b')).toBe('fired');
    expect(hitSafely(faults, 'a')).toBe('fired');
    expect(faults.fired()).toEqual([
      { point: 'b', occurrence: 1 },
      { point: 'a', occurrence: 2 },
    ]);
  });

  test('throws an InjectedFault that names the point and the occurrence', () => {
    const faults = new FaultInjector().arm('store.append', { nth: 1 });
    let caught: unknown;
    try {
      faults.hit('store.append');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InjectedFault);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ name: 'InjectedFault', point: 'store.append', occurrence: 1 });
    expect((caught as Error).message).toBe('injected fault at store.append (hit 1)');
  });

  test('can throw what the code under test would really see', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    const faults = new FaultInjector().arm('sqlite.commit', { nth: 1, error: () => busy });
    expect(() => faults.hit('sqlite.commit')).toThrow(busy);
    expect(faults.fired()).toEqual([{ point: 'sqlite.commit', occurrence: 1 }]);
  });

  test('disarm and reset', () => {
    const faults = new FaultInjector().arm('a').arm('b');
    faults.disarm('a');
    expect(hitSafely(faults, 'a')).toBe('passed');
    expect(faults.armed()).toEqual(['b']);
    faults.reset();
    expect(faults.armed()).toEqual([]);
    expect(faults.hits('a')).toBe(0);
    expect(faults.fired()).toEqual([]);
    expect(hitSafely(faults, 'b')).toBe('passed');
  });

  test('re-arming a point replaces the previous arming', () => {
    const faults = new FaultInjector().arm('p', { nth: 5 }).arm('p', { nth: 1 });
    expect(hitSafely(faults, 'p')).toBe('fired');
  });

  test.for([0, -1, 1.5, Number.NaN])('refuses nth = %s', (nth) => {
    expect(() => new FaultInjector().arm('p', { nth })).toThrow(RangeError);
  });

  test('refuses an empty point name', () => {
    expect(() => new FaultInjector().arm('')).toThrow(TypeError);
  });

  test('two injectors share nothing', () => {
    const a = new FaultInjector().arm('p');
    const b = new FaultInjector();
    expect(hitSafely(b, 'p')).toBe('passed');
    expect(hitSafely(a, 'p')).toBe('fired');
  });
});
