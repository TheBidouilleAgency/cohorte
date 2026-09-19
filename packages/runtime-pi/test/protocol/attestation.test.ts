import type { Sha256 } from '@cohorte/base';
import { Compile } from 'typebox/compile';
import { describe, expect, test } from 'vitest';
import {
  Attestation,
  type AttestationClaim,
  attestationExpectation,
  diffAttestation,
  OS_INJECTED_ENV,
} from '../../src/protocol.ts';
import { attestation, engine, HEX64, request } from './samples.ts';

const OTHER_HEX = 'f'.repeat(64) as Sha256;
const expectedOn = (platform: string) => attestationExpectation(request, engine, HEX64, platform);
const fieldsOf = (claim: AttestationClaim, platform = 'linux') =>
  diffAttestation(expectedOn(platform), { ...claim, platform }).map((mismatch) => mismatch.field);

const changes: readonly (readonly [what: string, change: Partial<AttestationClaim>, field: string])[] = [
  ['a tool missing from the registry', { activeTools: ['read_file'] }, 'activeTools'],
  ['a tool that was not granted', { activeTools: ['read_file', 'submit_result', 'bash'] }, 'activeTools'],
  ['a tool listed twice', { activeTools: ['read_file', 'read_file'] }, 'activeTools'],
  ['another effective system prompt', { effectiveSystemPromptSha256: OTHER_HEX }, 'effectiveSystemPromptSha256'],
  ['a prompt that is not a prefix', { systemPromptPrefixOk: false }, 'systemPromptPrefixOk'],
  ['a model fallback', { modelFallback: true }, 'modelFallback'],
  [
    'another endpoint',
    { effective: { ...attestation.effective, baseUrl: 'https://evil.invalid/v1' } },
    'effective.baseUrl',
  ],
  ['another model', { effective: { ...attestation.effective, model: 'gpt-4' } }, 'effective.model'],
  ['another provider', { effective: { ...attestation.effective, provider: 'openai' } }, 'effective.provider'],
  [
    'an API key in subscription mode',
    { auth: { ...attestation.auth, type: 'api_key', subscription: false } },
    'auth.type',
  ],
  [
    'an OAuth login without a subscription',
    { auth: { ...attestation.auth, subscription: false } },
    'auth.subscription',
  ],
  ['another auth provider', { auth: { ...attestation.auth, provider: 'anthropic' } }, 'auth.provider'],
  [
    'another engine version',
    { engine: { ...attestation.engine, version: '0.86.0', packageVersions: {} } },
    'engine.version',
  ],
  [
    'engine packages at different versions',
    {
      engine: { ...attestation.engine, packageVersions: { a: '0.85.1', b: '0.85.0' } },
    },
    'engine.packageVersions',
  ],
  ['a loaded extension', { extensionsLoaded: 1 }, 'extensionsLoaded'],
  ['an extension error', { extensionErrors: 1 }, 'extensionErrors'],
  ['compaction on', { settings: { ...attestation.settings, compaction: true } }, 'settings.compaction'],
  [
    'engine retries on',
    { settings: { ...attestation.settings, providerMaxRetries: 2 } },
    'settings.providerMaxRetries',
  ],
  ['no guard fetch', { hooks: { ...attestation.hooks, guardFetchInstalled: false } }, 'hooks.guardFetchInstalled'],
  [
    'no stream wrapper',
    { hooks: { ...attestation.hooks, streamWrapperInstalled: false } },
    'hooks.streamWrapperInstalled',
  ],
  ['another session file', { sessionFile: '/home/u/.pi/sessions/x.jsonl' }, 'sessionFile'],
  ['another host protocol', { hostProtocol: 2 }, 'hostProtocol'],
  ['an env name outside the allowlist', { envKeys: ['PATH', 'OPENAI_API_KEY'] }, 'envKeys'],
  [
    'the ipc fd variable, which Node removes before user code runs',
    { envKeys: ['PATH', 'NODE_CHANNEL_FD'] },
    'envKeys',
  ],
];

