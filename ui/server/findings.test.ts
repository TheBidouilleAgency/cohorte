import { describe, expect, it } from 'vitest';
import { parseFinding, parseReviewReport } from './findings';

describe('parseFinding', () => {
  it('reads severity, location, category, problem and fix', () => {
    const f = parseFinding('- **[HIGH]** `apps/api/src/orders.ts:42` · security · missing authz on POST → **Fix:** add the guard');
    expect(f).toEqual({ severity: 'HIGH', file: 'apps/api/src/orders.ts', line: 42, category: 'security', problem: 'missing authz on POST', fix: 'add the guard', outOfScope: '' });
  });
  it('keeps the out-of-scope reason of a deferred item', () => {
    const f = parseFinding('- **[LOW]** `a.ts:1` · quality · naming → **Fix:** rename · out of scope: shared helper');
    expect(f?.outOfScope).toBe('shared helper');
    expect(f?.fix).toBe('rename');
  });
  it('tolerates a line range and a missing fix', () => {
    const f = parseFinding('- **[MEDIUM]** `a.ts:10-20` · complexity · yagni: unused option');
    expect(f).toMatchObject({ file: 'a.ts', line: 10, category: 'complexity', fix: '' });
  });
  it('ignores prose', () => { expect(parseFinding('None.')).toBeNull(); });
});

describe('parseReviewReport', () => {
  it('splits findings and deferred, sorted by severity', () => {
    const r = parseReviewReport('# REVIEW REPORT\nVerdict: REVISE\n\n## Findings\n\n- **[LOW]** `a:1` · quality · x\n- **[CRITICAL]** `b:2` · security · y → **Fix:** z\n\n## Deferred\n\n- **[HIGH]** `c:3` · quality · w\n\n## Notes\n- **[HIGH]** `n:1` · quality · not counted\n');
    expect(r.verdict).toBe('REVISE');
    expect(r.findings.map((f) => f.severity)).toEqual(['CRITICAL', 'LOW']);
    expect(r.deferred).toHaveLength(1);
  });
});
