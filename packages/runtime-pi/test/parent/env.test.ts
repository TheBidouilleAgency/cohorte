// DESIGN 3.7 layer 1: the child's environment is THE allowlist of layer 1 — a policy may narrow it, never widen it —
// and a credential-shaped or loader-shaped NAME never becomes part of it, whichever way a repository's policy spells
// it. The names below are the ones a policy could plausibly carry.
import { CohorteError } from '@cohorte/base';
import type { SandboxPolicy } from '@cohorte/runtime-contract';
import { describe, expect, test } from 'vitest';
import { childEnv, DEFAULT_MAX_OLD_SPACE_MB, fixedChildEnv } from '../../src/parent/env.ts';

const FIXED = fixedChildEnv('/tmp/pi-agent', undefined);
const policy = (env: Partial<SandboxPolicy['env']>): SandboxPolicy['env'] => ({ allow: [], set: {}, ...env });

const REFUSED = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'API_KEY',
  'APIKEY',
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'CREDENTIALS',
  'GROQ_APIKEY',
  'XAI_KEY',
  'OPENROUTER_KEY',
  'SSH_KEY',
  'NPM_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'AWS_SESSION_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GCP_PROJECT',
  'DB_PASSWD',
  'AUTH_BEARER',
] as const;

// A name that makes the runtime load foreign code before the entry runs: refused wherever it is spelled, `set` too.
const LOADER = [
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_V8_COVERAGE',
] as const;

// Layer 1 itself, plus the proxy variables a project's `network.proxyEnv` adds to `allow`.
const ALLOWED = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

// These pass the credential and loader guards, but layer 1 does not inherit them: a policy may not add them to
// `allow`. As a host-chosen VALUE (`set`) they are fine — nothing of the parent's environment travels that way.
const OUTSIDE_LAYER_1 = [
  'KEYCHAIN_DIR',
  'MONKEY',
  'TOKENIZER',
  'PASSWORD_PROMPT',
  'SSL_CERT_FILE',
  'PYTHONPATH',
] as const;

const codeOfThrow = (attempt: () => unknown): string => {
  try {
    attempt();
  } catch (thrown) {
    return (thrown as CohorteError).info.code;
  }
  return 'nothing was thrown';
};

describe('the credential-shaped-name guard', () => {
  test.for(REFUSED)('%s is refused in `allow`, and in `set`', (name) => {
    const inAllow = (): unknown => childEnv(policy({ allow: [name] }), FIXED, {});
    const inSet = (): unknown => childEnv(policy({ set: { [name]: 'x' } }), FIXED, {});
    for (const attempt of [inAllow, inSet]) {
      expect(attempt).toThrow(CohorteError);
      expect(attempt).toThrow(name);
      expect(codeOfThrow(attempt)).toBe('security/auth-mode-violation');
    }
  });
});

describe('the layer-1 allowlist (DESIGN 3.7)', () => {
  test.for(ALLOWED)('%s is inherited when the policy allows it', (name) => {
    const { env, attested } = childEnv(policy({ allow: [name] }), FIXED, { [name]: 'value' });
    expect(env[name]).toBe('value');
    expect(attested.allow).toEqual([name]);
  });

  test.for(LOADER)('%s is refused in `allow`, and in `set`', (name) => {
    const inAllow = (): unknown => childEnv(policy({ allow: [name] }), FIXED, { [name]: '/tmp/evil' });
    const inSet = (): unknown => childEnv(policy({ set: { [name]: '/tmp/evil' } }), FIXED, {});
    for (const attempt of [inAllow, inSet]) {
      expect(attempt).toThrow(name);
      expect(codeOfThrow(attempt)).toBe('security/auth-mode-violation');
    }
  });

  test.for(OUTSIDE_LAYER_1)('%s passes the credential guard but is not inherited', (name) => {
    const inAllow = (): unknown => childEnv(policy({ allow: [name] }), FIXED, { [name]: 'value' });
    expect(inAllow).toThrow(name);
    expect(codeOfThrow(inAllow)).toBe('security/auth-mode-violation');
    // As a value the host chose itself it is allowed: nothing of the parent's environment reaches the child that way.
    expect(childEnv(policy({ set: { [name]: 'chosen' } }), FIXED, { [name]: 'ambient' }).env[name]).toBe('chosen');
  });
});

test('the ambient environment is never inherited beyond the allowlist', () => {
  const { env, attested } = childEnv(policy({ allow: ['PATH'], set: { COHORTE_RUN: 'r1' } }), FIXED, {
    PATH: '/usr/bin',
    HOME: '/home/nobody',
  });
  expect(Object.keys(env).sort()).toEqual(['PATH', 'COHORTE_RUN', ...Object.keys(FIXED)].sort());
  expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_MB}`);
  // The attested policy carries what the child will really see: `allow` plus every fixed name.
  expect(Object.keys(attested.set).sort()).toEqual(['COHORTE_RUN', ...Object.keys(FIXED)].sort());
});
