// DESIGN 3.8 — the error table of the runtime, as a PURE function over the WIRE shape of an engine error. This area is
// engine-free (check-layers rule b), so it cannot ask `instanceof`: only child code looks at engine classes, and it
// sends an `ErrorSignal`. The engine's stop reason is never an input.
import { type ErrorCode, type ErrorInfo, errorOf, type JsonValue } from '@cohorte/base';
import type { ErrorSignal } from '../protocol.ts';

/** What the parent observed next to the signal: the allowlisted headers of the last `provider.response` of that request. */
export interface ClassifyEvidence {
  headers?: Readonly<Record<string, string>>;
}

const STORE_FAILED = /^Credential store (read|modify|delete) failed/;
const STORE_LOCK_CODES = new Set(['ELOCKED', 'EPERM', 'EACCES', 'EBUSY']);
const NOT_CONFIGURED = /Provider is not configured|No API key|does not support .{0,80}login/i;
const NETWORK_CODES = new Set([
  'ABORT_ERR',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const NETWORK_TEXT =
  /fetch failed|AbortError|ABORT_ERR|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|socket (was )?destroyed|other side closed|terminated|network error/i;
const EMBEDDED_5XX = /\b5\d\d\b/;
const USAGE_LIMIT = /usage[ _]limit|usage_not_included|usage_limit_reached|plan limit/i;
const TRY_AGAIN = /try again in ~?\s*(\d+)\s*(s|sec|second|min|minute|h|hour|day)/i;
const CONTEXT_OVERFLOW =
  /context (window|length)|maximum context|context_length_exceeded|maxContextTokens|too many tokens/i;
const MODEL_ENTITLEMENT = /\bmodel\b|entitle|not supported|not included/i;
const MODEL_NOT_FOUND = /model .{0,80}(not found|does not exist)|model_not_found/i;
const OVERLOADED = /overloaded|over capacity/i;
const BROKEN_STREAM = /<!DOCTYPE|<html|Unexpected token|not valid JSON|stream (ended|closed)|premature close|SSE/i;
const STATUS_PREFIX = /^(\d{3}): /;
const RESET_HEADER = /^(retry-after|x-ratelimit-reset.*|x-codex-.*reset.*)$/i;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function delayOfText(text: string): number | undefined {
  const match = TRY_AGAIN.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  const unit = UNIT_MS[match[2].charAt(0).toLowerCase()];
  return unit === undefined ? undefined : Number(match[1]) * unit;
}

/** `undefined` = no reset information at all; a number = a reset header exists (0 when its value is not a delay). */
function delayOfHeaders(headers: Readonly<Record<string, string>> | undefined): number | undefined {
  let found: number | undefined;
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!RESET_HEADER.test(name)) continue;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : 0;
    found = Math.max(found ?? 0, delay);
  }
  return found;
}

const oauthCause = (text: string): string =>
  /expire/i.test(text) ? 'expired' : /revoked|invalid_grant/i.test(text) ? 'revoked' : 'refresh-failed';

export function classify(signal: ErrorSignal, evidence: ClassifyEvidence = {}): ErrorInfo {
  const { modelsErrorCode, causeCode, text, origin } = signal;
  const prefixed = STATUS_PREFIX.exec(text)?.[1];
  const status = signal.httpStatus ?? (prefixed === undefined ? undefined : Number(prefixed));
  const mint = (code: ErrorCode, details: Record<string, JsonValue> = {}, retryAfterMs?: number): ErrorInfo =>
    errorOf(code, text, {
      details: {
        origin,
        ...(modelsErrorCode === undefined ? {} : { modelsErrorCode }),
        ...(causeCode === undefined ? {} : { causeCode }),
        ...(status === undefined ? {} : { httpStatus: status }),
        ...details,
      },
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });

  // (1) the engine's code TOGETHER WITH the text and the cause: the code alone is not a discriminator.
  if (modelsErrorCode === 'auth') {
    if (STORE_FAILED.test(text) || (causeCode !== undefined && STORE_LOCK_CODES.has(causeCode)))
      return mint('provider-transient/credential-store-locked');
    if (NOT_CONFIGURED.test(text)) return mint('provider-terminal/auth-required', { 'auth.required.cause': 'absent' });
    return mint('provider-terminal/auth-required', { unclassified: true });
  }
  if (modelsErrorCode === 'oauth') {
    const network = (causeCode !== undefined && NETWORK_CODES.has(causeCode)) || NETWORK_TEXT.test(text);
    if (network || EMBEDDED_5XX.test(text)) return mint('provider-transient/network');
    return mint('provider-terminal/auth-required', { 'auth.required.cause': oauthCause(text) });
  }

  // (2) the HTTP status, (3) the status prefix, (4) known texts.
  const usageLimit = USAGE_LIMIT.test(text);
  const textDelay = delayOfText(text);
  if (usageLimit && textDelay !== undefined) return mint('provider-terminal/quota-exceeded', {}, textDelay);
  if (status === 429) {
    const headerDelay = delayOfHeaders(evidence.headers);
    if (usageLimit || headerDelay !== undefined)
      return mint('provider-terminal/quota-exceeded', {}, headerDelay === 0 ? undefined : headerDelay);
    return mint('provider-transient/rate-limited');
  }
  if (usageLimit) return mint('provider-terminal/entitlement');
  if (CONTEXT_OVERFLOW.test(text)) return mint('budget/context-window');
  if (status === 404 || MODEL_NOT_FOUND.test(text)) return mint('provider-terminal/model-not-found');
  if (status === 400 && MODEL_ENTITLEMENT.test(text)) return mint('provider-terminal/entitlement');
  if (status === 401 || status === 403)
    return mint('provider-terminal/auth-required', { 'auth.required.cause': 'rejected' });
  if (status === 503 || status === 529 || OVERLOADED.test(text)) return mint('provider-transient/overloaded');
  if ((causeCode !== undefined && NETWORK_CODES.has(causeCode)) || NETWORK_TEXT.test(text))
    return mint('provider-transient/network');
  if ((status !== undefined && status >= 500) || BROKEN_STREAM.test(text)) return mint('provider-transient/unexpected');

  // (5) nothing matched: not retried, and the trace says that the table needs a row.
  return mint('provider-terminal/unexpected', { unclassified: true });
}
