import { describe, expect, test } from 'vitest';
import { HOST_PROTOCOL } from '../../src/protocol.ts';

describe('Pi child protocol', () => {
  test('publishes the frozen protocol version', () => {
    expect(HOST_PROTOCOL).toBe(1);
  });
});
