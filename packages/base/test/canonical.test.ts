import { describe, expect, test } from 'vitest';
import { canonicalJson, type JsonValue, sha256Hex } from '../src/index.ts';

describe('canonicalJson', () => {
  test.for<readonly [string, JsonValue, string]>([
    ['sorts keys', { b: 1, a: 2 }, '{"a":2,"b":1}'],
    [
      'sorts nested keys and keeps array order',
      { z: [{ y: 1, x: 2 }, 3], a: { c: null, b: true } },
      '{"a":{"b":true,"c":null},"z":[{"x":2,"y":1},3]}',
    ],
    ['writes no whitespace', { a: [1, 2, { b: 'c d' }] }, '{"a":[1,2,{"b":"c d"}]}'],
    ['scalars', null, 'null'],
    ['booleans', false, 'false'],
    ['empty containers', { a: [], b: {} }, '{"a":[],"b":{}}'],
    [
      'escapes like JSON.stringify',
      'quote " backslash \\ newline \n tab \t',
      '"quote \\" backslash \\\\ newline \\n tab \\t"',
    ],
    ['control characters', '\u0001\u001f', '"\\u0001\\u001f"'],
    ['a lone surrogate stays well-formed JSON', '\ud800', '"\\ud800"'],
  ])('%s', ([, value, expected]) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  test('orders keys by UTF-16 code unit, as RFC 8785 does', () => {
    // The RFC 8785 vector, with U+FF21 in the place of U+FB33 (which NFC decomposes, see the next test). The pair that
    // tells the two orders apart: U+1F600 is the surrogates D83D DE00, so it sorts BEFORE U+FF21 by code unit and
    // after it by code point.
    const value: JsonValue = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\uff21': 'Fullwidth Latin Capital Letter A',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    // Compared as text: an object would hoist the integer-like key "1" and hide the order.
    expect(canonicalJson(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\uff21":"Fullwidth Latin Capital Letter A"}',
    );
  });

  test('a key that NFC rewrites is sorted under its normalised spelling', () => {
    // U+FB33 is a composition exclusion: NFC turns it into U+05D3 U+05BC, which sorts before U+20AC.
    expect(canonicalJson({ '\u20ac': 1, '\ufb33': 2 })).toBe('{"\u05d3\u05bc":2,"\u20ac":1}');
  });

  test.for<readonly [string, number, string]>([
    ['integer', 1, '1'],
    ['negative zero is zero', -0, '0'],
    ['fraction', 1.5, '1.5'],
    ['no trailing zero', 1.0, '1'],
    ['shortest round trip', 0.1 + 0.2, '0.30000000000000004'],
    ['large exponent', 1e21, '1e+21'],
    ['small exponent', 1e-7, '1e-7'],
    ['max safe integer', Number.MAX_SAFE_INTEGER, '9007199254740991'],
    ['negative', -12.25, '-12.25'],
  ])('number: %s', ([, value, expected]) => {
    expect(canonicalJson(value)).toBe(expected);
    expect(canonicalJson([value])).toBe(`[${expected}]`);
  });

  test.for([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('refuses %s', (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
    expect(() => canonicalJson({ a: [value] })).toThrow(TypeError);
  });

  test('normalises strings AND keys to NFC', () => {
    const decomposed = 'é';
    const composed = 'é';
    expect(canonicalJson(decomposed)).toBe(`"${composed}"`);
    expect(canonicalJson({ [decomposed]: decomposed })).toBe(`{"${composed}":"${composed}"}`);
    expect(canonicalJson({ [decomposed]: 1 })).toBe(canonicalJson({ [composed]: 1 }));
  });

  test('sorts AFTER normalising, so both spellings of a key land in the same place', () => {
    // U+0065 U+0301 sorts before "f"; its NFC form U+00E9 sorts after it.
    expect(canonicalJson({ é: 1, f: 2 })).toBe('{"f":2,"é":1}');
  });

  test('refuses two keys that collide once normalised', () => {
    expect(() => canonicalJson({ é: 1, é: 2 })).toThrow(/collide/);
  });

  test('drops an undefined property exactly as JSON.stringify does, so a value hashes like its stored form', () => {
    const value = { a: 1, b: undefined } as unknown as JsonValue;
    expect(canonicalJson(value)).toBe('{"a":1}');
    expect(canonicalJson(value)).toBe(canonicalJson(JSON.parse(JSON.stringify(value)) as JsonValue));
  });

  test.for<readonly [string, unknown]>([
    ['undefined', undefined],
    ['undefined in an array (JSON.stringify would write null)', [undefined]],
    ['function', () => 1],
    ['function property', { a: () => 1 }],
    ['symbol', Symbol('s')],
    ['bigint', 1n],
    ['Date (has toJSON)', new Date(0)],
    ['Map', new Map()],
    [
      'class instance',
      new (class Box {
        value = 1;
      })(),
    ],
    ['typed array', new Uint8Array(2)],
  ])('refuses a value that is not JSON: %s', ([, value]) => {
    expect(() => canonicalJson(value as JsonValue)).toThrow(TypeError);
  });

  test('refuses a cycle instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic as JsonValue)).toThrow(/cycl/i);
  });

  test('accepts the same object twice when it is not a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  test('accepts a null-prototype object', () => {
    const bare = Object.assign(Object.create(null) as Record<string, JsonValue>, { b: 1, a: 2 });
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
  });

  test('is a fixed point', () => {
    const value: JsonValue = { z: [1, 'é', { b: null, a: [true, -0] }], a: { y: 1.5, x: 'x' } };
    const once = canonicalJson(value);
    expect(canonicalJson(JSON.parse(once) as JsonValue)).toBe(once);
  });

  test('does not depend on insertion order', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe('sha256Hex', () => {
  test.for<readonly [string, string | Uint8Array, string]>([
    ['empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc" (FIPS 180-2)', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['bytes', new Uint8Array([0x61, 0x62, 0x63]), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['a string is hashed as UTF-8', 'é', '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'],
    [
      'a canonical document',
      canonicalJson({ b: 1, a: 2 }),
      'd3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772',
    ],
  ])('%s', ([, data, expected]) => {
    expect(sha256Hex(data)).toBe(expected);
  });

  test('hashes the bytes it is given: no normalisation of its own', () => {
    expect(sha256Hex('é')).not.toBe(sha256Hex('é'));
  });

  test('respects the view of a typed array, not its whole buffer', () => {
    const buffer = new Uint8Array([0x00, 0x61, 0x62, 0x63, 0x00]);
    expect(sha256Hex(buffer.subarray(1, 4))).toBe(sha256Hex('abc'));
  });
});
