import { ERROR_CLASSES, type ErrorClass } from '@cohorte/base';
import { describe, expect, it } from 'vitest';
import { RUN_EFFECT_BY_CLASS, runEffectOf } from '../../src/errors/catalogue.ts';

describe('RUN_EFFECT_BY_CLASS', () => {
  it('is total over ErrorClass', () => {
    for (const cls of ERROR_CLASSES) {
      const row = RUN_EFFECT_BY_CLASS[cls];
      expect(row).toBeDefined();
      expect(row.class).toBe(cls);
    }
    expect(Object.keys(RUN_EFFECT_BY_CLASS).sort()).toEqual([...ERROR_CLASSES].sort());
  });

  it('security maps to BLOCKED', () => {
    expect(RUN_EFFECT_BY_CLASS.security.endState).toBe('BLOCKED');
  });

  it('an unknown throwable (base UNCLASSIFIED = validation/unexpected) ends in FAILED + checkpoint', () => {
    // base's `toErrorInfo` fallback for a truly unclassifiable throwable is `validation/unexpected`.
    const row = RUN_EFFECT_BY_CLASS.validation;
    expect(row.endState).toBe('FAILED');
    expect(row.checkpoint).toBe(true);
  });

  it("every description is DESIGN 2.8's Run-effect cell, and no row contradicts its own endState", () => {
    // The Retry column is a SEPARATE column of DESIGN 2.8: no `description` may splice it in.
    for (const cls of ERROR_CLASSES) expect(RUN_EFFECT_BY_CLASS[cls].description).not.toMatch(/\(agent\/tool\)/);
    expect(RUN_EFFECT_BY_CLASS.timeout).toMatchObject({
      endState: 'WAITING_APPROVAL',
      checkpoint: false,
      description: 'retry / WAITING_APPROVAL',
    });
    // a description naming exactly one end state names the one the row carries
    expect(RUN_EFFECT_BY_CLASS.security.description).toContain('BLOCKED');
    expect(RUN_EFFECT_BY_CLASS.budget.description).toContain('WAITING_APPROVAL');
  });

  it('runEffectOf throws on a class outside ErrorClass', () => {
    expect(() => runEffectOf('not-a-class' as ErrorClass)).toThrow(TypeError);
  });

  it('runEffectOf agrees with the table', () => {
    for (const cls of ERROR_CLASSES) expect(runEffectOf(cls)).toBe(RUN_EFFECT_BY_CLASS[cls]);
  });
});
