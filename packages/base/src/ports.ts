import { randomFillSync } from 'node:crypto';
import { type Brand, type IsoInstant, toIsoInstant } from './ids.ts';

export interface Clock {
  now(): IsoInstant;
  monotonicMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
/** real: uuidv7 (below); tests: seeded counter (`@cohorte/testkit` SeqIds) */
export interface IdSource {
  next<B extends string>(prefix: string): Brand<string, B>;
}
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });

/** The wall clock. `sleep` rejects with `signal.reason` when aborted, and keeps the process alive while it waits. */
export const systemClock: Clock = Object.freeze({
  now: (): IsoInstant => toIsoInstant(Date.now()),
  monotonicMs: (): number => performance.now(),
  sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
});

/** What comes before the underscore of a generated id: `run`, `evt`, `cmd`, `apr`, `eff`, ... */
export const ID_PREFIX_PATTERN = '^[a-z][a-z0-9]{0,15}$';
const idPrefix = new RegExp(ID_PREFIX_PATTERN);

/** Shared by every IdSource so that the real one and the test one refuse the same prefixes. */
export function assertIdPrefix(prefix: string): void {
  if (typeof prefix !== 'string' || !idPrefix.test(prefix)) {
    throw new TypeError(`IdSource: invalid prefix ${JSON.stringify(prefix)} (expected ${ID_PREFIX_PATTERN})`);
  }
}

const TAIL_BITS = 74n; // rand_a (12 bits) + rand_b (62 bits) of RFC 9562
const TAIL_LIMIT = 1n << TAIL_BITS;
const RAND_B_MASK = (1n << 62n) - 1n;
const VARIANT = 0b10n << 62n;
const MAX_TIMESTAMP = 2 ** 48 - 1;

export interface UuidV7Options {
  /** Milliseconds since the Unix epoch. Default: `Date.now`. */
  now?: () => number;
  /** Fills the array with random bytes. Default: `node:crypto` randomFillSync. */
  random?: (bytes: Uint8Array) => void;
}

/**
 * The real IdSource: `<prefix>_<uuidv7 without dashes>`.
 *
 * Not `crypto.randomUUIDv7()`: that one draws all 74 random bits afresh, so two ids of the same millisecond come
 * out in random order (measured on Node 24.21: about half of consecutive pairs are inverted), and `@types/node` 24
 * does not declare it. Ids are event, command and effect keys: they must sort in minting order. This generator is
 * RFC 9562 method 2 (monotonic random): inside one millisecond, or while the wall clock stalls or steps back, the
 * 74-bit tail is INCREMENTED by a random step; when it would overflow, the timestamp moves one millisecond ahead.
 * Every id of one source is therefore strictly greater than the previous one, whatever its prefix.
 */
export function createUuidV7IdSource(options: UuidV7Options = {}): IdSource {
  const now = options.now ?? Date.now;
  const random = options.random ?? ((bytes: Uint8Array): void => void randomFillSync(bytes));
  const tailBytes = new Uint8Array(10);
  const stepBytes = new Uint8Array(4);
  let lastTimestamp = -1;
  let tail = 0n;

  const bigintOf = (bytes: Uint8Array): bigint => {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
  };
  const freshTail = (): bigint => {
    random(tailBytes);
    return bigintOf(tailBytes) & (TAIL_LIMIT - 1n);
  };

  const nextHex = (): string => {
    const wallClock = Math.min(Math.max(Math.trunc(now()), 0), MAX_TIMESTAMP);
    if (wallClock > lastTimestamp) {
      lastTimestamp = wallClock;
      tail = freshTail();
    } else {
      random(stepBytes);
      tail += 1n + bigintOf(stepBytes);
      if (tail >= TAIL_LIMIT) {
        lastTimestamp += 1;
        tail = freshTail();
      }
    }
    const randA = tail >> 62n;
    const randB = tail & RAND_B_MASK;
    return (
      lastTimestamp.toString(16).padStart(12, '0') +
      '7' +
      randA.toString(16).padStart(3, '0') +
      (VARIANT | randB).toString(16).padStart(16, '0')
    );
  };

  return {
    next<B extends string>(prefix: string): Brand<string, B> {
      assertIdPrefix(prefix);
      return `${prefix}_${nextHex()}` as Brand<string, B>;
    },
  };
}
