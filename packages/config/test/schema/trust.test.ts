import { type JsonValue, sha256Hex, toIsoInstant } from '@cohorte/base';
import { compileSchema } from '@cohorte/protocol';
import { describe, expect, test } from 'vitest';
import {
  CONFIG_KEY_TRUST,
  CohorteConfig,
  TRUST_CLASSES,
  TrustRecord,
  type TrustStore,
  trustClassOf,
  trustRulesFor,
} from '../../src/schema/index.ts';

type Node = { properties?: Record<string, Node> };

/** Every key of the schema: a node with `properties` is walked, anything else (scalar, array, record) is a key. */
function keysOf(node: Node, pointer = ''): string[] {
  if (node.properties === undefined) return [pointer];
  return Object.entries(node.properties).flatMap(([name, member]) => keysOf(member, `${pointer}/${name}`));
}
const KEYS = keysOf(CohorteConfig as unknown as Node);

describe('CONFIG_KEY_TRUST (DESIGN 2.10.1, ADR-0026)', () => {
  test('the walk sees the whole schema', () => {
    expect(KEYS.length).toBeGreaterThan(60);
    expect(KEYS).toContain('/policy/approvals/unattended');
    expect(KEYS).toContain('/provision/env/npm_config_store_dir');
    expect(KEYS).toContain('/routing/tiers/coding/ref/provider');
  });

  test.for(KEYS)('%s has exactly one class', (pointer) => {
    const rules = trustRulesFor(pointer);
    expect(rules).toHaveLength(1);
    expect(TRUST_CLASSES).toContain(rules[0]?.class);
  });

  test('rules are prefix-disjoint, and every rule names a real key', () => {
    for (const rule of CONFIG_KEY_TRUST) {
      const others = CONFIG_KEY_TRUST.filter((other) => other !== rule);
      expect(
        others.filter((other) => other.pointer === rule.pointer || other.pointer.startsWith(`${rule.pointer}/`)),
        rule.pointer,
      ).toEqual([]);
      expect(
        KEYS.some((key) => key === rule.pointer || key.startsWith(`${rule.pointer}/`)),
        `${rule.pointer} is not in the schema`,
      ).toBe(true);
    }
  });

  test.for([
    ['/sandbox/require', 'best-effort'],
    ['/sandbox/brain', 'process'],
    ['/authentication/allowApiKeys', true],
    ['/authentication/anthropicSubscriptionViaPi/enabled', true],
    ['/authentication/anthropicSubscriptionViaPi/acknowledgePerTokenBilling', true],
    ['/routing/allowedProviders', ['anthropic']],
    ['/routing/fallback/enabled', true],
    ['/policy/commands/allow', []],
    ['/policy/dangerousCommands', []],
    ['/policy/symlinks/mode', 'allow'],
    ['/policy/admin/runTool', true],
    ['/policy/steer/enabled', true],
    ['/policy/skip', ['REVIEW']],
    ['/policy/inDoubt', 'continue'],
    ['/policy/approvals/unattended', 'wait'],
    ['/policy/approvals/ship', 'auto'],
    ['/policy/approvals/autoResume', true],
    ['/checks/test', ['pnpm', 'test']],
    ['/checks/timeoutMs', 1],
    ['/provision/argv', ['pnpm', 'install']],
    ['/provision/network', true],
    ['/provision/env/npm_config_store_dir', '/store'],
    ['/provision/cacheDirs', ['/store']],
    ['/provision/writableCaches', []],
    ['/provision/dependencyDirs', []],
    ['/network/proxyEnv', true],
    ['/runtime/pi/loadFrom', 'bundle'],
    ['/git/worktreeRoot', '/tmp/w'],
  ] as [string, JsonValue][])('the loosening key %s is classed `loosen`', ([pointer, value]) => {
    expect(trustClassOf(pointer, value)).toBe('loosen');
    expect(trustClassOf(pointer), 'without a value: fail closed').toBe('loosen');
  });

  test.for([
    ['/sandbox/require', 'native'],
    ['/sandbox/brain', 'os'],
    ['/policy/symlinks/mode', 'deny-all'],
    ['/policy/symlinks/hardlinksOnWrite', 'deny'],
    ['/policy/inDoubt', 'ask'],
    ['/policy/approvals/unattended', 'deny'],
    ['/policy/approvals/ship', 'human'],
    ['/budgets/run/tokens', 10],
    ['/loop/maxFixRounds', 1],
    ['/policy/commands/deny', []],
    ['/policy/commands/ask', []],
    ['/policy/approvals/parkAfterMinutes', 5],
    ['/retention/transcriptsDays', 1],
  ] as [string, JsonValue][])('%s = %j is `tighten-only`', ([pointer, value]) => {
    expect(trustClassOf(pointer, value)).toBe('tighten-only');
  });

  test('everything else is neutral; an unknown key is never honoured silently', () => {
    for (const pointer of ['/project/id', '/routing/tiers/coding/ref/model', '/git/branchPrefix', '/host/pollMs']) {
      expect(trustClassOf(pointer, 'x')).toBe('neutral');
    }
    expect(trustClassOf('/plugins', [])).toBe('loosen');
    expect(trustClassOf('/sandboxes', 'x')).toBe('loosen');
  });

  test('the data is frozen', () => {
    expect(Object.isFrozen(CONFIG_KEY_TRUST)).toBe(true);
    expect(CONFIG_KEY_TRUST.every((rule) => Object.isFrozen(rule))).toBe(true);
  });
});

describe('TrustRecord and the TrustStore port', () => {
  const record: TrustRecord = {
    policySha256: sha256Hex('policy'),
    loosenedKeys: ['/checks/test', '/sandbox/require'],
    grantedAt: toIsoInstant(0),
    grantedBy: 'enzo',
    mac: 'f'.repeat(64),
  };

  test('the record schema', () => {
    const validate = compileSchema(TrustRecord);
    expect(validate(record).ok).toBe(true);
    const { mac: _dropped, ...unsigned } = record;
    expect(validate(unsigned).ok, 'a record without a MAC is not a record').toBe(false);
    expect(validate({ ...record, policySha256: 'abc' }).ok).toBe(false);
  });

  test('an in-memory implementation satisfies the port: lookup is bound to the policy hash', async () => {
    const records = new Map<string, TrustRecord>();
    const store: TrustStore = {
      lookup: async (projectKeyId, policySha256) => {
        const found = records.get(projectKeyId);
        return found?.policySha256 === policySha256 ? found : undefined;
      },
      grant: async (projectKeyId, grant) => {
        const granted = { ...record, ...grant };
        records.set(projectKeyId, granted);
        return granted;
      },
      revoke: async (projectKeyId) => records.delete(projectKeyId),
    };
    const granted = await store.grant('shop-0123456789ab', {
      policySha256: record.policySha256,
      loosenedKeys: record.loosenedKeys,
      grantedBy: 'enzo',
    });
    const hit = await store.lookup('shop-0123456789ab', record.policySha256);
    const miss = await store.lookup('shop-0123456789ab', sha256Hex('edited policy'));
    const revoked = await store.revoke('shop-0123456789ab');
    const revokedAgain = await store.revoke('shop-0123456789ab');
    expect(hit).toEqual(granted);
    expect(miss).toBeUndefined();
    expect([revoked, revokedAgain]).toEqual([true, false]);
  });
});
