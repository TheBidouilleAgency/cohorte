import { ERROR_CATALOGUE } from '@cohorte/base';
import type { ErrorSignal } from '@cohorte/runtime-pi/host-protocol';
import { describe, expect, test } from 'vitest';
import { attestationError, processExitError, protocolViolation } from '../../src/classify/host.ts';
import { classify } from '../../src/classify/index.ts';

type Row = [what: string, signal: ErrorSignal, code: string, headers?: Record<string, string>];

const signal = (members: Partial<ErrorSignal> & { text: string }): ErrorSignal => ({
  origin: 'model-response',
  ...members,
});

// One case per row of DESIGN 3.8, on the WIRE shape only: nothing here can look at an engine class.
const ROWS: Row[] = [
  [
    "auth + 'Credential store read failed' is a locked store",
    signal({ modelsErrorCode: 'auth', text: 'Credential store read failed: lock timeout', origin: 'auth-check' }),
    'provider-transient/credential-store-locked',
  ],
  [
    'auth + a lock errno is a locked store, whatever the text',
    signal({ modelsErrorCode: 'auth', causeCode: 'ELOCKED', text: 'could not resolve auth', origin: 'auth-check' }),
    'provider-transient/credential-store-locked',
  ],
  [
    "auth + 'Provider is not configured' needs a login",
    signal({ modelsErrorCode: 'auth', text: 'Provider is not configured: openai-codex', origin: 'prompt-preflight' }),
    'provider-terminal/auth-required',
  ],
  [
    "auth + 'No API key' needs a login",
    signal({ modelsErrorCode: 'auth', text: 'No API key for provider groq', origin: 'prompt-preflight' }),
    'provider-terminal/auth-required',
  ],
  [
    'oauth + a network-class cause is transient',
    signal({
      modelsErrorCode: 'oauth',
      causeCode: 'ETIMEDOUT',
      text: 'OAuth refresh failed',
      origin: 'model-response',
    }),
    'provider-transient/network',
  ],
  [
    "oauth + 'fetch failed' in the text is transient",
    signal({ modelsErrorCode: 'oauth', text: 'OAuth refresh failed: TypeError: fetch failed' }),
    'provider-transient/network',
  ],
  [
    'oauth + an embedded 5xx is transient',
    signal({ modelsErrorCode: 'oauth', text: 'OAuth refresh failed: 503 Service Unavailable' }),
    'provider-transient/network',
  ],
  [
    'any other oauth failure needs a login',
    signal({ modelsErrorCode: 'oauth', text: 'OAuth refresh rejected: invalid_grant' }),
    'provider-terminal/auth-required',
  ],
  [
    'a usage-limit text with a delay is a quota',
    signal({ httpStatus: 429, text: 'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.' }),
    'provider-terminal/quota-exceeded',
  ],
  [
    'a 429 with reset headers is a quota',
    signal({ httpStatus: 429, text: 'Too Many Requests' }),
    'provider-terminal/quota-exceeded',
    { 'retry-after': '120' },
  ],
  [
    'a 429 without reset information is rate limiting',
    signal({ httpStatus: 429, text: 'Too Many Requests' }),
    'provider-transient/rate-limited',
  ],
  [
    'a usage-limit text with a non-429 status is an entitlement problem',
    signal({ httpStatus: 403, text: 'usage_not_included: your plan does not include this model' }),
    'provider-terminal/entitlement',
  ],
  [
    'a 400 about the model is an entitlement problem',
    signal({ httpStatus: 400, text: 'The model gpt-x is not supported when using Codex with a ChatGPT account.' }),
    'provider-terminal/entitlement',
  ],
  [
    'a 401 without usage-limit text needs a login',
    signal({ httpStatus: 401, text: 'Unauthorized' }),
    'provider-terminal/auth-required',
  ],
  [
    'a leading status prefix counts as the status',
    signal({ text: '403: Forbidden' }),
    'provider-terminal/auth-required',
  ],
  ['a 5xx is transient', signal({ httpStatus: 502, text: 'Bad Gateway' }), 'provider-transient/unexpected'],
  [
    'an overloaded provider is transient',
    signal({ httpStatus: 529, text: 'Overloaded' }),
    'provider-transient/overloaded',
  ],
  [
    'a destroyed socket is transient',
    signal({ causeCode: 'ECONNRESET', text: 'socket hang up' }),
    'provider-transient/network',
  ],
  [
    'an HTML body is transient',
    signal({ text: 'Unexpected token < in JSON at position 0: <!DOCTYPE html>' }),
    'provider-transient/unexpected',
  ],
  [
    'a context overflow is a budget matter',
    signal({ httpStatus: 400, text: 'Your input exceeds the context window of this model.' }),
    'budget/context-window',
  ],
  [
    'anything else is not retried',
    signal({ text: 'something nobody has seen yet', origin: 'engine' }),
    'provider-terminal/unexpected',
  ],
];

