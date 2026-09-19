import { Redaction, type Redactor, type Sealed, type SealedJson, type SealedText } from '@cohorte/base';
import { Compile } from 'typebox/compile';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { fakeRedactor, sealedJson, sealedText } from '../../src/index.ts';

const SECRET = 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const checkRedaction = Compile(Redaction);

describe('fakeRedactor', () => {
  test('is a Redactor', () => {
    const redactor: Redactor = fakeRedactor();
    expect(redactor.sealText('hello')).toEqual({ text: 'hello', redactions: [] });
  });

  test('replaces a registered secret by value, everywhere it appears', () => {
    const redactor = fakeRedactor();
    redactor.registerSecret(SECRET, 'npm-token');
    const { text, redactions } = redactor.sealText(`//registry/:_authToken=${SECRET} and again ${SECRET}`);
    expect(text).toBe('//registry/:_authToken=[REDACTED:npm-token] and again [REDACTED:npm-token]');
    expect(redactions).toEqual([{ path: '', reason: 'secret-value', detector: 'fake:npm-token' }]);
    expect(redactions.every((r) => checkRedaction.Check(r))).toBe(true);
  });

  test('walks JSON and reports one JSON pointer per redacted string', () => {
    const redactor = fakeRedactor();
    redactor.registerSecret(SECRET, 'npm-token');
    const input = { argv: ['echo', SECRET], env: { 'a/b': `x${SECRET}y`, 'c~d': 'clean' }, n: 1, ok: true, none: null };
    const { value, redactions } = redactor.sealJson(input);
    expect(value).toEqual({
      argv: ['echo', '[REDACTED:npm-token]'],
      env: { 'a/b': 'x[REDACTED:npm-token]y', 'c~d': 'clean' },
      n: 1,
      ok: true,
      none: null,
    });
    expect(redactions).toEqual([
      { path: '/argv/1', reason: 'secret-value', detector: 'fake:npm-token' },
      { path: '/env/a~1b', reason: 'secret-value', detector: 'fake:npm-token' },
    ]);
    expect(redactions.every((r) => checkRedaction.Check(r))).toBe(true);
    expect(input.argv[1]).toBe(SECRET);
  });

  test('does not look inside keys: a fake, not a security control', () => {
    const redactor = fakeRedactor();
    redactor.registerSecret(SECRET, 'k');
    expect(redactor.sealJson({ [SECRET]: 1 }).redactions).toEqual([]);
  });

  test('replaces the longest secret first, so a secret containing another never leaks its tail', () => {
    const redactor = fakeRedactor();
    redactor.registerSecret('abcdefgh', 'short');
    redactor.registerSecret('abcdefgh-ijklmnop', 'long');
    expect(redactor.sealText('token abcdefgh-ijklmnop').text).toBe('token [REDACTED:long]');
  });

  test('rejects a value shorter than 8 characters (DESIGN 2.1)', () => {
    expect(() => fakeRedactor().registerSecret('1234567', 'short')).toThrow(RangeError);
    expect(() => fakeRedactor().registerSecret('12345678', 'ok')).not.toThrow();
  });

  test('two redactors share nothing', () => {
    const a = fakeRedactor();
    a.registerSecret(SECRET, 'a');
    expect(fakeRedactor().sealText(SECRET).text).toBe(SECRET);
  });

  test('hands out values the type system accepts where a sealed one is demanded', () => {
    const redactor = fakeRedactor();
    expectTypeOf(redactor.sealText('x').text).toEqualTypeOf<SealedText>();
    expectTypeOf(redactor.sealJson({ a: 1 }).value).toEqualTypeOf<Sealed<{ a: number }>>();
    const acceptsSealedOnly = (text: SealedText, json: SealedJson): string => `${text}${JSON.stringify(json)}`;
    expect(acceptsSealedOnly(redactor.sealText('a').text, redactor.sealJson({ b: 1 }).value)).toBe('a{"b":1}');
  });
});

describe('sealedText / sealedJson', () => {
  test('seal a value that a test KNOWS to be harmless', () => {
    expectTypeOf(sealedText('plain')).toEqualTypeOf<SealedText>();
    expectTypeOf(sealedJson({ a: [1, 2] })).toEqualTypeOf<Sealed<{ a: number[] }>>();
    expect(sealedText('plain')).toBe('plain');
    expect(sealedJson({ a: [1, 2] })).toEqual({ a: [1, 2] });
  });
});
