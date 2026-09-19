import type { ExecRequest } from '@cohorte/security/contract';
import { describe, expect, it } from 'vitest';
import { createProvisionerImpl } from '../../src/provision/implementation.ts';

const request = {} as ExecRequest;

describe('Provisioner', () => {
  it('is idempotent for the same command and dependency manifest', async () => {
    let calls = 0;
    const service = createProvisionerImpl({
      executor: {
        capabilities: () => ({}) as never,
        run: async () => {
          calls += 1;
          return { outcome: 'ok', exitCode: 0 } as never;
        },
      },
      requestFor: async () => ({ key: 'lock-a', manifestSha256: 'a'.repeat(64) as never, request }),
    });
    expect(await service.ensure('api')).toBe('fresh');
    expect(await service.ensure('api')).toBe('reused');
    expect(calls).toBe(1);
    expect((await service.verifyDependencies('api')).ok).toBe(true);
  });
});
