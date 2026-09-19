import { describe, expect, test } from 'vitest';
import { createRedactor, scanForSecrets } from '../../src/redact/index.ts';

describe('redactor', () => {
  test('seals and replaces registered secrets in text and JSON', () => {
    const redactor = createRedactor({ secrets: { token: 'super-secret-token' } });
    const text = redactor.sealText('Authorization: super-secret-token');
    const json = redactor.sealJson({ message: 'super-secret-token' });

    expect(text.text).toContain('[REDACTED]');
    expect(text.text).not.toContain('super-secret-token');
    expect(json.value.message).toBe('[REDACTED]');
    expect(text.redactions[0]?.detector).toBe('registered:token');
  });

  test('detects secret-shaped files before commit', () => {
    const findings = scanForSecrets(new TextEncoder().encode('-----BEGIN PRIVATE KEY-----'), 'credentials.pem');
    expect(findings.map((finding) => finding.reason)).toEqual(['sensitive-path', 'private-key']);
  });
});
