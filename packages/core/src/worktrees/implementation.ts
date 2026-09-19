import { isSafeId, type RunId } from '@cohorte/base';
import type { CanonicalPath, GitPort } from '@cohorte/git/contract';
import type { WorktreeRecord } from '@cohorte/persistence/contract';
import type { ArtifactRef } from '@cohorte/protocol';
import type { WorktreeService } from '../contract/internal.ts';
import type { CheckpointCause, LedgerAudit } from '../contract/types.ts';

export interface WorktreeImplementationDeps {
  git: GitPort;
  runId: RunId;
  repo: CanonicalPath;
  root: CanonicalPath;
  integrationHead: string;
}

const pathFor = (root: string, slot: string): CanonicalPath => `${root}/${slot}` as CanonicalPath;

function validateSlot(slot: string): void {
  if (!isSafeId(slot)) throw new Error(`validation/invalid-id: invalid worktree slot`);
}

export function createWorktreeServiceImpl(deps: WorktreeImplementationDeps): WorktreeService {
  const records = new Map<string, WorktreeRecord>();
  return {
    async acquire(slot, forAgent) {
      validateSlot(slot);
      let integrationHead = deps.integrationHead;
      if (typeof deps.git.facts === 'function') {
        try {
          const integrationFacts = await deps.git.facts(pathFor(deps.root, '_integration'));
          if (integrationFacts.head.kind !== 'unborn') integrationHead = integrationFacts.head.sha;
        } catch {
          // Unit ports may not expose an integration worktree; retain the frozen initial head in that case.
        }
      }
      const existing = records.get(slot);
      if (existing?.state === 'held' && existing.holderAgentId !== forAgent)
        throw new Error(`conflict/worktree-held: ${slot}`);
      if (existing) {
        const branch = `cohorte/${deps.runId}/${slot}/${forAgent}`;
        if (existing.branch !== branch) {
          await deps.git.switchToNewBranch({
            worktree: existing.path as CanonicalPath,
            branch,
            at: integrationHead,
          });
        }
        const next = {
          ...existing,
          branch,
          baseSha: integrationHead,
          checkpointSha: integrationHead,
          holderAgentId: forAgent,
          state: 'held' as const,
        };
        records.set(slot, next);
        return next;
      }
      const path = pathFor(deps.root, slot);
      const branch = `cohorte/${deps.runId}/${slot}/${forAgent}`;
      await deps.git.addWorktree({ repo: deps.repo, path, branch, commit: integrationHead });
      const record: WorktreeRecord = {
        runId: deps.runId,
        slot,
        path,
        branch,
        baseSha: integrationHead,
        checkpointSha: integrationHead,
        holderAgentId: forAgent,
        state: 'held',
      };
      records.set(slot, record);
      return record;
    },

    async checkpoint(slot, _cause: CheckpointCause) {
      const record = records.get(slot);
      if (!record) throw new Error(`configuration/worktree-not-found: ${slot}`);
      const result = await deps.git.commitAll({
        worktree: record.path as CanonicalPath,
        message: 'chore(cohorte): checkpoint',
        trailers: { 'Cohorte-Managed': 'true', 'Cohorte-Checkpoint': 'true' },
        identity: { name: 'Cohorte', email: 'cohorte@localhost' },
        paths: ['.'],
      });
      const sha = 'kind' in result ? record.checkpointSha : result.sha;
      records.set(slot, { ...record, checkpointSha: sha, state: 'held' });
      return sha;
    },

    async release(slot) {
      const record = records.get(slot);
      if (!record) return;
      const next = { ...record, state: 'ready' as const };
      delete next.holderAgentId;
      records.set(slot, next);
    },

    async audit(slot): Promise<LedgerAudit> {
      const record = records.get(slot);
      if (!record) return { slot, verdict: 'missing-branch', entries: [] };
      const changed = await deps.git.changedPaths(record.path as CanonicalPath);
      return {
        slot,
        verdict: changed.length === 0 ? 'ok' : 'unexplained-change',
        entries: changed.map((touch) => ({
          path: touch.path,
          expectedSha256: touch.beforeSha256 ?? null,
          actualSha256: touch.afterSha256 ?? null,
          explained: false,
        })),
      };
    },

    async quarantineAndReset(slot, because): Promise<ArtifactRef> {
      const record = records.get(slot);
      if (!record) throw new Error(`configuration/worktree-not-found: ${slot}`);
      await deps.git.resetHardClean(record.path as CanonicalPath, record.checkpointSha);
      const next = { ...record, state: 'quarantined' as const };
      delete next.holderAgentId;
      records.set(slot, next);
      return {
        artifactId: `art_${because.slice(4)}` as ArtifactRef['artifactId'],
        kind: 'patch',
        path: record.path,
        sha256: '0'.repeat(64) as ArtifactRef['sha256'],
        bytes: 0,
      };
    },

    async resetClean(slot, to) {
      const record = records.get(slot);
      if (!record) throw new Error(`configuration/worktree-not-found: ${slot}`);
      await deps.git.resetHardClean(record.path as CanonicalPath, to);
      records.set(slot, { ...record, checkpointSha: to, state: 'ready' });
    },
  };
}
