import { describe, expect, test } from 'vitest';
import { issuesOf, samplesOf } from './samples.ts';

describe('fixtures/config', () => {
  const valid = samplesOf('valid');
  const invalid = samplesOf('invalid');

  test('there are samples of every kind on both sides', () => {
    const kinds = ['config', 'manifest', 'ownership', 'skill', 'spec'];
    expect([...new Set(valid.map((sample) => sample.kind))].sort()).toEqual(kinds);
    expect([...new Set(invalid.map((sample) => sample.kind))].sort()).toEqual(kinds);
  });

  test.for(valid)('valid/$name validates', (sample) => {
    expect(issuesOf(sample)).toEqual([]);
  });

  test.for(invalid)('invalid/$name fails at its documented JSON pointer', (sample) => {
    expect(sample.expect, 'an invalid sample documents where it fails: "# expect: <pointer>"').toBeDefined();
    const paths = issuesOf(sample).map((issue) => issue.path);
    expect(paths).toContain(sample.expect);
  });
});
