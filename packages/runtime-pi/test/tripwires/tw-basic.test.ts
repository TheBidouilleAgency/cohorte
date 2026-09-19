import { describe, expect, test } from 'vitest';
import { HOST_PROTOCOL } from '../../src/protocol.ts';

describe('Pi tripwires', () => {
  test('host protocol remains pinned', () => {
    expect(HOST_PROTOCOL).toBe(1);
  });
});
