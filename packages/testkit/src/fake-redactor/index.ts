import type { JsonValue, Redaction, Redactor, Sealed, SealedText } from '@cohorte/base';

// This file is the ONE place outside packages/security/src/redact/seal.ts that may write the sealing cast
// (check-layers rule f). testkit is dev-only and never bundled, so no production value is ever sealed here.

const escapePointerToken = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * A Redactor for tests: replaces registered secrets BY VALUE with `[REDACTED:<id>]`, in strings only (never in
 * keys), and reports one `Redaction` per string it changed. It knows no pattern, no encoded form, no size cap:
 * it exists so that tests can produce sealed values and see a redaction happen, not to protect anything.
 */
export function fakeRedactor(): Redactor {
  const secrets: Array<{ value: string; id: string }> = [];

  const scrub = (text: string, path: string, redactions: Redaction[]): string => {
    let scrubbed = text;
    for (const { value, id } of secrets) {
      if (!scrubbed.includes(value)) continue;
      scrubbed = scrubbed.replaceAll(value, `[REDACTED:${id}]`);
      redactions.push({ path, reason: 'secret-value', detector: `fake:${id}` });
    }
    return scrubbed;
  };

  const walk = (value: JsonValue, path: string, redactions: Redaction[]): JsonValue => {
    if (typeof value === 'string') return scrub(value, path, redactions);
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}/${index}`, redactions));
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        walk(member, `${path}/${escapePointerToken(key)}`, redactions),
      ]),
    );
  };

  return {
    registerSecret(value, id) {
      if (value.length < 8)
        throw new RangeError('registerSecret: a secret value shorter than 8 characters is rejected');
      secrets.push({ value, id });
      // Longest first: a secret that contains another one must not leave its tail behind.
      secrets.sort((a, b) => b.value.length - a.value.length);
    },
    sealText(text) {
      const redactions: Redaction[] = [];
      return { text: scrub(text, '', redactions) as SealedText, redactions };
    },
    sealJson<T extends JsonValue>(value: T) {
      const redactions: Redaction[] = [];
      return { value: walk(value, '', redactions) as Sealed<T>, redactions };
    },
  };
}

/** Seals a text the test KNOWS to be harmless, for APIs that only accept sealed values (I7). */
export function sealedText(text: string): SealedText {
  return fakeRedactor().sealText(text).text;
}

/** Seals a JSON value the test KNOWS to be harmless. */
export function sealedJson<T extends JsonValue>(value: T): Sealed<T> {
  return fakeRedactor().sealJson(value).value;
}
