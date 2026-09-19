import { type Static, Type } from 'typebox';
import { Sha256 } from './ids.ts';
import type { JsonValue } from './json.ts';

/** RFC 6901: empty (the whole document) or a sequence of "/"-prefixed tokens where "~" only appears as ~0 or ~1. */
export const JSON_POINTER_PATTERN = '^(?:/(?:[^/~]|~[01])*)*$';

export const Redaction = Type.Object(
  {
    path: Type.String({ pattern: JSON_POINTER_PATTERN }),
    reason: Type.Union([
      Type.Literal('secret-value'),
      Type.Literal('secret-pattern'),
      Type.Literal('env-value'),
      Type.Literal('private-key'),
      Type.Literal('sensitive-path'),
      Type.Literal('size'),
    ]),
    detector: Type.String(),
    sha256: Type.Optional(Sha256),
  },
  { additionalProperties: false },
);
export type Redaction = Static<typeof Redaction>;

declare const sealed: unique symbol;
/** Compile-time proof that a value went through Redactor. Minted ONLY in packages/security/src/redact/seal.ts (check-layers rule f). */
export type Sealed<T> = T & { readonly [sealed]: true };
export type SealedText = Sealed<string>;
export type SealedJson = Sealed<JsonValue>;
export interface Redactor {
  /** by VALUE (+ base64, hex, URL-encoded forms); values < 8 chars rejected */
  registerSecret(value: string, id: string): void;
  sealText(text: string): { text: SealedText; redactions: Redaction[] };
  sealJson<T extends JsonValue>(value: T): { value: Sealed<T>; redactions: Redaction[] };
}
