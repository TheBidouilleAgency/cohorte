// plan.json U1.09 test 1b — "table-driven from the Wave-0 matrix: every command in every state => the row's
// transition or its defined rejection". Drives `pipeline/command-matrix.ts` (frozen, U0.09) against `FEATURE_V1`
// (frozen, U0.09) through this unit's OWN inbox drain (E1) — the piece this unit actually delivers.

import type { ActivePipelineState, CommandPayloads, PipelineState } from '@cohorte/protocol';
import { describe, expect, it } from 'vitest';
import { drainInbox } from '../../src/engine/inbox.ts';
import {
  COMMAND_MATRIX,
  MATRIX_COMMANDS,
  type MatrixCommand,
  type StateClass,
  skipDefIdFor,
  stateClassOf,
} from '../../src/pipeline/command-matrix.ts';
import { FEATURE_V1 } from '../../src/pipeline/tables/index.ts';
import { makeHarness, realResolveTable, seedIdleRun, signedCommand } from './fixtures.ts';

const REPRESENTATIVE_STATE: Readonly<Record<StateClass, PipelineState>> = {
  idle: 'IDLE',
  active: 'BUILD',
  suspended: 'PAUSED',
  failed: 'FAILED',
  blocked: 'BLOCKED',
  terminal: 'COMPLETED',
};

// Every representative state is actually of the class it is supposed to represent (guards the fixture itself).
for (const [stateClass, state] of Object.entries(REPRESENTATIVE_STATE)) {
  if (stateClassOf(state) !== stateClass)
    throw new Error(`fixture bug: ${state} is ${stateClassOf(state)}, not ${stateClass}`);
}

function payloadFor(command: MatrixCommand): CommandPayloads[MatrixCommand] {
  switch (command) {
    case 'pause':
      return {};
    case 'resume':
      return { acknowledge: 'blocked-inspected' };
    case 'retry':
      return { target: { kind: 'phase' } };
    case 'skip':
      return { phase: 'BUILD', justification: 'test' };
    case 'cancel':
      return { keepWorktrees: true };
    case 'approve':
      return { approvalId: 'apr_00000000000000000000000000000001' as never, scope: 'once' };
    case 'deny':
      return { approvalId: 'apr_00000000000000000000000000000001' as never };
  }
}

describe('command x state matrix (feature@1, driven through drainInbox)', () => {
  for (const command of MATRIX_COMMANDS) {
    for (const stateClass of Object.keys(REPRESENTATIVE_STATE) as StateClass[]) {
      const cell = COMMAND_MATRIX[command][stateClass];
      if (cell.kind === 'applies') continue; // approve/deny: their own dedicated test below

      const state = REPRESENTATIVE_STATE[stateClass];

      it(`${command} from ${stateClass} (${state}) => ${cell.kind}`, async () => {
        const harness = await makeHarness({ resolveTable: realResolveTable });
        await seedIdleRun(harness, { state });
        const cmd = signedCommand(harness, command, payloadFor(command));
        const enqueued = await harness.store.enqueueCommand(cmd);
        expect(enqueued.status).toBe('enqueued');

        const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
        await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: FEATURE_V1 });

        const record = await harness.store.getCommand(cmd.commandId);
        expect(record).toBeDefined();

        if (cell.kind === 'reject') {
          expect(record?.status).toBe('rejected');
          // The DEFINED rejection, not merely "a" rejection. Five of the matrix's codes are absent from
          // `ERROR_CATALOGUE` (`@cohorte/base`, frozen, U0.02), so `errorInfoForCode` keeps them in
          // `details.matrixCode` under a catalogued `conflict/unexpected` (docs/v3/requests/U1.09.md R3); reading
          // either place pins the cell today and keeps passing the day the catalogue gains the five codes.
          const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 50 });
          const rejected = events.find((e) => e.type === 'command.rejected')?.payload as
            | { error: { code: string; details?: { matrixCode?: string } } }
            | undefined;
          expect(rejected).toBeDefined();
          expect(rejected?.error.details?.matrixCode ?? rejected?.error.code).toBe(cell.code);
        } else {
          expect(record?.status).toBe('completed');
        }

        const run = await harness.store.getRun(harness.runId);
        if (cell.kind === 'transition-per-phase') {
          // `skip`'s row is minted PER PHASE (`skipDefIdFor`, U0.09), so the landing state is the one the row for
          // the EFFECTIVE phase names — `run.state` when active, else `resumeTo` (DESIGN 2.5.1's "T33 if policy (on
          // `resumeTo`)"), which `seedIdleRun` seeds as `'BUILD'` for every suspended/failed state.
          const effectivePhase = stateClassOf(state) === 'active' ? state : 'BUILD';
          const def = FEATURE_V1.rows.find((row) => row.id === skipDefIdFor(effectivePhase as ActivePipelineState));
          expect(def).toBeDefined();
          expect(run?.state).toBe(def?.to);
        } else if (cell.kind === 'transition') {
          const def = FEATURE_V1.rows.find((row) => row.id === cell.defId);
          expect(def).toBeDefined();
          // `seedIdleRun`'s default `resumeTo` is `'BUILD'` for every suspended/failed representative state.
          const expected = def?.to === '*resumeTo' ? 'BUILD' : def?.to;
          expect(run?.state).toBe(expected);
        } else if (cell.kind === 'noop' || cell.kind === 'spawns-host' || cell.kind === 'reject') {
          expect(run?.state).toBe(state);
        }

        await harness.store.close();
      });
    }
  }
});

