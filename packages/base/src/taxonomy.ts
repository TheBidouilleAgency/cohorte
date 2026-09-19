import { ERROR_CATALOGUE, type ErrorCode, isErrorCode } from './catalogue.ts';
import { type ErrorClass, type ErrorInfo, MAX_CAUSE_DEPTH } from './errors.ts';
import { isJsonValue, type JsonValue } from './json.ts';

const MAX_MESSAGE_LENGTH = 2_000;

/** "single paragraph" (DESIGN 2.1): one line, bounded. Redaction is NOT done here: only a Redactor seals. */
const paragraph = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_MESSAGE_LENGTH ? `${flat.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : flat;
};

/** Returns `info` itself when its chain is already within bounds, a truncated copy otherwise. */
const capCause = (info: ErrorInfo, remaining: number): ErrorInfo => {
  if (!info.cause) return info;
  if (remaining === 0) {
    const { cause: _dropped, ...rest } = info;
    return { ...rest, details: { ...rest.details, causeChainTruncated: true } };
  }
  const capped = capCause(info.cause, remaining - 1);
  return capped === info.cause ? info : { ...info, cause: capped };
};

/** A frozen copy of the chain, so that a thrown error cannot be edited on its way up. `details` are shared, not copied. */
const frozenChain = (info: ErrorInfo): ErrorInfo =>
  Object.freeze(info.cause ? { ...info, cause: frozenChain(info.cause) } : { ...info });

export interface ErrorExtra {
  retryAfterMs?: number;
  cause?: ErrorInfo;
  details?: Record<string, JsonValue>;
}

/**
 * Mints a complete `ErrorInfo` from the catalogue: class, retryability, impact and remediation come from the row of
 * `code`, never from the call site (PLAN PC-1).
 */
export function errorOf(code: ErrorCode, message: string, extra: ErrorExtra = {}): ErrorInfo {
  const entry = ERROR_CATALOGUE[code];
  if (!entry || !isErrorCode(code)) throw new TypeError(`errorOf: ${String(code)} is not in ERROR_CATALOGUE`);
  // `extra` is checked, not trusted: an ErrorInfo returned in a Result never goes through `toErrorInfo`.
  const { retryAfterMs, cause, details } = extra;
  const info: ErrorInfo = {
    code,
    class: entry.class,
    message: paragraph(message),
    impact: entry.impact,
    retryable: entry.retryable,
    ...(isRetryAfterMs(retryAfterMs) ? { retryAfterMs } : {}),
    remediation: entry.remediation,
    ...(cause === undefined || cause === null
      ? {}
      : { cause: isCanonical(cause, MAX_CAUSE_DEPTH) ? cause : wireSafe(cause, MAX_CAUSE_DEPTH - 1, UNCLASSIFIED) }),
    ...(details === undefined ? {} : { details: isDetails(details) ? details : { detailsDropped: true } }),
  };
  return capCause(info, MAX_CAUSE_DEPTH);
}

/** Where an error lands when even the caller's fallback class is not one of the thirteen (a JS caller, a cast, a decoded wire value). */
const UNCLASSIFIED: ErrorCode = 'validation/unexpected';

const isClassified = (info: ErrorInfo): boolean => {
  try {
    return isErrorCode(info.code) && ERROR_CATALOGUE[info.code]?.class === info.class;
  } catch {
    return false;
  }
};

const INFO_KEYS: ReadonlySet<string> = new Set([
  'code',
  'class',
  'message',
  'impact',
  'retryable',
  'retryAfterMs',
  'remediation',
  'cause',
  'details',
]);

const isRetryAfterMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isDetails = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && isJsonValue(value);

/**
 * True when `info` is exactly what `errorOf` would mint: strict JSON, a catalogue code under its own class, the
 * catalogue's impact, retryability and remediation, no foreign member, and a cause chain of the same kind no deeper
 * than `remaining`. "Is JSON" alone is not enough: a cast can carry a security code as a retryable tool error.
 */
const isCanonical = (info: ErrorInfo, remaining: number): boolean => {
  try {
    return isJsonValue(info) && isClassified(info) && hasCanonicalMembers(info, remaining);
  } catch {
    return false;
  }
};

const hasCanonicalMembers = (info: ErrorInfo, remaining: number): boolean => {
  const raw: { readonly [K in keyof ErrorInfo]?: unknown } = info;
  const entry = isErrorCode(info.code) ? ERROR_CATALOGUE[info.code] : undefined;
  if (!entry || raw.impact !== entry.impact || raw.retryable !== entry.retryable) return false;
  if (raw.remediation !== entry.remediation || typeof raw.message !== 'string') return false;
  if (!Object.keys(info).every((key) => INFO_KEYS.has(key))) return false;
  if ('retryAfterMs' in info && !isRetryAfterMs(raw.retryAfterMs)) return false;
  if ('details' in info && !isDetails(raw.details)) return false;
  if (!('cause' in info)) return true;
  return remaining > 0 && typeof raw.cause === 'object' && raw.cause !== null && isCanonical(info.cause, remaining - 1);
};

/**
 * Rebuilds an `ErrorInfo` that is not what `errorOf` mints (an `undefined` optional, a Date in `details`, a cast, a
 * call-site `retryable`) WITHOUT reclassifying it: a `security/*` error must stay one across every boundary (I2).
 * The catalogue row of its own code restores class, impact, retryability and remediation; `fallback` is used only
 * when the code is not a catalogue code of the claimed class. Never throws.
 */
