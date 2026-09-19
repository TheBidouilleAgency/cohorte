import { describe, expect, test } from 'vitest';
import { classify } from '../../src/classify/index.ts';

describe('Pi runtime conformance', () => {
  test('classifies auth and transient provider failures from wire signals', () => {
    expect(classify({ origin: 'auth-check', text: 'No API key', modelsErrorCode: 'auth' }).code).toBe(
      'provider-terminal/auth-required',
    );
    expect(classify({ origin: 'model-response', text: 'fetch failed', causeCode: 'ECONNRESET' }).code).toBe(
      'provider-transient/network',
    );
  });
});
