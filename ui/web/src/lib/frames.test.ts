import { describe, expect, it } from 'vitest';
import { backoff, parseFrames } from './frames';

describe('parseFrames', () => {
  it('reads batches and keeps the unfinished tail', () => {
    const r = parseFrames(': cohorte ui\n\ndata: [{"type":"job","projectId":"p","id":"1","status":"running"},{"type":"run","projectId":"p","id":"2","status":"done","pending":0}]\n\ndata: [{"type":"jo');
    expect(r.events.map((e) => e.id)).toEqual(['1', '2']);
    expect(r.rest).toBe('data: [{"type":"jo');
  });
  it('drops comments, bad JSON and foreign shapes', () => {
    const r = parseFrames(': keep-alive\n\ndata: nope\n\ndata: [{"type":"x","id":"1"}]\n\n');
    expect(r.events).toEqual([]);
    expect(r.rest).toBe('');
  });
  it('a frame split across chunks parses once complete', () => {
    const a = parseFrames('data: [{"type":"run","projectId":"p","id":"9","status":"running"}]');
    expect(a.events).toEqual([]);
    expect(parseFrames(`${a.rest}\n\n`).events).toHaveLength(1);
  });
});
describe('backoff', () => { it('doubles up to a cap', () => { expect([0, 1, 2, 3, 9].map(backoff)).toEqual([1000, 2000, 4000, 8000, 15000]); }); });
