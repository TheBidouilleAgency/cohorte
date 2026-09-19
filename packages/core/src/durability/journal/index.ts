// @cohorte/core/durability/journal — DESIGN 4.1 (intent -> effect -> done), 4.2 E7 (the journal's own sub-steps),
// 4.3 (#6, #12, #13: crash points), 0.2 I5 ("Events first, then effects"), 2.5 (`EffectJournal`, `EffectSpec`).
// PLAN U1.08. Wave-0 seam (PLAN U0.08) replaced: this file is now the implementation.
//
// `JournalDeps` is the FROZEN contract of `contract/factories.ts`, re-exported below — never a second interface of the
// same name. It gained `redactor` in U0.08's fix round 1: `completeEffect` demands a `SealedJson` result (I7), so
// `run()` needs a redactor to seal `perform()`'s return value before it is persisted, and the frozen type was WIDENED
// where it lives rather than shadowed here.
import { CohorteError, errorOf, type JsonValue, toErrorInfo } from '@cohorte/base';
import type { EffectIntent, EffectKind, LeaseToken, StoreTx } from '@cohorte/persistence/contract';
import type { JournalDeps } from '../../contract/factories.ts';
import type { EffectJournal, EffectSpec } from '../../contract/internal.ts';
import { type Crashpoint, crashpoint } from '../crashpoints.ts';

export { effectKeys } from './keys.ts';
export type { JournalDeps };

/**
 * The three positions DESIGN 4.1 defines — after the intent transaction, after the external effect, after the done
 * transaction — named per effect KIND. The journal is one code path but the crash registry (DESIGN 4.3) is not: a
 * single hardcoded `tool.*` family would (a) make `tool.after-intent#3` of a crash-matrix case land inside a
 * snapshot, a provisioning command or a merge, since `crashpoint()` counts occurrences per NAME, and (b) leave
 * `transition-effect.after-intent` / `.after-external` never hit, which fails the crash suite ("a declared point
 * never hit fails the suite").
 *
 * A kind with no dedicated row in the 4.3 table gets the generic transition-effect pair, which row 6 names for
 * exactly that: an effect run through the journal from a transition (`create-integration-branch` =
 * `git.branch.create`, `mint-review-ref` = `git.ref.create`, …). Rows with only ONE named point fire only that one:
 * `provision.after-worktree-add`, `commit.after-git-commit`, `merge.after-update-ref` and `reset.after-git-reset`
 * all describe the world AFTER the external effect, with the row still `intent`. Recorded as R8 in
 * docs/v3/requests/U1.08.md.
 */
interface CrashFamily {
  afterIntent?: Crashpoint;
  afterExternal?: Crashpoint;
  afterDone?: Crashpoint;
}

const TOOL_FAMILY: CrashFamily = {
  afterIntent: 'tool.after-intent',
  afterExternal: 'tool.after-effect',
  afterDone: 'tool.after-done',
};
/** DESIGN 4.3 row 6 — the generic pair of an effect journaled from a transition (DESIGN 4.2 E6). */
const TRANSITION_FAMILY: CrashFamily = {
  afterIntent: 'transition-effect.after-intent',
  afterExternal: 'transition-effect.after-external',
};

const CRASH_FAMILY = {
  // no dedicated row: `snapshot.mid-materialize` (row 3) is fired INSIDE the materialiser's own loop, not here
  'fs.snapshot.materialize': TRANSITION_FAMILY,
  'git.branch.create': TRANSITION_FAMILY, // T04 `create-integration-branch`
  'git.ref.create': TRANSITION_FAMILY, // T08 `mint-review-ref`
  'git.worktree.add': { afterExternal: 'provision.after-worktree-add' }, // row 8
  'git.worktree.remove': TRANSITION_FAMILY,
  'git.worktree.reset': { afterExternal: 'reset.after-git-reset' }, // row 21
  'git.commit': { afterExternal: 'commit.after-git-commit' }, // row 15
  'git.merge': { afterExternal: 'merge.after-update-ref' }, // row 16
  'provision.command': { afterExternal: 'provision.after-install' }, // row 8
  'check.command': TOOL_FAMILY, // a check IS a journaled command execution (DESIGN 2.5.2), same three positions
  'agent.spawn': { afterIntent: 'spawn.after-intent', afterExternal: 'spawn.after-ready' }, // row 9
  'tool.read': TOOL_FAMILY,
  'tool.write_file': TOOL_FAMILY, // rows 12, 13
  'tool.patch_file': TOOL_FAMILY,
  'tool.run_command': TOOL_FAMILY,
  'tool.network_request': TOOL_FAMILY,
  'tool.git_commit': TOOL_FAMILY,
} as const satisfies Record<EffectKind, CrashFamily>;

