// DESIGN 2.3.3 — worktrees, commits, merges, unexpected repository changes, locks.
import { EffectId, Sha256 } from '@cohorte/base';
import { Type } from 'typebox';
import { ClosedEnum } from '../open-enum.ts';
import { FileTouch } from '../refs.ts';
import { ArtifactRef } from '../vocabulary.ts';
import { count, durable } from './declare.ts';

export const LOCK_SCOPES = ['project', 'zone', 'run', 'integration', 'slot'] as const;
export const LOCK_MODES = ['shared', 'exclusive'] as const;

const Lock = Type.Object({
  scope: ClosedEnum(LOCK_SCOPES),
  key: Type.String(),
  mode: ClosedEnum(LOCK_MODES),
  owner: Type.String(),
  fencingToken: Type.Optional(count()),
});

export const GIT_EVENTS = {
  'git.worktree.created': durable(
    Type.Object({
      slot: Type.String(),
      path: Type.String(),
      branch: Type.String(),
      baseSha: Type.String(),
      effectId: EffectId,
    }),
  ),
  'git.worktree.provisioned': durable(
    Type.Object({ slot: Type.String(), lockfileSha256: Sha256, network: Type.Boolean(), effectId: EffectId }),
  ),
  'git.worktree.quarantined': durable(
    Type.Object({
      slot: Type.String(),
      resetTo: Type.String(),
      patch: ArtifactRef,
      compensated: Type.Array(EffectId),
    }),
  ),
  'git.worktree.removed': durable(Type.Object({ slot: Type.String(), path: Type.String() })),
  'git.commit.created': durable(
    Type.Object({
      slot: Type.String(),
      branch: Type.String(),
      sha: Type.String(),
      kind: ClosedEnum(['result', 'checkpoint']),
      treeDigest: Type.String(),
      paths: Type.Array(Type.String()),
      effectId: EffectId,
    }),
  ),
  'git.merge.completed': durable(
    Type.Object({
      from: Type.String(),
      into: Type.String(),
      mergeSha: Type.String(),
      treeDigest: Type.String(),
      effectId: EffectId,
    }),
  ),
  'git.merge.conflicted': durable(
    Type.Object({ from: Type.String(), into: Type.String(), files: Type.Array(Type.String()) }),
  ),
  'repo.change.detected': durable(
    Type.Object({
      slot: Type.String(),
      expected: Type.String(),
      actual: Type.String(),
      files: Type.Array(FileTouch),
    }),
  ),
  'lock.acquired': durable(Lock),
  'lock.released': durable(Lock),
  'lock.stolen': durable(Lock),
} as const;
