import { describe, expect, test } from 'vitest';
import discover from '../../src/commands/discover/index.ts';
import reconcile from '../../src/commands/reconcile/index.ts';
import { fakeCliContext } from '../registry/helpers.ts';

describe('project command seams', () => {
  test('semantic discovery and reconcile apply are explicit V3 seams', async () => {
    await expect(
      discover.run(fakeCliContext(), { positionals: ['--semantic'], options: {}, json: false }),
    ).rejects.toThrow('semantic discovery is not available');
    await expect(
      reconcile.run(fakeCliContext(), { positionals: ['--apply'], options: {}, json: false }),
    ).rejects.toThrow('reconcile --apply is not available');
  });
});