/** The crash points of one effect kind; exported for the crash matrix (DESIGN 7.3) and the tests of this unit. */
export function crashFamilyOf(kind: EffectKind): CrashFamily {
  return CRASH_FAMILY[kind];
}

function fire(point: Crashpoint | undefined): void {
  if (point !== undefined) crashpoint(point);
}

export function createEffectJournal(deps: JournalDeps): EffectJournal {
  return {
    async run<R extends JsonValue>(
      lease: LeaseToken,
      spec: EffectSpec<R>,
      signal: AbortSignal,
    ): Promise<{ status: 'done' | 'replayed'; result: R }> {
      const runId = spec.intent.runId;
      const crashes = crashFamilyOf(spec.intent.kind);

      // `spec.intent` carries plain `request`/`verify` (DESIGN 2.5's `EffectSpec`, frozen in `contract/internal.ts`);
      // `StateStore.beginEffect` persists an `EffectIntent`, whose `request`/`verify` are `SealedJson` (I7). Sealing
      // them is this journal's job — `sealJson`'s own generic parameter mints the brand, never an `as Sealed…`
      // assertion (check-layers rule f).
      const sealedIntent: EffectIntent = {
        ...spec.intent,
        request: deps.redactor.sealJson(spec.intent.request).value,
        verify: deps.redactor.sealJson(spec.intent.verify).value,
      };

      // tx A: assert fencing (the store does it, I6) ; beginEffect(+consumesGrant) + the "started" events -> 'intent'.
      const begin = await deps.store.transact({ runId }, lease, (tx: StoreTx) => {
        const result = tx.beginEffect(sealedIntent);
        if (result.status === 'started' && spec.before.length > 0) deps.events.append(tx, spec.before);
        return result;
      });

      if (begin.status === 'already-done') {
        // I4.1: the same key seen again -> the caller replays the stored result; nothing re-executes.
        return { status: 'replayed', result: begin.record.result as unknown as R };
      }
      if (begin.status === 'open') {
        // 'open' = an `intent` or `in-doubt` row from an EARLIER incarnation, not yet reconciled. Reconciliation by
        // replay class (DESIGN 4.1) is `Resumer`'s job (a different port), never a blind re-execution here: `run()`
        // fails closed. DEVIATION (docs/v3/requests/U1.08.md): "open => verifier policy hook" names no verifier
        // dependency in `JournalDeps`; the smallest consistent reading is this fail-closed refusal.
        throw new CohorteError(
          errorOf(
            'human-required/in-doubt-effect',
            `effect ${spec.intent.idempotencyKey} (${spec.intent.kind}) is still ${begin.record.state}: it must be reconciled by resume before running again`,
          ),
        );
      }

      // DESIGN 4.3, the "after intent" position of this kind's family: intent committed, before the external effect.
      fire(crashes.afterIntent);

      let performed: Awaited<ReturnType<EffectSpec<R>['perform']>>;
      try {
        performed = await spec.perform(signal);
      } catch (thrown) {
        const info = toErrorInfo(thrown, { code: 'tool-terminal/unexpected', class: 'tool-terminal' });
        // Recording the failure is BEST EFFORT and never replaces the error the caller is waiting for. The common
        // way for this transaction to reject is the lease being stolen while `perform` ran (I6): the caller would
        // then learn that the lease is gone and never what the tool actually failed with, and the effect row would
        // be left at `intent` with no recorded error either way. `intent` is exactly what recovery reconciles by
        // replay class (DESIGN 4.1); the lost lease is caught by the next effect, which fails closed on its own.
        try {
          await deps.store.transact({ runId }, lease, (tx: StoreTx) => {
            tx.failEffect(begin.effectId, info);
          });
        } catch {
          /* the store refused (typically conflict/lease-lost): the row stays `intent` for recovery */
        }
        throw thrown;
      }

      // The "after external" position: the effect happened, before it is recorded done.
      fire(crashes.afterExternal);

      const sealedResult = deps.redactor.sealJson(performed.result);

      // tx B: assert fencing ; completeEffect(result) + the "completed" events + ledger rows -> 'done'.
      await deps.store.transact({ runId }, lease, (tx: StoreTx) => {
        if (performed.after.length > 0) deps.events.append(tx, performed.after);
        tx.completeEffect(begin.effectId, sealedResult.value, performed.post);
        for (const entry of performed.ledger ?? []) tx.putLedger(entry);
      });

      // The "after done" position (row 13, tool kinds only): done committed, result not yet delivered to the caller.
      fire(crashes.afterDone);

      return { status: 'done', result: performed.result };
    },
  };
}
