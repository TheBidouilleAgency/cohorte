import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import auth, { openBrowser } from '../../src/commands/auth/index.ts';
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

  test('renders OAuth select prompts and returns the selected option id', async () => {
    const out = captureStream();
    let answer = '';
    const status = { provider: 'fake', state: 'oauth', subscription: true, billing: 'plan-limits' } as const;
    const runtime = {
      login: async (
        _provider: string,
        ui: {
          ask(prompt: { kind: string; message: string; options?: { id: string; label: string }[] }): Promise<string>;
        },
      ) => {
        answer = await ui.ask({
          kind: 'select',
          message: 'Choose an account',
          options: [{ id: 'account-a', label: 'Account A' }],
        });
        return status;
      },
    };
    const ctx = fakeCliContext({
      stdio: { stdout: out.stream, stderr: out.stream, stdin: Readable.from(['1\n']) },
      runtime: { resolve: () => runtime as never },
    });
    expect(await auth.run(ctx, { positionals: ['fake'], options: {}, json: false, subVerb: 'login' })).toBe(0);
    expect(answer).toBe('account-a');
    expect(out.text()).toContain('Account A');
  });

  test('prints both the device URL and one-time code', async () => {
    const out = captureStream();
    const status = { provider: 'fake', state: 'oauth', subscription: true, billing: 'plan-limits' } as const;
    const runtime = {
      login: async (
        _provider: string,
        ui: { show(event: { kind: string; userCode?: string; verificationUri?: string }): void },
      ) => {
        ui.show({ kind: 'device-code', verificationUri: 'https://auth.example/device', userCode: 'ABCD-EFGH' });
        return status;
      },
    };
    const ctx = fakeCliContext({
      stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
      runtime: { resolve: () => runtime as never },
    });

    expect(await auth.run(ctx, { positionals: ['fake'], options: {}, json: false, subVerb: 'login' })).toBe(0);
    expect(out.text()).toContain('Open: https://auth.example/device');
    expect(out.text()).toContain('Code: ABCD-EFGH');
  });

  test('opens a valid browser URL without a shell and rejects unsafe URLs', () => {
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() })) as never;
    expect(openBrowser('https://auth.example/login', spawnProcess)).toBe(true);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(openBrowser('file:///tmp/credentials', spawnProcess)).toBe(false);
    expect(spawnProcess).toHaveBeenCalledOnce();
  });
});
