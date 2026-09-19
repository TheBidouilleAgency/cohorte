import { describe, expect, test } from 'vitest';
import * as barrel from '../../src/index.ts';
import * as schema from '../../src/schema/index.ts';

describe('the Wave-0 frozen barrel of @cohorte/config', () => {
  test('the barrel re-exports the whole schema entry point', () => {
    for (const name of Object.keys(schema)) expect(Object.keys(barrel), name).toContain(name);
    for (const name of [
      'CohorteConfig',
      'DEFAULT_CONFIG',
      'Ownership',
      'Spec',
      'Manifest',
      'SkillManifest',
      'CommandRule',
      'SymlinkPolicy',
      'NetworkPolicyConfig',
      'CONFIG_KEY_TRUST',
      'TrustRecord',
    ]) {
      expect(Object.keys(schema), name).toContain(name);
    }
  });
});
