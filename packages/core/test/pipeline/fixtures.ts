// Shared, PURE helpers for the U0.09 kernel tests. Not a test file (no `*.test.ts` suffix): vitest never collects
// it, so it is safe to import from several `*.test.ts` siblings without becoming shared MUTABLE state (PLAN §3
// rule 9 forbids a shared mutable fixture, not a shared pure helper).
import type { IsoInstant, RunId, Sha256, SpecId } from '@cohorte/base';
import type { GuardOutcome, PipelineState } from '@cohorte/protocol';
import type { RunState, TransitionTable } from '../../src/contract/types.ts';
import { nextStep } from '../../src/pipeline/next-step.ts';
import type { ReasonOrOutcome, ResolveTransitionResult } from '../../src/pipeline/resolve-transition.ts';
import { resolveTransition } from '../../src/pipeline/resolve-transition.ts';
import { initialRunState } from '../../src/state/initial-run-state.ts';

const RUN_ID = 'run_00000000000000000000000001' as RunId;
const SPEC_ID = 'spc_00000000000000000000000001' as SpecId;
const SPEC_SHA256 = 'a'.repeat(64) as Sha256;
const STARTED_AT = '2026-01-01T00:00:00.000Z' as IsoInstant;

/** A minimal, valid `RunState` whose `run.state` is whatever the caller needs — everything `nextStep` /
 * `resolveTransition` read from `RunState` is just `run.state`, so the rest of the aggregate is fixture noise. */
export function stateAt(state: PipelineState): RunState {
  const base = initialRunState({
    runId: RUN_ID,
    profile: 'feature',
    tableVersion: 1,
    specId: SPEC_ID,
    specSha256: SPEC_SHA256,
    title: 'U0.09 fixture',
    pinnedInstallDir: '/tmp/u0.09-fixture-pin',
    baseBranch: 'main',
    cohorteVersion: '3.0.0-test',
    schemaVersion: 1,
    startedAt: STARTED_AT,
  });
  return { ...base, run: { ...base.run, state } };
}

/** DESIGN 4.2 E3/E4/E5, the happy path: `nextStep` narrows the table to every row reachable from `from` and hands
 * back the UNION of their guard ids; this fixture answers every one of them `ok: true` (the facts a `collectFacts`
 * a later wave builds would report when nothing blocks the transition) and resolves through `resolveTransition`. */
export function resolveAllPass(
  table: TransitionTable,
  from: PipelineState,
  reasonOrOutcome: ReasonOrOutcome,
): ResolveTransitionResult {
  const step = nextStep(stateAt(from), table);
  const outcomes: readonly GuardOutcome[] = step.guards.map((id) => ({ id, ok: true }));
  return resolveTransition(table, from, reasonOrOutcome, outcomes);
}
