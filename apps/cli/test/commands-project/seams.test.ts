import { describe, expect, test } from 'vitest';
import discover from '../../src/commands/discover/index.ts';
import reconcile from '../../src/commands/reconcile/index.ts';
import { fakeCliContext } from '../registry/helpers.ts';

describe('project command seams', () => {
  test('semantic discovery remains a seam while reconcile apply is live', async () => {
    await expect(
      discover.run(fakeCliContext(), { positionals: ['--semantic'], options: {}, json: false }),
    ).rejects.toThrow('semantic discovery is not available');
    expect(reconcile.run).toBeTypeOf('function');
  });
});
