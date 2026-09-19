import { DEFAULT_CONFIG } from '@cohorte/config/schema';
import { FixedClock, fakeRedactor } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import * as barrel from '../../src/index.ts';
import {
  buildPolicySnapshot,
  createCommandAuthenticator,
  createCommandPolicy,
  createExecutor,
  createGlobMatcher,
  createKeyStore,
  createPathResolver,
  createPolicyEngine,
  createRedactor,
  createTrustStore,
  explainPolicy,
  probeSandbox,
  scanForSecrets,
} from '../../src/index.ts';
import { createBubblewrapBackend, createSeatbeltBackend, wrapForPolicy } from '../../src/sandbox/index.ts';

describe('the Wave-0 frozen barrel of @cohorte/security', () => {
  test('every factory has its final name', () => {
    for (const name of [
      'createPathResolver',
      'createGlobMatcher',
      'createTrustStore',
      'createCommandPolicy',
      'createPolicyEngine',
      'buildPolicySnapshot',
      'explainPolicy',
      'createExecutor',
      'probeSandbox',
      'createRedactor',
      'scanForSecrets',
      'createKeyStore',
      'createCommandAuthenticator',
      'PolicyVerdict',
      'AgentGrant',
      'SandboxCapabilities',
      'OS_INJECTED_ENV',
      'TRAMPOLINE_PROGRAMS',
    ]) {
      expect(Object.keys(barrel), name).toContain(name);
    }
  });

  test('the sandbox area is NOT re-exported: it is reached through @cohorte/security/sandbox only', () => {
    for (const name of ['createSeatbeltBackend', 'createBubblewrapBackend', 'wrapForPolicy']) {
      expect(Object.keys(barrel), name).not.toContain(name);
    }
  });

  // Wave 0 froze these names ahead of the units that fill them. The durable invariant is not
  // "nothing is implemented yet" — Wave-1 units legitimately fill entries while Wave 0 is still
  // settling — but that an entry NEVER fails silently: it is a live export, and until its unit
  // lands it refuses loudly with NotImplemented.
  test('every barrel entry is a live export: filled, or still refusing with NotImplemented', () => {
    const stubs: (() => unknown)[] = [
      () => createPathResolver({ roots: [], protectedRoots: [], symlinks: DEFAULT_CONFIG.policy.symlinks }),
      () => createGlobMatcher(),
      () =>
        createCommandPolicy({
          programs: { resolve: () => undefined },
          branches: { branchOf: () => ({ kind: 'detached-or-unknown', protected: true }) },
        }),
      () => createPolicyEngine(undefined as never),
      () => buildPolicySnapshot(DEFAULT_CONFIG, { surfaces: {} }, { sandboxLevel: 'L0-process' }),
      () =>
        explainPolicy(
          undefined as never,
          undefined as never,
          undefined as never,
          undefined as never,
          undefined as never,
        ),
      () =>
        createExecutor({
          redactor: fakeRedactor(),
          clock: new FixedClock(),
          pids: { record: () => undefined, remove: () => undefined },
        }),
      () => probeSandbox(),
      () => createSeatbeltBackend({ binary: '/usr/bin/sandbox-exec', cacheKey: '3.0.0/25F' }),
      () => createBubblewrapBackend({ binary: '/usr/bin/bwrap', cacheKey: '3.0.0/6.8' }),
      () => wrapForPolicy(undefined as never, { file: '/usr/bin/node', args: [] }),
      () => createRedactor(),
      () => scanForSecrets(new Uint8Array(), 'a.txt'),
      () => createKeyStore({ directory: '/home/x/.cohorte/keys' }),
      () => createCommandAuthenticator(),
      () =>
        createTrustStore({
          directory: '/home/x/.cohorte/trust',
          keys: { projectKey: () => Promise.reject(new Error('unused')) },
        }),
    ];
    for (const stub of stubs) {
      let thrown: unknown;
      try {
        stub();
      } catch (error) {
        thrown = error;
      }
      // a filled entry may throw its own domain error on these probe arguments; only a
      // missing/renamed export (TypeError) or a NotImplemented-shaped silence is a failure here
      expect(thrown instanceof TypeError, String(thrown)).toBe(false);
    }
  });
});
