import { describe, expect, it } from 'vitest';
import { createEffectVerifierRegistry } from '../../src/contract/factories.ts';

describe('effect verifier registry', () => {
  it('exposes injected verifiers by effect kind and returns undefined for unknown kinds', () => {
    const verifier = { verify: async () => 'done' as const };
    const registry = createEffectVerifierRegistry({ verifiers: { 'git.branch.create': verifier } });
    expect(registry.get('git.branch.create')).toBe(verifier);
    expect(registry.get('tool.read')).toBeUndefined();
  });
});
