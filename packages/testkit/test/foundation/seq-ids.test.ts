import { type EventId, type IdSource, parseId, type RunId } from '@cohorte/base';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { SeqIds } from '../../src/index.ts';

describe('SeqIds', () => {
  test('is an IdSource whose ids are the same in every run', () => {
    const mint = (): string[] => {
      const ids: IdSource = new SeqIds();
      return [ids.next('run'), ids.next('evt'), ids.next('evt'), ids.next('cmd'), ids.next('evt')];
    };
    expect(mint()).toEqual([
      'run_00000000000000000000000000000001',
      'evt_00000000000000000000000000000001',
      'evt_00000000000000000000000000000002',
      'cmd_00000000000000000000000000000001',
      'evt_00000000000000000000000000000003',
    ]);
    expect(mint()).toEqual(mint());
  });

  test.for([
    ['RunId', 'run'],
    ['EventId', 'evt'],
    ['CommandId', 'cmd'],
    ['ApprovalId', 'apr'],
    ['EffectId', 'eff'],
  ] as const)('a minted %s has the shape parseId demands', ([kind, prefix]) => {
    const id = new SeqIds().next(prefix);
    expect(parseId(kind, id)).toEqual({ ok: true, value: id });
  });

  test('counts per prefix, so adding an unrelated id does not renumber the others', () => {
    const ids = new SeqIds();
    ids.next('evt');
    ids.next('cmd');
    ids.next('cmd');
    expect(ids.next('evt')).toBe('evt_00000000000000000000000000000002');
    expect(ids.count('evt')).toBe(2);
    expect(ids.count('cmd')).toBe(2);
    expect(ids.count('apr')).toBe(0);
  });

  test('ids sort in minting order, like the real uuidv7 source', () => {
    const ids = new SeqIds();
    const minted: string[] = [];
    for (let i = 0; i < 300; i += 1) minted.push(ids.next('evt'));
    expect([...minted].sort()).toEqual(minted);
  });

  test('a seed offsets every counter', () => {
    const ids = new SeqIds({ seed: 0xff });
    expect(ids.next('evt')).toBe('evt_00000000000000000000000000000100');
    expect(ids.next('run')).toBe('run_00000000000000000000000000000100');
  });

  test.for([-1, 1.5, Number.NaN])('refuses the seed %s', (seed) => {
    expect(() => new SeqIds({ seed })).toThrow(RangeError);
  });

  test.for(['', 'Run', 'run_', 'a-b'])('refuses the prefix %j, like the real source', (prefix) => {
    expect(() => new SeqIds().next(prefix)).toThrow(TypeError);
  });

  test('two sources share nothing', () => {
    const a = new SeqIds();
    const b = new SeqIds();
    a.next('evt');
    a.next('evt');
    expect(b.next('evt')).toBe('evt_00000000000000000000000000000001');
  });

  test('mints the brand the caller names', () => {
    const ids = new SeqIds();
    expectTypeOf(ids.next<'RunId'>('run')).toEqualTypeOf<RunId>();
    expectTypeOf(ids.next<'EventId'>('evt')).toEqualTypeOf<EventId>();
  });
});
