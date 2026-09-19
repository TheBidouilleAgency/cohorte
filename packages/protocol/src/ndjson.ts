// ADR-0004 — NDJSON is the only framing of V3.0. One JSON text per line, LF terminated.
//   - LF (0x0A) is the ONLY terminator. CR is JSON whitespace, so a CRLF stream parses; a lone CR never ends a line.
//   - U+2028 / U+2029 are legal inside JSON strings and are NOT line ends (a JavaScript line-based `split` would
//     cut an event in two): the splitter works on bytes and only ever looks for 0x0A.
//   - A line is capped at 8 MiB. An over-long line is reported once and skipped WITHOUT being buffered.
//   - A line that is not JSON is a violation RESULT, never a throw: the stream goes on with the next line.
import { err, type JsonValue, ok, type Result } from '@cohorte/base';

export const MAX_LINE_BYTES = 8 * 1024 * 1024;

const LF = 0x0a;

/** The line, LF included. Throws on a value that is not JSON (TypeError) and on a line above the cap (RangeError): both are writer bugs. */
export function encodeLine(value: JsonValue, maxLineBytes: number = MAX_LINE_BYTES): string {
  const text = JSON.stringify(value, (_key, member: unknown) => {
    if (typeof member === 'number' && !Number.isFinite(member))
      throw new TypeError('encodeLine: a non-finite number is not JSON');
    return member;
  });
  // JSON.stringify answers undefined for undefined, a function or a symbol. It escapes LF and CR inside strings and
  // adds no whitespace, so the text cannot contain a line end.
  if (typeof text !== 'string') throw new TypeError('encodeLine: the value is not JSON');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxLineBytes)
    throw new RangeError(`encodeLine: a line of ${bytes} bytes is above the cap of ${maxLineBytes}`);
  return `${text}\n`;
}

export interface NdjsonViolation {
  kind: 'invalid-json' | 'invalid-utf8' | 'line-too-long' | 'unterminated';
  /** 1-based, empty lines included */
  line: number;
  /** length of the line without its LF; for 'line-too-long', the bytes seen when the cap was crossed */
  bytes: number;
  /** never contains the content of the line: it may hold a secret */
  detail: string;
}
export type NdjsonItem = Result<JsonValue, NdjsonViolation>;

export interface LineSplitterOptions {
  maxLineBytes?: number;
}

/** JSON whitespace only (LF cannot be there). `trim()` would also swallow U+2028 and friends, which are garbage outside a string. */
const isBlank = (text: string): boolean => /^[ \t\r]*$/.test(text);

/** Streaming splitter. `push` returns the items completed by that chunk, in order; `end` closes the stream and resets. */
export class LineSplitter {
  readonly #max: number;
  // ignoreBOM keeps U+FEFF in the text, so JSON.parse refuses it: without it, decode() would swallow one on EVERY line.
  readonly #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  readonly #encoder = new TextEncoder();
  #parts: Uint8Array[] = [];
  #pending = 0;
  #discarding = false;
  #line = 1;

  constructor(options: LineSplitterOptions = {}) {
    const max = options.maxLineBytes ?? MAX_LINE_BYTES;
    if (!Number.isSafeInteger(max) || max < 1)
      throw new RangeError(`LineSplitter: maxLineBytes must be a positive integer, got ${max}`);
    this.#max = max;
  }

  /** Bytes held for the line in progress: never above the cap. */
  get bufferedBytes(): number {
    return this.#pending;
  }

  push(chunk: Uint8Array | string): NdjsonItem[] {
    const bytes = typeof chunk === 'string' ? this.#encoder.encode(chunk) : chunk;
    const items: NdjsonItem[] = [];
    let start = 0;
    while (start < bytes.length) {
      const lf = bytes.indexOf(LF, start);
      const stop = lf === -1 ? bytes.length : lf;
      this.#take(bytes.subarray(start, stop), items);
      if (lf === -1) break;
      this.#finishLine(items);
      start = lf + 1;
    }
    return items;
  }

  end(): NdjsonItem[] {
    const items: NdjsonItem[] = [];
    // A tail without LF is what a crashed writer leaves behind. `12` may be the start of `123`: never parse it.
    if (!this.#discarding && this.#pending > 0) {
      const text = this.#decode();
      if (text === undefined || !isBlank(text))
        items.push(this.#violation('unterminated', this.#pending, 'the stream ended inside a line'));
    }
    this.#reset();
    this.#line = 1;
    return items;
  }

  #take(part: Uint8Array, items: NdjsonItem[]): void {
    if (this.#discarding || part.length === 0) return;
    if (this.#pending + part.length > this.#max) {
      items.push(
        this.#violation('line-too-long', this.#pending + part.length, `a line is capped at ${this.#max} bytes`),
      );
      this.#parts = [];
      this.#pending = 0;
      this.#discarding = true;
      return;
    }
    // Copied: the caller may reuse its chunk buffer.
    this.#parts.push(part.slice());
    this.#pending += part.length;
  }

  #finishLine(items: NdjsonItem[]): void {
    if (!this.#discarding && this.#pending > 0) {
      const text = this.#decode();
      if (text === undefined) items.push(this.#violation('invalid-utf8', this.#pending, 'the line is not valid UTF-8'));
      else if (!isBlank(text)) items.push(this.#parse(text));
    }
    this.#reset();
    this.#line += 1;
  }

  #parse(text: string): NdjsonItem {
    try {
      return ok(JSON.parse(text) as JsonValue);
    } catch {
      // The message of a SyntaxError quotes the text around the error: it is dropped on purpose.
      return this.#violation('invalid-json', this.#pending, 'the line is not a JSON text');
    }
  }

  #decode(): string | undefined {
    const joined = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts);
    try {
      return this.#decoder.decode(joined);
    } catch {
      return undefined;
    }
  }

  #violation(kind: NdjsonViolation['kind'], bytes: number, detail: string): { ok: false; error: NdjsonViolation } {
    return err({ kind, line: this.#line, bytes, detail });
  }

  #reset(): void {
    this.#parts = [];
    this.#pending = 0;
    this.#discarding = false;
  }
}
