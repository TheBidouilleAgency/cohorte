import { compileSchema } from '@cohorte/protocol';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { CohorteConfig, DEFAULT_CONFIG, PROVISION_ENV_NAMES } from '../../src/schema/index.ts';
import { issuesOf, readSample } from './samples.ts';

const validate = compileSchema(CohorteConfig);
const draft = (): CohorteConfig => structuredClone(DEFAULT_CONFIG) as CohorteConfig;
const pathsOf = (value: unknown): string[] => {
  const checked = validate(value);
  return checked.ok ? [] : checked.error.map((issue) => issue.path);
};

describe('CohorteConfig', () => {
  test('DEFAULT_CONFIG is schema-valid and deeply frozen', () => {
    expect(pathsOf(DEFAULT_CONFIG)).toEqual([]);
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.policy.commands.allow)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.routing.tiers.coding?.ref)).toBe(true);
  });

  test('the defaults DESIGN names', () => {
    expect(DEFAULT_CONFIG.authentication).toEqual({ mode: 'subscription', allowApiKeys: false });
    expect(DEFAULT_CONFIG.budgets.concurrency).toBe(3);
    expect(DEFAULT_CONFIG.budgets.maxIncarnations).toBe(5);
    expect(DEFAULT_CONFIG.policy.symlinks).toEqual({ mode: 'deny-outgoing', hardlinksOnWrite: 'deny' });
    expect(DEFAULT_CONFIG.policy.approvals.parkAfterMinutes).toBe(10);
    expect(DEFAULT_CONFIG.policy.inDoubt).toBe('ask');
    expect(DEFAULT_CONFIG.host).toEqual({ idleExitMinutes: 30, pauseKeepAliveMinutes: 30, pollMs: 250 });
    expect(DEFAULT_CONFIG.loop.leftovers).toEqual({ major: 'fix', minor: 'park', info: 'park' });
    expect(DEFAULT_CONFIG.provision.dependencyDirs).toEqual(['**/node_modules']);
    expect(DEFAULT_CONFIG.git.branchPrefix).toBe('cohorte/');
    expect(DEFAULT_CONFIG.sandbox.require, 'absent = the computed default of DESIGN 2.6.6').toBeUndefined();
    expect(DEFAULT_CONFIG.telemetry.remote).toBe(false);
    expect(DEFAULT_CONFIG.network.proxyEnv).toBe(false);
  });

  test('no open question is frozen as a literal type: runtime.id and provider names are open strings', () => {
    expectTypeOf<CohorteConfig['runtime']['id']>().toEqualTypeOf<string>();
    expectTypeOf<CohorteConfig['routing']['allowedProviders']>().toEqualTypeOf<string[]>();
    const config = draft();
    config.runtime = { id: 'claude-agent-sdk' };
    config.routing.allowedProviders = ['openai-codex', 'mistral'];
    config.routing.tiers.coding = { ref: { provider: 'mistral', model: 'codestral-next' }, thinking: 'off' };
    config.budgets.provider = { mistral: { tokens: 10 } };
    expect(pathsOf(config)).toEqual([]);
  });

  test('the D2 opt-in is a triple: all three acknowledgements or nothing', () => {
    const config = draft();
    config.authentication.anthropicSubscriptionViaPi = {
      enabled: true,
      acknowledgePerTokenBilling: true,
      acknowledgeProviderTermsRisk: true,
    };
    expect(pathsOf(config)).toEqual([]);
    const partial = structuredClone(config) as unknown as { authentication: { anthropicSubscriptionViaPi: object } };
    partial.authentication.anthropicSubscriptionViaPi = { enabled: true };
    expect(pathsOf(partial)).toContain('/authentication/anthropicSubscriptionViaPi');
  });

  test('telemetry.remote is a boolean: `true` is schema-valid, rejecting it is a loader rule (ADR-0013)', () => {
    expectTypeOf<CohorteConfig['telemetry']['remote']>().toEqualTypeOf<boolean>();
    expect(issuesOf(readSample('valid', 'config.telemetry-remote.yaml'))).toEqual([]);
    expect(pathsOf({ ...draft(), telemetry: { remote: 'true' } })).toContain('/telemetry/remote');
  });

  test('provision.env accepts the four allowlisted names and nothing else', () => {
    expect([...PROVISION_ENV_NAMES]).toEqual([
      'npm_config_store_dir',
      'npm_config_cache',
      'YARN_CACHE_FOLDER',
      'COREPACK_HOME',
    ]);
    for (const name of PROVISION_ENV_NAMES) {
      const config = draft();
      config.provision.env = { [name]: '/caches/store' };
      expect(pathsOf(config), name).toEqual([]);
    }
    for (const name of ['PATH', 'NODE_OPTIONS', 'npm_config_registry', 'HOME']) {
      const config = draft() as unknown as { provision: { env: Record<string, string> } };
      config.provision.env = { [name]: '/x' };
      expect(pathsOf(config), name).toContain('/provision/env');
    }
  });

  test('checks and provision.argv are argv arrays, never a string, never empty', () => {
    const asString = draft() as unknown as { checks: { test: unknown } };
    asString.checks.test = 'pnpm test';
    expect(pathsOf(asString)).toContain('/checks/test');
    const empty = draft();
    empty.provision.argv = [];
    expect(pathsOf(empty)).toContain('/provision/argv');
  });

  test('every object is closed', () => {
    expect(pathsOf({ ...draft(), extra: 1 })).not.toEqual([]);
    const nested = draft() as unknown as { policy: { approvals: Record<string, unknown> } };
    nested.policy.approvals.autoApproveEverything = true;
    expect(pathsOf(nested)).not.toEqual([]);
  });

  test('RunSnapshotManifest is NOT a config contract (PLAN PC-8)', async () => {
    const schema = await import('../../src/schema/index.ts');
    expect(Object.keys(schema)).not.toContain('RunSnapshotManifest');
  });
});
