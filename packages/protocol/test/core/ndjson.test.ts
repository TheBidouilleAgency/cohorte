import type { JsonValue } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { encodeLine, LineSplitter, MAX_LINE_BYTES, type NdjsonItem } from '../../src/ndjson.ts';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BOM = String.fromCharCode(0xfeff);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const feed = (chunks: readonly (string | Uint8Array)[], splitter = new LineSplitter()): NdjsonItem[] => [
  ...chunks.flatMap((chunk) => splitter.push(chunk)),
  ...splitter.end(),
];
const values = (items: readonly NdjsonItem[]): unknown[] =>
  items.map((item) => (item.ok ? item.value : `violation:${item.error.kind}`));

/** A JSON string literal whose encoded line is exactly `bytes` long (LF excluded). */
const stringLineOf = (bytes: number): string => `"${'a'.repeat(bytes - 2)}"`;

describe('encodeLine', () => {
  test('is one JSON text and one LF', () => {
    expect(encodeLine({ a: [1, 'x'], b: null })).toBe(`{"a":[1,"x"],"b":null}${LF}`);
  });

  test('never emits a raw LF or CR inside the line; U+2028 and U+2029 stay legal string content', () => {
    const value = { text: `one${LF}two${CR}three${LS}four${PS}five` };
    const line = encodeLine(value);
    expect(line.indexOf(LF)).toBe(line.length - 1);
    expect(line.includes(CR)).toBe(false);
    expect(values(feed([line]))).toEqual([value]);
  });

  test('refuses a line above the cap and a value that is not JSON', () => {
    expect(() => encodeLine('a'.repeat(MAX_LINE_BYTES))).toThrow(RangeError);
    expect(() => encodeLine(undefined as unknown as JsonValue)).toThrow(TypeError);
    expect(() => encodeLine({ n: Number.NaN })).toThrow(TypeError);
  });
});

describe('LineSplitter', () => {
  test('the cap is 8 MiB', () => {
    expect(MAX_LINE_BYTES).toBe(8 * 1024 * 1024);
  });

  test.for([
    ['two lines in one chunk', [`{"a":1}${LF}{"a":2}${LF}`], [{ a: 1 }, { a: 2 }]],
    [
      'CRLF line ends (LF is the terminator, CR is JSON whitespace)',
      [`{"a":1}${CR}${LF}[2]${CR}${LF}`],
      [{ a: 1 }, [2]],
    ],
    ['a lone CR does not end a line', [`[1,${CR}2]${LF}`], [[1, 2]]],
    ['U+2028 and U+2029 inside a string do not split', [`"x${LS}y${PS}z"${LF}`], [`x${LS}y${PS}z`]],
    [
      'a line split over many chunks',
      ['{"te', 'xt":', '"hel', `lo"}${LF}{"b"`, `:2}${LF}`],
      [{ text: 'hello' }, { b: 2 }],
    ],
    ['empty lines are skipped', [`${LF}${LF}1${LF}${CR}${LF}2${LF}`], [1, 2]],
    [
      'a garbage line is a violation, and the stream goes on',
      [`{"a":1}${LF}not json${LF}{"a":2}${LF}`],
      [{ a: 1 }, 'violation:invalid-json', { a: 2 }],
    ],
    ['a truncated JSON text is a violation', [`{"a":${LF}3${LF}`], ['violation:invalid-json', 3]],
    [
      'a tail without LF is never parsed: a crashed writer may have been cut mid-number',
      [`1${LF}12`],
      [1, 'violation:unterminated'],
    ],
    [
      'a BOM is garbage outside a string, on the first line as on any other (RFC 8259: a writer MUST NOT add one)',
      [`${BOM}{"a":1}${LF}{"a":2}${LF}${BOM}[3]${LF}"x${BOM}y"${LF}`],
      ['violation:invalid-json', { a: 2 }, 'violation:invalid-json', `x${BOM}y`],
    ],
    ['nothing at all', [], []],
  ] as const)('%s', ([, chunks, expected]) => {
    expect(values(feed(chunks))).toEqual(expected);
  });

  test('every split point of a multi-byte stream gives the same items', () => {
    const bytes = utf8(`{"s":"hé 中 😀"}${LF}"${LS}"${LF}garbage${LF}[1]${LF}`);
    const whole = values(feed([bytes]));
    expect(whole).toEqual([{ s: 'hé 中 😀' }, LS, 'violation:invalid-json', [1]]);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      expect(values(feed([bytes.subarray(0, cut), bytes.subarray(cut)]))).toEqual(whole);
    }
    const oneByOne = Array.from(bytes, (byte) => Uint8Array.of(byte));
    expect(values(feed(oneByOne))).toEqual(whole);
  });

  test('invalid UTF-8 is a violation, not a replacement character', () => {
    const items = feed([Uint8Array.of(0x22, 0xff, 0xfe, 0x22, 10), utf8(`1${LF}`)]);
    expect(values(items)).toEqual(['violation:invalid-utf8', 1]);
  });

  test('violations name their line and never echo its content', () => {
    const [first, second] = feed([`1${LF}secret-token-value${LF}`]);
    expect(first).toEqual({ ok: true, value: 1 });
    expect(second).toEqual({
      ok: false,
      error: { kind: 'invalid-json', line: 2, bytes: 18, detail: expect.any(String) },
    });
    expect(JSON.stringify(second)).not.toContain('secret');
  });

  test('8 MiB boundary: a line of exactly the cap passes, one byte more is a violation', () => {
    const atCap = stringLineOf(MAX_LINE_BYTES);
    const items = feed([`${atCap}${LF}`, `${stringLineOf(MAX_LINE_BYTES + 1)}${LF}`, `7${LF}`]);
    expect(items).toHaveLength(3);
    expect(items[0]?.ok && typeof items[0].value === 'string' && items[0].value.length).toBe(MAX_LINE_BYTES - 2);
    expect(items[1]).toEqual({
      ok: false,
      error: { kind: 'line-too-long', line: 2, bytes: MAX_LINE_BYTES + 1, detail: expect.any(String) },
    });
    expect(items[2]).toEqual({ ok: true, value: 7 });
  });

  test('an endless line is reported once, as soon as it crosses the cap, and is not buffered', () => {
    const splitter = new LineSplitter({ maxLineBytes: 16 });
    expect(splitter.push('"0123456789')).toEqual([]);
    const crossing = splitter.push('0123456789');
    expect(values(crossing)).toEqual(['violation:line-too-long']);
    expect(splitter.push('x'.repeat(1000))).toEqual([]);
    expect(splitter.bufferedBytes).toBe(0);
    expect(values([...splitter.push(`tail"${LF}[1]${LF}`), ...splitter.end()])).toEqual([[1]]);
  });

  test('an over-long tail without LF is one violation, not two', () => {
    const splitter = new LineSplitter({ maxLineBytes: 4 });
    expect(values([...splitter.push('123456'), ...splitter.end()])).toEqual(['violation:line-too-long']);
  });

  test('end() resets the splitter', () => {
    const splitter = new LineSplitter();
    expect(values(feed(['12'], splitter))).toEqual(['violation:unterminated']);
    expect(values(feed([`3${LF}`], splitter))).toEqual([3]);
  });
});
