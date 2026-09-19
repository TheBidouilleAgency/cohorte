// DESIGN 2.5.1 — the persisted `TransitionRecord`'s idempotency key, verbatim template:
// `${runId}:${profile}@${tableVersion}:${defId}:${fromPhaseRunId ?? '-'}:${discriminator}`.
//
// DEVIATION: DESIGN gives the template but not what feeds `discriminator` — the piece that keeps two firings of the
// SAME row (e.g. T09 on round 2 of a FIX loop) from colliding. This function does not decide that (it is the
// engine's, a later wave's, business: an iteration number, a guard-outcome digest, a retry ordinal are all legal
// choices depending on the row); it only supplies the exact template, with every input the caller already has.

import type { PhaseRunId, RunId } from '@cohorte/base';
import type { PipelineProfile } from '@cohorte/protocol';

export interface TransitionIdempotencyKeyInput {
  runId: RunId;
  profile: PipelineProfile;
  tableVersion: number;
  defId: string;
  /** the phase the transition fires FROM, when it is an active one; absent from IDLE and from every `*suspended` /
   * `*active`-wildcard-sourced row whose `from` names no single phase run. */
  fromPhaseRunId?: PhaseRunId;
  /** caller-supplied: what distinguishes this firing of `defId` from an earlier one on the same run (DESIGN does
   * not name its shape; see the file header). */
  discriminator: string;
}

export function transitionIdempotencyKey(input: TransitionIdempotencyKeyInput): string {
  return `${input.runId}:${input.profile}@${input.tableVersion}:${input.defId}:${input.fromPhaseRunId ?? '-'}:${input.discriminator}`;
}
