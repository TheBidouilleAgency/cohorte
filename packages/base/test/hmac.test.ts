import { describe, expect, test } from 'vitest';
import { ANCHOR_MAC_PURPOSE, canonicalJson, computeAnchorMac, hmacSha256Hex, type RunId } from '../src/index.ts';

const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('hmacSha256Hex', () => {
  test.for<readonly [string, Uint8Array, string | Uint8Array, string]>([
    [
      'RFC 4231 case 1',
      bytes('0b'.repeat(20)),
      'Hi There',
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    ],
    [
      'RFC 4231 case 2',
      utf8('Jefe'),
      'what do ya want for nothing?',
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    ],
    [
      'RFC 4231 case 3 (binary data)',
      bytes('aa'.repeat(20)),
      bytes('dd'.repeat(50)),
      '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
    ],
  ])('%s', ([, key, data, expected]) => {
    expect(hmacSha256Hex(key, data)).toBe(expected);
  });

  test('a string is authenticated as UTF-8', () => {
    const key = bytes('07'.repeat(32));
    expect(hmacSha256Hex(key, 'é')).toBe(hmacSha256Hex(key, utf8('é')));
  });

  test('refuses an empty key', () => {
    expect(() => hmacSha256Hex(new Uint8Array(0), 'x')).toThrow(RangeError);
  });
});

describe('computeAnchorMac', () => {
  const key = bytes('07'.repeat(32));
  const runId = 'run_0192f0c1a2b37c4d8e9fa0b1c2d3e4f5' as RunId;
  const chainHash = '9414886b1ebf025db067a4cbd13a0903fbd9733a5372bba1b58bd72c1699b798';

  test('pinned vector: security and persistence must agree on these bytes forever', () => {
    expect(computeAnchorMac(key, runId, 42, chainHash)).toBe(
      'b7ecee25d1d1ca7b682d0b73dd13a99a154e37581a09c10ee3b88f11c94df8f8',
    );
  });

  test('is HMAC-SHA256 over the canonical, purpose-tagged body', () => {
    expect(ANCHOR_MAC_PURPOSE).toBe('cohorte/chain-anchor/v1');
    const body = canonicalJson({ purpose: ANCHOR_MAC_PURPOSE, runId, atSequence: 42, chainHash });
    expect(body).toBe(
      `{"atSequence":42,"chainHash":"${chainHash}","purpose":"cohorte/chain-anchor/v1","runId":"${runId}"}`,
    );
    expect(computeAnchorMac(key, runId, 42, chainHash)).toBe(hmacSha256Hex(key, body));
  });

  test('every input changes the MAC', () => {
    const reference = computeAnchorMac(key, runId, 42, chainHash);
    expect(computeAnchorMac(bytes('08'.repeat(32)), runId, 42, chainHash)).not.toBe(reference);
    expect(computeAnchorMac(key, 'run_0192f0c1a2b37c4d8e9fa0b1c2d3e4f6' as RunId, 42, chainHash)).not.toBe(reference);
    expect(computeAnchorMac(key, runId, 43, chainHash)).not.toBe(reference);
    expect(computeAnchorMac(key, runId, 42, chainHash.replace('9', 'a'))).not.toBe(reference);
  });

  test('fields cannot be shifted into one another', () => {
    expect(computeAnchorMac(key, 'run_1' as RunId, 1, '23')).not.toBe(computeAnchorMac(key, 'run_1' as RunId, 12, '3'));
  });

  test.for([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('refuses atSequence %s', (atSequence) => {
    expect(() => computeAnchorMac(key, runId, atSequence, chainHash)).toThrow(RangeError);
  });
});
