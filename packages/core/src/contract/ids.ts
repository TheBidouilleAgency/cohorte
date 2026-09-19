// DESIGN 2.5.1 (the transition table) — the closed sets of ids the code table and the loop controller mint. FROZEN
// at G0: adding a row to the table adds only new VALUES here, never a new shape.
import { STOP_REASONS } from '@cohorte/protocol';

/**
 * Every precondition named by a row of `feature@1` / `bugfix@1` / `review@1` (DESIGN 2.5.1), collected once so a
 * `GuardRegistry` (U2.05) can be asserted total against them. A parameterised guard in the table's prose
 * (`phase.available(BRAINSTORM)`, `readiness.in(READY,RESERVATIONS)`, `policy.skip-allows(X)`,
 * `resume.acknowledged(blocked-inspected)`) is one guard id evaluated with the row's own context, not one id per
 * argument.
 */
export const GUARD_IDS = [
  'input.is-idea',
  'phase.available',
  'brainstorm.output-valid',
  'spec.schema-valid',
  'spec.frozen',
  'host.not-root',
  'host.outside-target',
  'config.trust-satisfied',
  'snapshot.captured',
  'runtime.pin-valid',
  'runtime.platform-supported',
  'auth.plan-satisfied',
  'billing.consented',
  'sandbox.meets-policy',
  'repo.base-resolved',
  'locks.project+zones-held',
  'readiness.in',
  'contract.present-or-exempt',
  'surfaces.all-owned',
  'budget.available',
  'readiness.not-ready',
  'surfaces.unowned',
  'agents.all-completed',
  'outputs.schema-valid',
  'diff.within-ownership',
  'integration.merged',
  'tree.digest-recorded',
  'checks.all-passed',
  'checks.digest-equals-integration',
  'checks.failed-non-environmental',
  'loop.may-continue',
  'review.nothing-to-fix',
  'review.no-unreviewed',
  'review.leftovers-parked-or-waived',
  'reviewref.digest-equals-integration',
  'review.has-fix-items',
  'review.no-contract-change',
  'review.contract-change',
  'review.leftovers-routed-ask',
  'review.security-needs-investigation',
  'approval.ship-allowed',
  'tree.digest-equals-approved',
  'acceptance.no-open-human-items',
  'tree.digest-differs-from-approved',
  'checks.errored-environmental',
  'approval.pending-blocking',
  'resume.locks-rebuilt',
  'resume.git-verified',
  'approval.none-pending-blocking',
  'retry.target-legal',
  'resume.acknowledged',
  'policy.skip-allows',
  'skip.justified',
  /** `review@1`'s own `IDLE -> REVIEW` row (DESIGN 2.5.1, the paragraph after the T01-T33 table) */
  'reviewtarget.resolved-to-sha',
] as const;
export type GuardId = (typeof GUARD_IDS)[number];

/**
 * Every declarative transition effect named by the `effects` column of the table (DESIGN 2.5.1), plus
 * `open-approval`'s three kinds folded into one id: the kind travels in the effect's own arguments, not in a
 * separate id per kind.
 */
export const TRANSITION_EFFECT_IDS = [
  'record-spec-hash',
  'create-integration-branch',
  'open-approval',
  'mint-review-ref',
  'synthesize-check-findings',
  'record-approved-digest',
  'release-locks',
  'write-ship-report',
  'checkpoint-worktrees',
  'checkpoint',
  'park-agents',
  'schedule-wakeup',
  'cancel-agents',
  'freeze-worktrees',
  'record-human-ack',
  'record-skip',
] as const;
export type TransitionEffectId = (typeof TRANSITION_EFFECT_IDS)[number];

/** DESIGN 2.5.3 / spec 11.2: every stop reason the loop controller and `checkGlobalStops` may return, re-exported from `protocol` so a totality test never has to import both. */
export const ALL_STOP_REASONS = STOP_REASONS;
