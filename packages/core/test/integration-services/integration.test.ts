import { describe, expect, test } from 'vitest';
import { createIntegrationService } from '../../src/integration/index.ts';

describe('integration services', () => {
  test('commits through GitPort with Cohorte trailers', async () => {
    const calls: unknown[] = [];
    const git = {
      commitAll: async (request: unknown) => {
        calls.push(request);
        return { sha: 'commit-sha', treeDigest: 'tree-sha' };
      },
    } as never;
    const service = createIntegrationService({ git, journal: {} as never, events: {} as never });
    await expect(service.commit('/slot', 'result', ['src'])).resolves.toEqual({
      sha: 'commit-sha',
      treeDigest: 'tree-sha',
    });
    expect(calls[0]).toMatchObject({ trailers: { 'Cohorte-Managed': 'true', 'Cohorte-Commit-Kind': 'result' } });
  });

  test('returns a merge conflict when merge-tree is not clean', async () => {
    const git = {
      facts: async (path: string) => ({
        commonDir: '/repo',
        head: {
          kind: 'branch',
          name: path === '/from' ? 'from' : 'main',
          sha: path === '/from' ? 'from-sha' : 'main-sha',
        },
      }),
      mergeTree: async () => ({ clean: false, files: ['src/conflict.ts'] }),
    } as never;
    const service = createIntegrationService({ git, journal: {} as never, events: {} as never });
    await expect(service.merge('/from', '/into')).resolves.toEqual({ kind: 'conflict', files: ['src/conflict.ts'] });
  });
});
