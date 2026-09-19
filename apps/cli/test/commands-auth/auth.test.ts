import { describe, expect, test } from 'vitest';
import auth from '../../src/commands/auth/index.ts';
import models from '../../src/commands/models/index.ts';
import providers from '../../src/commands/providers/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('authentication and provider commands', () => {
  test('auth status and providers list use the runtime status port', async () => {
    const out = captureStream();
    const runtime = {
      authStatus: async () => [{ provider: 'fake', state: 'absent', subscription: false, source: 'none' }],
    };
    const ctx = fakeCliContext({
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
      runtime: { resolve: () => runtime as never },
    });
    expect(await auth.run(ctx, { positionals: [], options: {}, json: true, subVerb: 'status' })).toBe(0);
    expect(await providers.run(ctx, { positionals: [], options: {}, json: false, subVerb: 'list' })).toBe(0);
    expect(out.text()).toContain('fake');
  });

  test('models list is deterministic when no model is configured', async () => {
    const out = captureStream();
    const ctx = fakeCliContext({ stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
    expect(await models.run(ctx, { positionals: [], options: {}, json: true, subVerb: 'list' })).toBe(0);
    expect(out.text()).toContain('models');
  });

  test('login and logout delegate to the runtime without printing credentials', async () => {
    const out = captureStream();
    let loggedOut = '';
    const status = {
      provider: 'fake',
      state: 'oauth',
      subscription: true,
      billing: 'plan-limits',
      checkedAt: '2026-09-18T00:00:00.000Z',
    };
    const runtime = {
      id: 'fake',
      authStatus: async () => [status],
      login: async (provider: string) => ({ ...status, provider, accountLabel: 'account-canary' }),
      logout: async (provider: string) => {
        loggedOut = provider;
      },
    };
    const ctx = fakeCliContext({
      clock: { now: () => '2026-09-18T00:00:00.000Z' } as never,
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
      runtime: { resolve: () => runtime as never },
    });
    expect(await auth.run(ctx, { positionals: ['fake'], options: {}, json: true, subVerb: 'login' })).toBe(0);
    expect(await auth.run(ctx, { positionals: ['fake'], options: {}, json: true, subVerb: 'logout' })).toBe(0);
    expect(loggedOut).toBe('fake');
    expect(out.text()).toContain('account-canary');
    expect(out.text()).not.toContain('token');
  });
});
