import { describe, expect, it } from 'vitest';
import { countBySeverity, rec, surfaces, verifyChecks } from './reports';

describe('reports helpers', () => {
  it('reads verify checks defensively', () => {
    expect(verifyChecks({ checks: [{ name: 'run', status: 'PASS', note: '' }, 'junk', null] })).toEqual([{ name: 'run', status: 'PASS', note: '' }]);
    expect(verifyChecks({})).toEqual([]);
  });
  it('reads surfaces as a map (build) or a list (readiness)', () => {
    expect(surfaces({ surfaces: { api: 'ok', web: 'error' } })).toEqual([{ name: 'api', state: 'ok' }, { name: 'web', state: 'error' }]);
    expect(surfaces({ surfaces: ['api', 'web'] })).toEqual([{ name: 'api', state: '' }, { name: 'web', state: '' }]);
  });
  it('counts severities', () => { expect(countBySeverity([{ severity: 'HIGH' }, { severity: 'HIGH' }, { severity: 'LOW' }])).toEqual({ CRITICAL: 0, HIGH: 2, MEDIUM: 0, LOW: 1 }); });
  it('rec rejects arrays', () => { expect(rec([])).toBeNull(); expect(rec({ a: 1 })).toEqual({ a: 1 }); });
});
