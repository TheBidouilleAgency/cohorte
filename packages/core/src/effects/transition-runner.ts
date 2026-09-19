import { CohorteError, errorOf, type JsonValue } from '@cohorte/base';
import type { EffectKind, LeaseToken } from '@cohorte/persistence/contract';
import type { TransitionEffectId } from '../contract/ids.ts';
import type { EffectJournal } from '../contract/internal.ts';
import type { TransitionEffectRunner } from '../contract/ports.ts';

export type TransitionEffectHandler = (
  ctx: { runId: string; slot?: string; lease: LeaseToken },
  signal: AbortSignal,
) => Promise<void>;

export interface TransitionEffectRunnerDeps {
  journal: EffectJournal;
  handlers?: Partial<Record<TransitionEffectId, TransitionEffectHandler>>;
}

const KIND_BY_EFFECT: Readonly<Record<TransitionEffectId, EffectKind>> = {
  'record-spec-hash': 'fs.snapshot.materialize',
  'create-integration-branch': 'git.branch.create',
  'open-approval': 'check.command',
  'mint-review-ref': 'git.ref.create',
  'synthesize-check-findings': 'check.command',
  'record-approved-digest': 'check.command',
  'release-locks': 'git.worktree.remove',
  'write-ship-report': 'fs.snapshot.materialize',
  'checkpoint-worktrees': 'git.worktree.reset',
  checkpoint: 'fs.snapshot.materialize',
  'park-agents': 'agent.spawn',
  'schedule-wakeup': 'check.command',
  'cancel-agents': 'agent.spawn',
  'freeze-worktrees': 'git.worktree.reset',
  'record-human-ack': 'check.command',
  'record-skip': 'check.command',
};

const asJson = (value: unknown): JsonValue => value as JsonValue;

export function createTransitionEffectRunner(deps: TransitionEffectRunnerDeps): TransitionEffectRunner {
  return {
    async run(id, ctx, signal) {
      const handler = deps.handlers?.[id];
      if (!handler) {
        throw new CohorteError(
          errorOf('configuration/policy-invalid', `No handler is registered for transition effect ${id}.`),
        );
      }
      await deps.journal.run(
        ctx.lease,
        {
          intent: {
            runId: ctx.runId as never,
            idempotencyKey: `transition:${ctx.runId}:${id}`,
            kind: KIND_BY_EFFECT[id],
            replayClass: 'idempotent',
            ...(ctx.slot ? { slot: ctx.slot } : {}),
            request: asJson({ effect: id, slot: ctx.slot ?? null }),
            verify: asJson({ effect: id }),
          },
          before: [],
          perform: async (performSignal) => {
            await handler(ctx, performSignal);
            return { result: true, after: [] };
          },
        },
        signal,
      );
    },
  };
}
