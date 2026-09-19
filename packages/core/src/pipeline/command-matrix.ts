// DESIGN 2.5.1 — the command x state matrix, as DATA: a spec-17.2 command is never "IMPOSSIBLE" in a state, it has
// a row or a DEFINED rejection. DESIGN's own table uses six STATE CLASSES (`IDLE`, `*active`, `*suspended`,
// `FAILED`, `BLOCKED`, `COMPLETED`/`CANCELLED`), not the eighteen concrete `PipelineState`s one at a time — this
// file keeps that shape (`stateClassOf` classifies every concrete state into one of the six) so the matrix reads
// exactly like DESIGN's table and the totality test can still walk every concrete state.
import {
  ACTIVE_PIPELINE_STATES,
  type ActivePipelineState,
  type PipelineState,
  SUSPENDED_STATES,
  TERMINAL_STATES,
} from '@cohorte/protocol';

/** The six columns of DESIGN 2.5.1's command x state matrix. */
export type StateClass = 'idle' | 'active' | 'suspended' | 'failed' | 'blocked' | 'terminal';

const ACTIVE_SET: readonly string[] = ACTIVE_PIPELINE_STATES;
const SUSPENDED_SET: readonly string[] = SUSPENDED_STATES;
const TERMINAL_SET: readonly string[] = TERMINAL_STATES;

export function stateClassOf(state: PipelineState): StateClass {
  if (state === 'IDLE') return 'idle';
  if (state === 'FAILED') return 'failed';
  if (state === 'BLOCKED') return 'blocked';
  if (ACTIVE_SET.includes(state)) return 'active';
  if (SUSPENDED_SET.includes(state)) return 'suspended';
  if (TERMINAL_SET.includes(state)) return 'terminal';
  throw new RangeError(`stateClassOf: unrecognised pipeline state ${JSON.stringify(state)}`);
}

/** The seven spec-17.2 commands this matrix covers — the other `CommandType`s (`start`, `status`, `inspect`,
 * `tail`, `run-tool`, `reconcile`, `shutdown`, `agent.send`) are reads, admin, or run creation, not a pipeline-state
 * transition, and DESIGN 2.5.1's table does not carry them. */
export const MATRIX_COMMANDS = ['pause', 'resume', 'retry', 'skip', 'cancel', 'approve', 'deny'] as const;
export type MatrixCommand = (typeof MATRIX_COMMANDS)[number];

/** DESIGN 2.5.1 spells the skip row `T33` in prose, but the TABLES mint ONE row PER SKIPPABLE PHASE — `T33-TEST`,
 * `T33-REVIEW`, … (`tables/shared.ts`, `skipRow`), because each carries the entry effects of the success-path row it
 * replaces. There is therefore NO row whose id is the bare `T33`, and a matrix cell must never name one. */
export const SKIP_DEF_ID_PREFIX = 'T33-';

/** The id of the `skip` row that fires from `phase` — for a suspended or FAILED run, of the run's `resumeTo`
 * (DESIGN 2.5.1's "T33 if policy (on `resumeTo`)"). Returns an id even for a phase this profile does not let `skip`
 * fire from: the caller looks it up in the run's own table, where an unskippable phase simply has no such row. */
export function skipDefIdFor(phase: ActivePipelineState): string {
  return `${SKIP_DEF_ID_PREFIX}${phase}`;
}

export type CommandMatrixCell =
  | { readonly kind: 'transition'; readonly defId: string }
  /** the row is minted per phase: resolve it with `skipDefIdFor(phase)` against the run's own table, never as a
   * literal id (only `skip` is shaped this way — see `SKIP_DEF_ID_PREFIX`) */
  | { readonly kind: 'transition-per-phase'; readonly defIdPrefix: typeof SKIP_DEF_ID_PREFIX }
  | { readonly kind: 'noop' }
  | { readonly kind: 'reject'; readonly code: string; readonly message: string }
  /** applies (an approval decision) and MAY additionally trigger the named row — e.g. `approve` resolving the LAST
   * blocking approval fires T30. */
  | { readonly kind: 'applies'; readonly mayTransition?: string }
  /** `resume` on an IDLE run: no pipeline-state row fires (a signed `start` is already enqueued, DESIGN 4.3 #1) —
   * this wakes a detached host to drain it. */
  | { readonly kind: 'spawns-host' };

