import { describe, expect, test } from 'vitest';
import { createCommandAuthenticator } from '../../src/auth/index.ts';

describe('command authenticator', () => {
  test('verifies the canonical body and rejects tampering', () => {
    const authenticator = createCommandAuthenticator();
    const key = new Uint8Array(32).fill(7);
    const signature = authenticator.sign('{"type":"start"}', key);

    expect(authenticator.verify('{"type":"start"}', signature, key)).toBe(true);
    expect(authenticator.verify('{"type":"cancel"}', signature, key)).toBe(false);
    expect(authenticator.verify('{"type":"start"}', `${signature}00`, key)).toBe(false);
  });
});
