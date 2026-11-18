import { describe, expect, it } from 'vitest';
import { buildRoute, parseRoute } from './route';

const TABS = ['overview', 'specs', 'run'];
describe('hash routing', () => {
  it('builds and parses a project tab', () => {
    const h = buildRoute('0123456789', 'specs');
    expect(h).toBe('#/p/0123456789/specs');
    expect(parseRoute(h, TABS)).toEqual({ projectId: '0123456789', tab: 'specs' });
  });
  it('overview is the default and stays implicit', () => {
    expect(buildRoute('0123456789', 'overview')).toBe('#/p/0123456789');
    expect(parseRoute('#/p/0123456789', TABS)).toEqual({ projectId: '0123456789', tab: null });
  });
  it('home is #/', () => { expect(buildRoute(null, 'run')).toBe('#/'); expect(parseRoute('#/', TABS)).toEqual({ projectId: null, tab: null }); });
  it('rejects ids that are not a registry id and unknown tabs', () => {
    expect(parseRoute('#/p/../../etc', TABS).projectId).toBeNull();
    expect(parseRoute('#/p/0123456789/nope', TABS)).toEqual({ projectId: '0123456789', tab: null });
    expect(parseRoute('#token=abc', TABS).projectId).toBeNull();
  });
});