const wireSafe = (info: ErrorInfo, remaining: number, fallback: ErrorCode): ErrorInfo => {
  if (isCanonical(info, remaining)) return info;
  try {
    const raw: { readonly [K in keyof ErrorInfo]?: unknown } = info;
    const code = isClassified(info) && isErrorCode(info.code) ? info.code : fallback;
    const extra: ErrorExtra = {};
    if (isRetryAfterMs(raw.retryAfterMs)) extra.retryAfterMs = raw.retryAfterMs;
    let truncated = false;
    if (typeof raw.cause === 'object' && raw.cause !== null) {
      if (remaining > 0) extra.cause = wireSafe(raw.cause as ErrorInfo, remaining - 1, fallback);
      else truncated = true;
    }
    if (raw.details !== undefined) extra.details = isDetails(raw.details) ? raw.details : { detailsDropped: true };
    if (truncated) extra.details = { ...extra.details, causeChainTruncated: true };
    return errorOf(code, typeof raw.message === 'string' ? raw.message : 'unknown error', extra);
  } catch {
    return errorOf(fallback, 'unknown error (unreadable)', { details: { thrown: 'unreadable' } });
  }
};

export class CohorteError extends Error {
  readonly info: ErrorInfo;

  constructor(info: ErrorInfo, options?: { cause?: unknown }) {
    super(`${info.code}: ${info.message}`, options && 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'CohorteError';
    // `.info` is wire-safe whenever its code is a catalogue code; anything else is left for `toErrorInfo`, which
    // alone knows the boundary's fallback.
    const safe = isClassified(info) ? wireSafe(info, MAX_CAUSE_DEPTH, UNCLASSIFIED) : info;
    this.info = frozenChain(capCause(safe, MAX_CAUSE_DEPTH));
  }
}

/** What a Wave-0 typed stub throws (DESIGN 10.1 rule 3). Deliberately not a `CohorteError`: reaching one is a bug, not a run outcome. */
export class NotImplemented extends Error {
  constructor(what?: string) {
    super(what ? `not implemented: ${what}` : 'not implemented');
    this.name = 'NotImplemented';
  }
}

const describeThrown = (thrown: unknown): { message: string; details: Record<string, JsonValue> } => {
  const kind = thrown === null ? 'null' : typeof thrown;
  const unknown = `unknown error (${kind})`;
  switch (typeof thrown) {
    case 'string':
      return { message: thrown || unknown, details: { thrown: kind } };
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'symbol':
      return { message: String(thrown), details: { thrown: kind } };
    case 'object':
    case 'function':
      break;
    default:
      return { message: unknown, details: { thrown: kind } };
  }
  if (thrown === null) return { message: unknown, details: { thrown: kind } };

  const record = thrown as { message?: unknown; name?: unknown; code?: unknown };
  const isError = thrown instanceof Error;
  const name = isError && typeof record.name === 'string' && record.name ? record.name : undefined;
  const text = typeof record.message === 'string' && record.message ? record.message : (name ?? unknown);
  const details: Record<string, JsonValue> = { thrown: name ?? kind };
  // Node system errors carry a stable code (ENOENT, EACCES, ERR_*); a stack never leaves the process.
  if (isError && typeof record.code === 'string' && record.code) details.errorCode = record.code;
  return { message: text, details };
};

const fallbackCode = (fallback: { code: string; class: ErrorClass }): ErrorCode => {
  try {
    if (isErrorCode(fallback.code) && ERROR_CATALOGUE[fallback.code]?.class === fallback.class) return fallback.code;
    const unexpected = `${fallback.class}/unexpected`;
    return isErrorCode(unexpected) ? unexpected : UNCLASSIFIED;
  } catch {
    return UNCLASSIFIED;
  }
};

const convert = (thrown: unknown, fallback: ErrorCode, remaining: number): ErrorInfo => {
  let info: ErrorInfo;
  let jsCause: unknown;
  try {
    if (thrown instanceof CohorteError) {
      info = thrown.info;
      jsCause = info.cause ? undefined : thrown.cause;
    } else {
      const { message, details } = describeThrown(thrown);
      info = errorOf(fallback, message, { details });
      jsCause = thrown instanceof Error ? thrown.cause : undefined;
    }
  } catch {
    // A hostile throwable (throwing getters, a Proxy): still an ErrorInfo, never a second exception.
    info = errorOf(fallback, 'unknown error (unreadable)', { details: { thrown: 'unreadable' } });
    jsCause = undefined;
  }
  if (jsCause === undefined || jsCause === null) return capCause(info, remaining);
  // Same marker as `capCause`: a reader can tell that causes were dropped, whichever chain was cut.
  if (remaining === 0) return { ...info, details: { ...info.details, causeChainTruncated: true } };
  return { ...info, cause: convert(jsCause, fallback, remaining - 1) };
};

/**
 * Total: never throws, whatever was thrown and whatever `fallback` holds. A `CohorteError` keeps its own
 * classification, even when its `ErrorInfo` has to be rebuilt to be strict JSON. Anything else becomes
 * `fallback.code` when that is a catalogue code of `fallback.class`, and `<fallback.class>/unexpected` otherwise
 * (DESIGN 2.8), so the result is always a catalogue code with its impact and remediation. `Error.cause` is
 * followed, at most MAX_CAUSE_DEPTH deep.
 */
export function toErrorInfo(e: unknown, fallback: { code: string; class: ErrorClass }): ErrorInfo {
  const code = fallbackCode(fallback);
  return wireSafe(convert(e, code, MAX_CAUSE_DEPTH), MAX_CAUSE_DEPTH, code);
}
