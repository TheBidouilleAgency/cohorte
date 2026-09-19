import { describe, expect, test } from 'vitest';
import authCheck from '../../src/doctor/checks/auth/index.ts';
import { fakeCliContext } from '../registry/helpers.ts';

describe('doctor auth check', () => {
  test('reports attention when the runtime has no credential', async () => {
    const runtime = {
      authStatus: async () => [{ provider: 'fake', state: 'absent', subscription: false, source: 'none' }],
    };
    const result = await authCheck.run(fakeCliContext({ runtime: { resolve: () => runtime as never } }));
    expect(result.status).toBe('warning');
    expect(result.id).toBe('auth');
  });
});