type Row = Readonly<Record<StateClass, CommandMatrixCell>>;

const reject = (code: string, message: string): CommandMatrixCell => ({ kind: 'reject', code, message });
const transition = (defId: string): CommandMatrixCell => ({ kind: 'transition', defId });
const noop: CommandMatrixCell = { kind: 'noop' };
const perPhaseSkip: CommandMatrixCell = { kind: 'transition-per-phase', defIdPrefix: SKIP_DEF_ID_PREFIX };

export const COMMAND_MATRIX = {
  pause: {
    idle: reject('conflict/not-running', 'pause: the run has not started'),
    active: transition('T20'),
    suspended: noop,
    // FAILED and BLOCKED are HALTED, not terminal (`HALTED_STATES`, protocol/vocabulary.ts): `retry` and
    // `resume --ack` are REQUIRED rows out of them, so the rejection must not tell the human the run is over.
    // DESIGN 2.5.1 reserves `conflict/run-terminal` for the COMPLETED/CANCELLED column alone.
    failed: reject('conflict/run-halted', 'pause: the run is halted; use `retry` to resume a FAILED run'),
    blocked: reject('conflict/run-halted', 'pause: the run is halted; use `resume --ack` to resume a BLOCKED run'),
    terminal: reject('conflict/run-terminal', 'pause: the run already stopped'),
  },
  resume: {
    idle: { kind: 'spawns-host' },
    active: noop,
    suspended: transition('T30'),
    failed: reject('conflict/use-retry', 'resume: a FAILED run is resumed with `retry`, not `resume`'),
    blocked: transition('T32'),
    terminal: reject('conflict/run-terminal', 'resume: the run already stopped'),
  },
  retry: {
    idle: reject('conflict/not-running', 'retry: the run has not started'),
    active: reject('conflict/run-active', 'retry: only an agent-level retry is legal while the run is active'),
    suspended: reject('conflict/use-resume', 'retry: a suspended run is resumed with `resume`, not `retry`'),
    failed: transition('T31'),
    blocked: reject('conflict/use-resume-ack', 'retry: a BLOCKED run is resumed with `resume --ack`, not `retry`'),
    terminal: reject('conflict/run-terminal', 'retry: the run already stopped'),
  },
  skip: {
    idle: reject('conflict/not-running', 'skip: the run has not started'),
    active: perPhaseSkip,
    suspended: perPhaseSkip,
    failed: perPhaseSkip,
    blocked: reject('conflict/run-blocked', 'skip: a BLOCKED run is resumed first'),
    terminal: reject('conflict/run-terminal', 'skip: the run already stopped'),
  },
  cancel: {
    idle: transition('T27'),
    active: transition('T27'),
    suspended: transition('T27'),
    failed: transition('T27'),
    blocked: transition('T27'),
    terminal: noop,
  },
  approve: {
    idle: reject('conflict/not-running', 'approve: nothing is pending for a run that has not started'),
    active: { kind: 'applies', mayTransition: 'T30' },
    suspended: { kind: 'applies', mayTransition: 'T30' },
    failed: { kind: 'applies' },
    blocked: { kind: 'applies' },
    terminal: reject('conflict/run-terminal', 'approve: the run already stopped'),
  },
  deny: {
    idle: reject('conflict/not-running', 'deny: nothing is pending for a run that has not started'),
    active: { kind: 'applies', mayTransition: 'T30' },
    suspended: { kind: 'applies', mayTransition: 'T30' },
    failed: { kind: 'applies' },
    blocked: { kind: 'applies' },
    terminal: reject('conflict/run-terminal', 'deny: the run already stopped'),
  },
} as const satisfies Readonly<Record<MatrixCommand, Row>>;

export function commandMatrixCell(command: MatrixCommand, state: PipelineState): CommandMatrixCell {
  return COMMAND_MATRIX[command][stateClassOf(state)];
}
