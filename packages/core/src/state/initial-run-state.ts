// DESIGN 2.5.1 / 4.3 #1 — the `RunState` a fresh run starts from: the row `StoreTx.putRun` writes inside the same
// transaction as the signed `start` command (`enqueueCommand` FIRST, `putRun` only on `'enqueued'`, persistence's
// own contract comment), before `pipeline.started` (T04's guards) has run — the six `HOST_COMPUTED_RUN_KEYS` are
// therefore absent, exactly as `STATES_WITHOUT_HOST_COLUMNS` requires for `IDLE`.
import type { IsoInstant, RunId, Sha256, SpecId } from '@cohorte/base';
import type { RunRecord } from '@cohorte/persistence/contract';
import type { RunState } from '../contract/types.ts';

export interface InitialRunStateInput {
  runId: RunId;
  profile: string;
  tableVersion: number;
  specId: SpecId;
  specSha256: Sha256;
  title: string;
  pinnedInstallDir: string;
  baseBranch: string;
  cohorteVersion: string;
  schemaVersion: number;
  startedAt: IsoInstant;
}

export function initialRunState(input: InitialRunStateInput): RunState {
  const run: RunRecord = {
    runId: input.runId,
    profile: input.profile,
    tableVersion: input.tableVersion,
    specId: input.specId,
    specSha256: input.specSha256,
    title: input.title,
    state: 'IDLE',
    lastSequence: 0,
    lastHash: '',
    version: 0,
    pinnedInstallDir: input.pinnedInstallDir,
    baseBranch: input.baseBranch,
    cancelRequested: false,
    pauseRequested: false,
    schemaVersion: input.schemaVersion,
    cohorteVersion: input.cohorteVersion,
    purgeable: false,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
  };
  return { run, phases: [], agents: [], incarnations: [], worktrees: [], approvals: [], budgets: [], locks: [] };
}
