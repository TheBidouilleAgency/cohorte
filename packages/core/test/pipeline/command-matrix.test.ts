// DESIGN 2.5.1 — the command x state matrix, verbatim: a spec-17.2 command is never "IMPOSSIBLE", it has a row or a
// defined rejection in every one of the six state classes. This file mirrors DESIGN's own table as independent,
// hand-typed expected data (never imported from `command-matrix.ts`) so a regression in the production table is
// caught, not merely echoed back at itself.
import type { PipelineState } from '@cohorte/protocol';
import { ACTIVE_PIPELINE_STATES, PIPELINE_STATES } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import type { TransitionTable } from '../../src/contract/types.ts';
import {
  COMMAND_MATRIX,
  type CommandMatrixCell,
  commandMatrixCell,
  MATRIX_COMMANDS,
  type MatrixCommand,
  SKIP_DEF_ID_PREFIX,
  skipDefIdFor,
  stateClassOf,
} from '../../src/pipeline/command-matrix.ts';
import { BUGFIX_V1, FEATURE_V1, REVIEW_V1 } from '../../src/pipeline/tables/index.ts';

const reject = (code: string): Readonly<Record<string, unknown>> => ({ kind: 'reject', code });
const transition = (defId: string): Readonly<Record<string, unknown>> => ({ kind: 'transition', defId });
const perPhaseSkip: Readonly<Record<string, unknown>> = { kind: 'transition-per-phase', defIdPrefix: 'T33-' };
const noop: Readonly<Record<string, unknown>> = { kind: 'noop' };
const applies = (mayTransition?: string): Readonly<Record<string, unknown>> =>
  mayTransition !== undefined ? { kind: 'applies', mayTransition } : { kind: 'applies' };
const spawnsHost: Readonly<Record<string, unknown>> = { kind: 'spawns-host' };

/** DESIGN 2.5.1's table, column-for-column: idle / *active / *suspended / FAILED / BLOCKED / COMPLETED-CANCELLED. */
const EXPECTED: Readonly<Record<MatrixCommand, Readonly<Record<string, Readonly<Record<string, unknown>>>>>> = {
  pause: {
    idle: reject('conflict/not-running'),
    active: transition('T20'),
    suspended: noop,
    // FAILED and BLOCKED are HALTED, not terminal: `conflict/run-terminal` is DESIGN 2.5.1's last column only.
    failed: reject('conflict/run-halted'),
    blocked: reject('conflict/run-halted'),
    terminal: reject('conflict/run-terminal'),
  },
  resume: {
    idle: spawnsHost,
    active: noop,
    suspended: transition('T30'),
    failed: reject('conflict/use-retry'),
    blocked: transition('T32'),
    terminal: reject('conflict/run-terminal'),
  },
  retry: {
    idle: reject('conflict/not-running'),
    active: reject('conflict/run-active'),
    suspended: reject('conflict/use-resume'),
    failed: transition('T31'),
    blocked: reject('conflict/use-resume-ack'),
    terminal: reject('conflict/run-terminal'),
  },
  skip: {
    idle: reject('conflict/not-running'),
    // DESIGN writes `T33`, the TABLES mint `T33-<PHASE>`: the cell names the prefix, never a bare id.
    active: perPhaseSkip,
    suspended: perPhaseSkip,
    failed: perPhaseSkip,
    blocked: reject('conflict/run-blocked'),
    terminal: reject('conflict/run-terminal'),
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
    idle: reject('conflict/not-running'),
    active: applies('T30'),
    suspended: applies('T30'),
    failed: applies(),
    blocked: applies(),
    terminal: reject('conflict/run-terminal'),
  },
  deny: {
    idle: reject('conflict/not-running'),
    active: applies('T30'),
    suspended: applies('T30'),
    failed: applies(),
    blocked: applies(),
    terminal: reject('conflict/run-terminal'),
  },
};

const REPRESENTATIVE: Readonly<Record<string, PipelineState>> = {
  idle: 'IDLE',
  active: 'BUILD',
  suspended: 'PAUSED',
  failed: 'FAILED',
  blocked: 'BLOCKED',
  terminal: 'COMPLETED',
};

