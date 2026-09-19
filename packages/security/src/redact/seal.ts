// The only module allowed to mint the compile-time Sealed<T> marker.
import type { JsonValue, Redaction, Sealed, SealedText } from '@cohorte/base';

export function sealText(text: string, redactions: Redaction[]): { text: SealedText; redactions: Redaction[] } {
  return { text: text as SealedText, redactions };
}

export function sealJson<T extends JsonValue>(
  value: T,
  redactions: Redaction[],
): { value: Sealed<T>; redactions: Redaction[] } {
  return { value: value as Sealed<T>, redactions };
}
