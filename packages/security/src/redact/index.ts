// Secret registration, recursive sealing and commit-time detectors.
import { type JsonValue, type Redaction, type Redactor, type Sealed, type SealedText, sha256Hex } from '@cohorte/base';
import { sealJson, sealText } from './seal.ts';

export interface RedactorOptions {
  /** values learned before the run starts (the dotenv files the run could see), by id */
  secrets?: Readonly<Record<string, string>>;
}

const replacement = '[REDACTED]';
const escapePointerToken = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');

function scrub(
  text: string,
  path: string,
  secrets: readonly { value: string; id: string }[],
  redactions: Redaction[],
): string {
  let result = text;
  for (const { value, id } of secrets) {
    if (result.includes(value)) {
      result = result.split(value).join(replacement);
      redactions.push({ path, reason: 'secret-value', detector: `registered:${id}` });
    }
  }
  return result;
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const secrets: Array<{ value: string; id: string }> = [];
  for (const [id, value] of Object.entries(options.secrets ?? {})) {
    if (value.length >= 8) secrets.push({ value, id });
  }
  secrets.sort((a, b) => b.value.length - a.value.length);
  const walk = (value: JsonValue, path: string, redactions: Redaction[]): JsonValue => {
    if (typeof value === 'string') return scrub(value, path, secrets, redactions);
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}/${index}`, redactions));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item, `${path}/${escapePointerToken(key)}`, redactions)]),
      );
    }
    return value;
  };
  return {
    registerSecret(value, id): void {
      if (value.length < 8)
        throw new RangeError('registerSecret: a secret value shorter than 8 characters is rejected');
      secrets.push({ value, id });
      secrets.sort((a, b) => b.value.length - a.value.length);
    },
    sealText(text): { text: SealedText; redactions: Redaction[] } {
      const redactions: Redaction[] = [];
      return sealText(scrub(text, '', secrets, redactions), redactions);
    },
    sealJson<T extends JsonValue>(value: T): { value: Sealed<T>; redactions: Redaction[] } {
      const redactions: Redaction[] = [];
      return sealJson(walk(value, '', redactions) as T, redactions);
    },
  };
}

/** The commit-time secret scan (DESIGN 5.3): path classes + the Redactor's detectors over staged content. */
export function scanForSecrets(bytes: Uint8Array, path: string): Redaction[] {
  const redactions: Redaction[] = [];
  const digest = sha256Hex(bytes);
  const text = new TextDecoder().decode(bytes);
  const add = (reason: Redaction['reason'], detector: string): void => {
    redactions.push({ path: '', reason, detector, sha256: digest });
  };
  if (bytes.byteLength > 10 * 1024 * 1024) add('size', 'size:10MiB');
  if (/(^|[/\\])(?:\.env|.*\.pem|.*\.key)$/i.test(path)) add('sensitive-path', 'path:secret-file');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) add('private-key', 'pattern:private-key');
  if (/(?:AKIA|ASIA)[A-Z0-9]{16}/.test(text)) add('secret-pattern', 'pattern:aws-access-key');
  if (/(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/.test(text)) add('secret-pattern', 'pattern:github-token');
  if (/sk-[A-Za-z0-9]{20,}/.test(text)) add('secret-pattern', 'pattern:openai-key');
  return redactions;
}
