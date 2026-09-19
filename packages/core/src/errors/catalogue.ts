// DESIGN 2.8 — the "Run effect (default)" column of the error taxonomy: what happens to the RUN, at the class
// level, when an error of that class surfaces. Re-exports the base catalogue (`ERROR_CATALOGUE`, code -> {class,
// retryable, impact, remediation, exit}); this file adds the coarser class -> run-effect table DESIGN 2.8 does not
// give as data. "Unknown throwables -> <nearest class>/unexpected -> FAILED + checkpoint.created" (DESIGN 2.8): the
// classes an UNCLASSIFIED throwable can land on (`base`'s `UNCLASSIFIED` fallback is `validation/unexpected`) end in
// `FAILED` with `checkpoint: true`, matching T26 (`cancel-agents, checkpoint-worktrees, checkpoint`); `security`
// alone ends in `BLOCKED` (T25: `cancel-agents, freeze-worktrees` — no `checkpoint` effect in that row).
import { ERROR_CLASSES, type ErrorClass } from '@cohorte/base';

export type { ErrorCatalogueEntry, ErrorCode } from '@cohorte/base';
export { ERROR_CATALOGUE, EXIT_CODE_BY_CLASS, isErrorCode } from '@cohorte/base';

export type RunEffectEndState =
  | 'refuse-to-start'
  | 'FAILED'
  | 'BLOCKED'
  | 'WAITING_APPROVAL'
  | 'suspended-auth-or-quota'
  | 'agent-error-result'
  | 'refuse-to-open';

export interface RunEffectRow {
  readonly class: ErrorClass;
  readonly endState: RunEffectEndState;
  /** true when reaching this state also writes a `checkpoint.created` (T26-shaped rows only: T25's BLOCKED does not) */
  readonly checkpoint: boolean;
  /** DESIGN 2.8's "Run effect (default)" column text, verbatim */
  readonly description: string;
}

const row = (cls: ErrorClass, endState: RunEffectEndState, checkpoint: boolean, description: string): RunEffectRow => ({
  class: cls,
  endState,
  checkpoint,
  description,
});

/** Total over `ErrorClass` (DESIGN 2.8, in table order). */
export const RUN_EFFECT_BY_CLASS: Readonly<Record<ErrorClass, RunEffectRow>> = Object.freeze({
  configuration: row('configuration', 'refuse-to-start', false, 'refuse to start / FAILED'),
  validation: row('validation', 'FAILED', true, 'agent failed → retry policy → FAILED'),
  permission: row('permission', 'agent-error-result', false, 'tool.denied; repeated → policy-violation'),
  security: row('security', 'BLOCKED', false, 'BLOCKED, agents cancelled, worktrees frozen'),
  'provider-transient': row('provider-transient', 'FAILED', true, 'retry → FAILED'),
  'provider-terminal': row(
    'provider-terminal',
    'suspended-auth-or-quota',
    false,
    'FAILED, or AUTH_REQUIRED / QUOTA_EXCEEDED',
  ),
  'tool-transient': row('tool-transient', 'agent-error-result', false, 'retry once, then report to the agent'),
  'tool-terminal': row('tool-terminal', 'agent-error-result', false, 'error result to the agent'),
  conflict: row('conflict', 'WAITING_APPROVAL', false, 'WAITING_APPROVAL or FIX'),
  budget: row('budget', 'WAITING_APPROVAL', false, 'WAITING_APPROVAL(budget)'),
  // The RUN effect of a timeout is DESIGN 2.8's column cell: T24 opens a `loop-stalled`/`budget` approval, with no
  // `checkpoint` effect in that row. The FAILED of DESIGN 2.5.3's stop table ("timeout, agent level, retries
  // exhausted") is reached through the agent's `RetryPolicy`, not through this class-level default.
  timeout: row('timeout', 'WAITING_APPROVAL', false, 'retry / WAITING_APPROVAL'),
  corruption: row('corruption', 'refuse-to-open', false, 'refuse to open; never delete a run'),
  'human-required': row('human-required', 'WAITING_APPROVAL', false, 'WAITING_APPROVAL / AUTH_REQUIRED'),
} satisfies Record<ErrorClass, RunEffectRow>);

export function runEffectOf(errorClass: ErrorClass): RunEffectRow {
  const found = RUN_EFFECT_BY_CLASS[errorClass];
  if (!found) throw new TypeError(`runEffectOf: ${String(errorClass)} is not one of ${ERROR_CLASSES.join(', ')}`);
  return found;
}
