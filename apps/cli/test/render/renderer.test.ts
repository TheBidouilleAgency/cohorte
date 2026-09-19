import { describe, expect, test } from 'vitest';
import { createRenderer } from '../../src/render/index.ts';
import { fakeCliContext } from '../registry/helpers.ts';

describe('Renderer', () => {
  test('panel is a bounded no-op in non-interactive mode', async () => {
    expect(
      await createRenderer().panel(
        'status',
        fakeCliContext({
          openStore: async () => ({ listRuns: async () => [], close: async () => {} }) as never,
        }),
      ),
    ).toBe(0);
  });
});