describe('attestationExpectation', () => {
  test('is what the spawn request and the engine settings say', () => {
    expect(expectedOn('linux')).toEqual({
      engineVersion: '0.85.1',
      activeTools: ['read_file', 'submit_result'],
      effectiveSystemPromptSha256: HEX64,
      auth: { provider: 'openai-codex', mode: 'subscription', allowApiKey: false },
      effective: { provider: 'openai-codex', model: 'gpt-5.5-codex', baseUrl: request.auth.baseUrl },
      sessionFile: engine.sessionFile,
      envAllow: ['PATH', 'TZ'],
      platform: 'linux',
    });
  });
});

describe('diffAttestation', () => {
  test('a matching attestation has no mismatch, and is an Attestation', () => {
    expect(Compile(Attestation).Check(attestation)).toBe(true);
    expect(diffAttestation(expectedOn('linux'), attestation)).toEqual([]);
  });

  test.for(changes)('flags %s', ([, change, field]) => {
    expect(fieldsOf({ ...attestation, ...change })).toContain(field);
  });

  test('a key in subscription mode is ONE mismatch on auth.type, not two', () => {
    const withKey = { ...attestation, auth: { ...attestation.auth, type: 'api_key' as const, subscription: false } };
    const fields = diffAttestation(expectedOn('linux'), withKey).map((mismatch) => mismatch.field);
    expect(fields.filter((field) => field === 'auth.type')).toEqual(['auth.type']);
    expect(new Set(fields).size).toBe(fields.length);
  });

  test('an API key is accepted only in api mode WITH the explicit opt-in', () => {
    const withKey = { ...attestation, auth: { ...attestation.auth, type: 'api_key', subscription: false } } as const;
    const api = (allowApiKey: boolean) =>
      attestationExpectation(
        { ...request, auth: { ...request.auth, mode: 'api', allowApiKey } },
        engine,
        HEX64,
        'linux',
      );
    expect(diffAttestation(api(true), withKey)).toEqual([]);
    expect(diffAttestation(api(false), withKey).map((mismatch) => mismatch.field)).toEqual(['auth.type']);
    expect(diffAttestation(api(true), attestation).map((mismatch) => mismatch.field)).toEqual(['auth.type']);
  });

  describe('envKeys ⊆ allow ∪ OS_INJECTED_ENV[platform] (PLAN F-8)', () => {
    const macKeys = ['PATH', '__CF_USER_TEXT_ENCODING'];

    test('the constant mirrors @cohorte/security/contract/builtin.ts', () => {
      expect(OS_INJECTED_ENV).toEqual({ darwin: ['__CF_USER_TEXT_ENCODING'] });
      expect(Object.isFrozen(OS_INJECTED_ENV)).toBe(true);
    });

    test('what a clean child reports on macOS passes on darwin', () => {
      expect(fieldsOf({ ...attestation, envKeys: macKeys }, 'darwin')).toEqual([]);
    });

    test('the same list fails on linux', () => {
      const mismatches = diffAttestation(expectedOn('linux'), { ...attestation, envKeys: macKeys });
      expect(mismatches).toEqual([
        { field: 'envKeys', expected: 'a subset of ["PATH","TZ"]', got: '["__CF_USER_TEXT_ENCODING"]' },
      ]);
    });

    test('an allowed name that is not visible is not a mismatch: NODE_CHANNEL_FD is never expected', () => {
      expect(fieldsOf({ ...attestation, envKeys: [] })).toEqual([]);
      expect(expectedOn('darwin').envAllow).not.toContain('NODE_CHANNEL_FD');
    });

    test('a child that reports another platform than the parent is flagged', () => {
      const mismatches = diffAttestation(expectedOn('linux'), { ...attestation, platform: 'darwin', envKeys: macKeys });
      expect(mismatches.map((mismatch) => mismatch.field).sort()).toEqual(['envKeys', 'platform']);
    });
  });
});