describe('command x state matrix — totality', () => {
  it('is total: every (command, state) pair returns a defined cell, never throws', () => {
    for (const command of MATRIX_COMMANDS) {
      for (const state of PIPELINE_STATES) {
        expect(() => commandMatrixCell(command, state)).not.toThrow();
        expect(commandMatrixCell(command, state)).toBeDefined();
      }
    }
  });

  describe.each(MATRIX_COMMANDS)('%s', (command) => {
    for (const [stateClass, expected] of Object.entries(EXPECTED[command])) {
      const state = REPRESENTATIVE[stateClass];
      if (!state) throw new Error(`no representative state for class ${stateClass}`);
      it(`${stateClass} (${state}) -> ${JSON.stringify(expected)}`, () => {
        expect(commandMatrixCell(command, state)).toMatchObject(expected);
      });
    }
  });

  it('a cell depends only on the STATE CLASS: every concrete state of a class yields the identical cell', () => {
    for (const command of MATRIX_COMMANDS) {
      const byClass = new Map<string, CommandMatrixCell>();
      for (const state of PIPELINE_STATES) {
        const cls = stateClassOf(state);
        const cell = commandMatrixCell(command, state);
        const seen = byClass.get(cls);
        if (seen) expect(cell).toEqual(seen);
        else byClass.set(cls, cell);
      }
    }
  });

  it('REQUIRED rows (never "impossible"): retry from FAILED, resume --ack from BLOCKED, cancel from IDLE/FAILED/BLOCKED', () => {
    expect(COMMAND_MATRIX.retry.failed).toEqual(transition('T31'));
    expect(COMMAND_MATRIX.resume.blocked).toEqual(transition('T32'));
    expect(COMMAND_MATRIX.cancel.idle).toEqual(transition('T27'));
    expect(COMMAND_MATRIX.cancel.failed).toEqual(transition('T27'));
    expect(COMMAND_MATRIX.cancel.blocked).toEqual(transition('T27'));
  });

  it('pause on a suspended run and resume on an active run are {noop}', () => {
    expect(COMMAND_MATRIX.pause.suspended).toEqual(noop);
    expect(COMMAND_MATRIX.resume.active).toEqual(noop);
  });
});

/** The assertion that was missing: a cell that tells a consumer "fire row X" is USELESS if X is not a row. Every
 * `defId` and every `mayTransition` the matrix names must exist, exactly once, in EVERY profile table — the matrix is
 * profile-independent, so a name that is real in `feature@1` only is still a hole. */
const TABLES: readonly TransitionTable[] = [FEATURE_V1, BUGFIX_V1, REVIEW_V1];

function namedDefIds(): readonly string[] {
  const named: string[] = [];
  for (const command of MATRIX_COMMANDS) {
    const row: Readonly<Record<string, CommandMatrixCell>> = COMMAND_MATRIX[command];
    for (const cell of Object.values(row)) {
      if (cell.kind === 'transition') named.push(cell.defId);
      else if (cell.kind === 'applies' && cell.mayTransition !== undefined) named.push(cell.mayTransition);
    }
  }
  return named;
}

describe.each(TABLES)('every row id the matrix names is a real row of $profile@$version', (table) => {
  const ids = table.rows.map((row) => row.id);

  it('every literal `defId` / `mayTransition` of the matrix is a row id of this table, exactly once', () => {
    const named = namedDefIds();
    expect(named.length, 'the matrix names at least one row').toBeGreaterThan(0);
    for (const defId of named) {
      expect(
        ids.filter((id) => id === defId),
        `row id "${defId}" named by the matrix`,
      ).toHaveLength(1);
    }
  });

  it('the per-phase `skip` cell resolves through `skipDefIdFor`, and no bare `T33` row exists', () => {
    expect(COMMAND_MATRIX.skip.active).toEqual(perPhaseSkip);
    expect(COMMAND_MATRIX.skip.suspended).toEqual(perPhaseSkip);
    expect(COMMAND_MATRIX.skip.failed).toEqual(perPhaseSkip);
    expect(ids, 'no table has a bare T33 row: they are minted per phase').not.toContain('T33');

    const skipRows = table.rows.filter((row) => row.reason === 'skip-command');
    expect(skipRows.length, `${table.profile}@${table.version} has skip rows`).toBeGreaterThan(0);
    for (const row of skipRows) {
      const phase = ACTIVE_PIPELINE_STATES.find((candidate) => candidate === row.from);
      expect(phase, `skip row ${row.id} fires from an active phase`).toBeDefined();
      if (phase) expect(row.id).toBe(skipDefIdFor(phase));
      expect(row.id.startsWith(SKIP_DEF_ID_PREFIX)).toBe(true);
      expect(ids.filter((id) => id === row.id)).toHaveLength(1);
    }
  });
});
