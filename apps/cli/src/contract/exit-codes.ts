// apps/cli/src/contract/exit-codes.ts — DESIGN 2.8 "Exit codes of a process that waits for a run" + DESIGN 4.7 +
// the controller codes of DESIGN 2.3.4 (`CONTROLLER_EXIT_CODES`). Total over `ErrorClass` because it is built
// directly from `@cohorte/base`'s `EXIT_CODE_BY_CLASS`, which is itself total (a `satisfies Record<ErrorClass, …>`
// literal): the totality test in `apps/cli/test/registry` checks that equality holds, it does not re-derive it.
import { ERROR_CLASSES, type ErrorClass, EXIT_CODE_BY_CLASS } from '@cohorte/base';
import { CONTROLLER_EXIT_CODES, HALTED_STATES, type PipelineState, SUSPENDED_STATES } from '@cohorte/protocol';

export { CONTROLLER_EXIT_CODES, EXIT_CODE_BY_CLASS };

/** DESIGN 4.7 "4 on a suspended state" / DESIGN 2.3.4 "4 accepted-but-pending at --wait expiry (not an error)". */
export const SUSPENDED_EXIT_CODE = 4;
/** DESIGN 2.8 "16 on CANCELLED" (shares the `conflict` class code, but CANCELLED is not itself an error). */
export const CANCELLED_EXIT_CODE = 16;
export const COMPLETED_EXIT_CODE = 0;

const SUSPENDED = new Set<string>(SUSPENDED_STATES);
const HALTED = new Set<string>(HALTED_STATES);

/**
 * DESIGN 2.8 / 4.7: "an observer started by `run`, or any `--wait`, exits 0 on COMPLETED, the class code of
 * `run.lastError` on FAILED/BLOCKED, 4 on a suspended state, 16 on CANCELLED." `lastErrorClass` is required
 * exactly when `state` is FAILED or BLOCKED (DESIGN 2.8: every halted run carries a `lastError`).
 */
export function waitExitCode(state: PipelineState, lastErrorClass?: ErrorClass): number {
  if (state === 'COMPLETED') return COMPLETED_EXIT_CODE;
  if (state === 'CANCELLED') return CANCELLED_EXIT_CODE;
  if (SUSPENDED.has(state)) return SUSPENDED_EXIT_CODE;
  if (HALTED.has(state)) {
    if (!lastErrorClass) throw new RangeError(`waitExitCode: ${state} requires lastErrorClass (DESIGN 2.8)`);
    return EXIT_CODE_BY_CLASS[lastErrorClass];
  }
  // IDLE and every ACTIVE_PIPELINE_STATE are not terminal/suspended: a waiter never observes them as a final state.
  throw new RangeError(`waitExitCode: ${state} is not a terminal or suspended state (DESIGN 2.8)`);
}

export interface ExitCodeHelpRow {
  readonly code: number;
  readonly meaning: string;
}

/** DESIGN 2.3.4 "Controller exit codes: 0 completed · 3 rejected · 4 accepted-but-pending · 2 usage." */
export const CONTROLLER_EXIT_HELP: readonly ExitCodeHelpRow[] = [
  { code: CONTROLLER_EXIT_CODES.completed, meaning: 'completed' },
  { code: CONTROLLER_EXIT_CODES.usage, meaning: 'usage error' },
  { code: CONTROLLER_EXIT_CODES.rejected, meaning: 'rejected' },
  { code: CONTROLLER_EXIT_CODES.pending, meaning: 'accepted, pending at --wait expiry (not an error: durable inbox)' },
];

/** DESIGN 2.8's table, class by class, in spec order. */
export const ERROR_CLASS_EXIT_HELP: readonly ExitCodeHelpRow[] = ERROR_CLASSES.map((errorClass) => ({
  code: EXIT_CODE_BY_CLASS[errorClass],
  meaning: `${errorClass} error`,
}));

export const CANCELLED_EXIT_HELP: ExitCodeHelpRow = { code: CANCELLED_EXIT_CODE, meaning: 'cancelled' };

/** Rendered into `--help` (PLAN U0.10 test: "controller codes 0/2/3/4 documented in --help"). */
export function formatExitCodesHelp(): string {
  const rows = [...CONTROLLER_EXIT_HELP, ...ERROR_CLASS_EXIT_HELP, CANCELLED_EXIT_HELP].reduce<ExitCodeHelpRow[]>(
    (merged, row) => {
      const existing = merged.find((item) => item.code === row.code);
      if (existing) {
        const index = merged.indexOf(existing);
        merged[index] = { code: row.code, meaning: `${existing.meaning} / ${row.meaning}` };
      } else {
        merged.push({ ...row });
      }
      return merged;
    },
    [],
  );
  const width = Math.max(...rows.map((row) => String(row.code).length));
  const lines = rows.map((row) => `  ${String(row.code).padStart(width)}  ${row.meaning}`);
  return ['Exit codes:', ...lines].join('\n');
}