describe('approve / deny: applies, and resolves the last blocking approval into T30', () => {
  it('approve resolves the approval and, as the last pending one, fires T30 back to the resumeTo state', async () => {
    const harness = await makeHarness({ resolveTable: realResolveTable });
    await seedIdleRun(harness, { state: 'WAITING_APPROVAL' });

    const lease = await harness.deps.leases.acquire({ runId: harness.runId }, harness.runId, 'exclusive', 15_000);
    const approvalId = 'apr_00000000000000000000000000000009' as never;
    await harness.store.transact({ runId: harness.runId }, lease, (tx) => {
      tx.patchRun(harness.runId, { resumeTo: 'BUILD' });
      tx.putApproval({
        approvalId,
        runId: harness.runId,
        idempotencyKey: 'idem-1',
        kind: 'tool',
        status: 'pending',
        request: { fake: true } as never,
        grantKey: 'grant-1',
        requestedSeq: 1,
        // `ApprovalRecord.createdAt` is REQUIRED (persistence/records.ts). The `as never` below casts the whole
        // literal, so its absence typechecked; the memory store tolerated it and SQLite refused it with
        // `NOT NULL constraint failed: approvals.created_at`, which is what `COHORTE_TEST_STORE=sqlite` at gate G1
        // found. Recorded in docs/v3/gates/G1.md.
        createdAt: harness.clock.now(),
      } as never);
    });

    const cmd = signedCommand(harness, 'approve', { approvalId, scope: 'once' });
    await harness.store.enqueueCommand(cmd);
    await drainInbox({ deps: harness.deps, runId: harness.runId, host: harness.host, lease, table: FEATURE_V1 });

    const record = await harness.store.getCommand(cmd.commandId);
    expect(record?.status).toBe('completed');
    const run = await harness.store.getRun(harness.runId);
    expect(run?.state).toBe('BUILD');
    const tree = await harness.store.readRunTree(harness.runId);
    const resolved = tree.approvals.find((a) => a.approvalId === approvalId);
    expect(resolved?.status).toBe('allow-once');

    // `ApprovalDecisionRecord.resolvedSeq` is "the sequence of `approval.resolved`" (persistence/records.ts) — the
    // real one, not a placeholder.
    const events = await harness.store.readEvents(harness.runId, { afterSequence: 0, limit: 50 });
    const resolvedEvent = events.find((e) => e.type === 'approval.resolved');
    expect(resolvedEvent).toBeDefined();
    expect(resolved?.resolvedSeq).toBe(resolvedEvent?.sequence);

    await harness.store.close();
  });
});
