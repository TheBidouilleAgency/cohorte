import { describe, expect, test } from 'vitest';
import * as barrel from '../../src/index.ts';
import { classify, createPiRuntimeProvider, pin } from '../../src/index.ts';

// Wave 1 replaces the stub BODIES while this file stays: it pins the frozen NAMES, not `throw new NotImplemented()`.
describe('the Wave-0 frozen barrel of runtime-pi', () => {
  test('every frozen name is a function', () => {
    for (const frozen of [classify, createPiRuntimeProvider, pin]) expect(frozen).toBeTypeOf('function');
  });

  test('the host protocol is private: the barrel does not re-export it', () => {
    expect(Object.keys(barrel).sort()).toEqual(['classify', 'createPiRuntimeProvider', 'pin']);
  });
});
