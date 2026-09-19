// @cohorte/core/integration — Git-backed commit and merge services.
import type { CanonicalPath } from '@cohorte/git/contract';
import type { IntegrationDeps, IntegrationService } from '../contract/factories.ts';

export type { IntegrationDeps, IntegrationService };

const asPath = (value: string): CanonicalPath => value as CanonicalPath;

export function createIntegrationService(deps: IntegrationDeps): IntegrationService {
  return {
    async commit(slot, kind, paths = ['.']) {
      const result = await deps.git.commitAll({
        worktree: asPath(slot),
        message: kind === 'checkpoint' ? 'chore(cohorte): checkpoint' : 'chore(cohorte): apply agent result',
        trailers: { 'Cohorte-Managed': 'true', 'Cohorte-Commit-Kind': kind },
        identity: { name: 'Cohorte', email: 'cohorte@localhost' },
        paths,
      });
      if ('kind' in result) return result;
      return { sha: result.sha, treeDigest: result.treeDigest };
    },

    async merge(fromSlot, intoSlot) {
      const fromFacts = await deps.git.facts(asPath(fromSlot));
      const intoFacts = await deps.git.facts(asPath(intoSlot));
      if (fromFacts.head.kind === 'unborn' || intoFacts.head.kind === 'unborn') {
        return { kind: 'conflict', files: [] };
      }
      const merged = await deps.git.mergeTree(fromFacts.commonDir, intoFacts.head.sha, fromFacts.head.sha);
      if (!merged.clean) return { kind: 'conflict', files: merged.files };
      const mergeSha = await deps.git.commitTree(
        fromFacts.commonDir,
        merged.tree,
        [intoFacts.head.sha, fromFacts.head.sha],
        'chore(cohorte): merge agent result',
        { 'Cohorte-Managed': 'true' },
      );
      const ref = intoFacts.head.kind === 'branch' ? `refs/heads/${intoFacts.head.name}` : 'HEAD';
      const moved = await deps.git.updateRefCas(fromFacts.commonDir, ref, mergeSha, intoFacts.head.sha);
      if (moved === 'moved') return { kind: 'conflict', files: [] };
      return { mergeSha, treeDigest: merged.tree };
    },
  };
}