describe('classify (DESIGN 3.8)', () => {
  test.for(ROWS)('%s', ([, input, code, headers]) => {
    const info = classify(input, headers ? { headers } : undefined);
    expect(info.code).toBe(code);
    expect(info.class).toBe(ERROR_CATALOGUE[code]?.class);
    expect(info.retryable).toBe(ERROR_CATALOGUE[code]?.retryable);
  });

  test('an auth code that matches no row fails towards the human and leaves a trace', () => {
    const info = classify(signal({ modelsErrorCode: 'auth', text: 'a brand new auth failure', origin: 'auth-check' }));
    expect(info.code).toBe('provider-terminal/auth-required');
    expect(info.details).toMatchObject({ unclassified: true });
  });

  test('a locked store is never AUTH_REQUIRED, even with a 401 next to it', () => {
    const info = classify(
      signal({ modelsErrorCode: 'auth', causeCode: 'EBUSY', httpStatus: 401, text: 'Credential store modify failed' }),
    );
    expect(info.code).toBe('provider-transient/credential-store-locked');
  });

  test('the delay of a usage limit becomes retryAfterMs', () => {
    expect(classify(signal({ text: 'usage limit reached. Try again in ~5 min' })).retryAfterMs).toBe(300_000);
    expect(
      classify(signal({ httpStatus: 429, text: 'slow down' }), { headers: { 'retry-after': '7' } }).retryAfterMs,
    ).toBe(7_000);
  });

  test('the oauth cause is recorded for the AUTH_REQUIRED row', () => {
    expect(classify(signal({ modelsErrorCode: 'oauth', text: 'token expires too soon' })).details).toMatchObject({
      'auth.required.cause': 'expired',
    });
  });

  // DESIGN 3.8's causes enumerate what the CHILD's layer-3 check and a refresh can conclude; a bare 401/403 from the
  // provider is neither (the credential exists and was sent, and the provider rejected it). The value is pinned here
  // and filed as a deviation (docs/v3/requests/U1.07.md R3) so that the enumeration gains its row.
  test('a 401/403 with no engine code is an AUTH_REQUIRED the provider itself pronounced', () => {
    for (const httpStatus of [401, 403]) {
      const info = classify(signal({ httpStatus, text: 'Unauthorized' }));
      expect(info.code).toBe('provider-terminal/auth-required');
      expect(info.details).toMatchObject({ 'auth.required.cause': 'rejected' });
    }
  });

  test('pure: the same signal gives the same answer and the input is left alone', () => {
    const input = Object.freeze(signal({ httpStatus: 500, text: 'boom' }));
    expect(classify(input)).toEqual(classify(input));
  });
});

describe('what the parent mints by itself', () => {
  test('a child that went away is a retryable process exit', () => {
    expect(processExitError('disconnect').code).toBe('tool-transient/agent-process-exit');
  });

  test.for([
    ['unknown-tool', 'the child proposed bash, which was not granted'],
    ['frame-schema', 'schema-violation: tool.call: /ordinal must be >= 1'],
    ['ordinal-gap', 'ordinal 4 after 2'],
  ] as const)('%s is a security error', ([kind, detail]) => {
    const info = protocolViolation(kind, detail);
    expect(info.class).toBe('security');
    expect(info.retryable).toBe(false);
    expect(info.details).toMatchObject({ violation: kind });
  });

  test('an attestation mismatch is a security error that names the endpoint or the auth mode when that is what differs', () => {
    const tools = attestationError([{ field: 'activeTools', expected: '["a"]', got: '["a","bash"]' }]);
    expect(tools.code).toBe('security/unexpected');
    expect(tools.details).toMatchObject({ violation: 'attestation-mismatch', fields: ['activeTools'] });
    expect(attestationError([{ field: 'effective.baseUrl', expected: 'https://a', got: 'https://b' }]).code).toBe(
      'security/auth-endpoint-mismatch',
    );
    expect(attestationError([{ field: 'auth.type', expected: 'oauth', got: 'api_key' }]).code).toBe(
      'security/auth-mode-violation',
    );
  });
});
