// U1.08 deliverable: idempotency-key builders (DESIGN 4.1's key column, 7.1 "idempotency keys" row) and the
// EffectJournal's exactly-once semantics (DESIGN 4.1: "the same key seen again ... nothing re-executes"; DESIGN 4.5:
// "the grant is consumed inside the intent transaction ... exactly once, even across a crash"). Tests first (PLAN §3
// rule 9).
import { CohorteError, type JsonValue, type RunId } from '@cohorte/base';
import type { StateStore } from '@cohorte/persistence/contract';
import { FaultInjector, FixedClock, fakeRedactor, SeqIds } from '@cohorte/testkit';
import { makeSpool, makeStore, sealForTest } from '@cohorte/testkit/store-factory';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { EffectSpec } from '../../src/contract/internal.ts';
import { resetCrashpointOccurrences, SimulatedCrash, setFaultInjector } from '../../src/durability/crashpoints.ts';
import { createEffectJournal, effectKeys } from '../../src/durability/journal/index.ts';
import { createEventWriter } from '../../src/events/index.ts';
import { asAgentId, asRunId, SHA_A, SHA_B, seedActiveRun } from './support.ts';

describe('effectKeys — DESIGN 4.1 idempotency-key column, 7.1 "idempotency keys" row', () => {
  const runId = asRunId('keys');
  const agentId = asAgentId('impl-1');

  test('one deterministic builder per effect kind of the 4.1 table', () => {
    expect(effectKeys.snapshotMaterialize(runId)).toBe(`snap:${runId}`);
    expect(effectKeys.gitRefCreate(runId, 'refs/heads/x')).toBe(`ref:${runId}:refs/heads/x`);
    expect(effectKeys.worktreeAdd(runId, 'main')).toBe(`wt:${runId}:main`);
    expect(effectKeys.provisionCommand(runId, 'main', SHA_A)).toBe(`prov:${runId}:main:${SHA_A}`);
    expect(effectKeys.agentSpawn(runId, agentId, 2)).toBe(`${runId}:${agentId}:2`);
    expect(effectKeys.toolCall(runId, agentId, 1, 4)).toBe(`tool:${runId}:${agentId}:1:4`);
    expect(effectKeys.checkCommand(runId, 'lint', SHA_A)).toBe(`check:${runId}:lint:${SHA_A}`);
    expect(effectKeys.gitCommit(runId, 'main', 2)).toBe(`commit:${runId}:main:2`);
    expect(effectKeys.gitMerge(runId, 'aaa', 'bbb')).toBe(`merge:${runId}:aaa:bbb`);
    expect(effectKeys.worktreeReset(runId, 'main', 'ccc', 1)).toBe(`reset:${runId}:main:ccc:1`);
    expect(effectKeys.approvalByToolCall('call-1')).toBe('apr:call-1');
    expect(effectKeys.approvalByKind(runId, 'ship', 'phr-1')).toBe(`apr:${runId}:ship:phr-1`);
  });

  test('DEVIATION (docs/v3/requests/U1.08.md R4): the four kinds absent from the 4.1 table reuse an existing namespace', () => {
    expect(effectKeys.worktreeRemove(runId, 'main')).toBe(`wt:${runId}:main:remove`);
    expect(effectKeys.worktreeRemove(runId, 'main')).not.toBe(effectKeys.worktreeAdd(runId, 'main'));
    // tool.read / tool.network_request / tool.git_commit all key like tool.write_file / tool.patch_file / tool.run_command.
    expect(effectKeys.toolCall(runId, agentId, 1, 1)).toBe(`tool:${runId}:${agentId}:1:1`);
  });

  test('the same inputs always mint the same key (stability across incarnations)', () => {
    expect(effectKeys.toolCall(runId, agentId, 1, 1)).toBe(effectKeys.toolCall(runId, agentId, 1, 1));
    expect(effectKeys.agentSpawn(runId, agentId, 3)).toBe(effectKeys.agentSpawn(runId, agentId, 3));
  });

  test('check.command is keyed by the tree digest computed once before the sequence (DESIGN 2.5.2): different digests never collide', () => {
    expect(effectKeys.checkCommand(runId, 'lint', SHA_A)).not.toBe(effectKeys.checkCommand(runId, 'lint', SHA_B));
  });
});

async function setup() {
  const store: StateStore = await makeStore();
  const clock = new FixedClock();
  const ids = new SeqIds();
  const redactor = fakeRedactor();
  const writer = createEventWriter({ redactor, clock, ids, spool: makeSpool() });
  const journal = createEffectJournal({ store, events: writer, clock, redactor });
  const runId: RunId = asRunId('journal-keys');
  const lease = await seedActiveRun(store, runId);
  return { store, clock, ids, redactor, journal, runId, lease };
}

function specFor(
  runId: RunId,
  overrides: Partial<Omit<EffectSpec<JsonValue>['intent'], 'runId'>> & { idempotencyKey: string },
  perform: EffectSpec<JsonValue>['perform'],
): EffectSpec<JsonValue> {
  return {
    intent: { runId, kind: 'tool.write_file', replayClass: 'verifiable', request: {}, verify: {}, ...overrides },
    before: [],
    perform,
  };
}

describe('createEffectJournal — exactly-once (DESIGN 4.1)', () => {
  afterEach(() => {
    setFaultInjector(null);
    resetCrashpointOccurrences();
  });

  test('a duplicate idempotency key replays the stored result: perform never re-executes', async () => {
    const { journal, runId, lease } = await setup();
    const perform = vi.fn(async () => ({ result: { ok: true } as JsonValue, after: [] }));
    const spec = specFor(runId, { idempotencyKey: 'dup-1' }, perform);

    const first = await journal.run(lease, spec, new AbortController().signal);
    expect(first).toEqual({ status: 'done', result: { ok: true } });

    const second = await journal.run(lease, spec, new AbortController().signal);
    expect(second).toEqual({ status: 'replayed', result: { ok: true } });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  test('an allow-once grant is consumed exactly once, even across a simulated crash between tx A and tx B (FaultInjector)', async () => {
    const { store, clock, ids, journal, runId, lease } = await setup();
    const approvalId = ids.next<'ApprovalId'>('apr');
    await store.transact({ runId }, lease, (tx) => {
      tx.putApproval({
        approvalId,
        runId,
        idempotencyKey: 'apr:grant-1',
        kind: 'tool-call',
        status: 'allow-once',
        request: sealForTest({ tool: 'write_file' }),
        grantKey: 'grant-key-1',
        requestedSeq: tx.run().lastSequence,
        createdAt: clock.now(),
      });
    });

    // Simulate window 2 of DESIGN 4.1 ("perform the external effect ── crash window 2 ──"): `perform()` ran (its
    // work happened, exactly once) but the host died before tx B recorded `done`.
    const injector = new FaultInjector();
    injector.arm('tool.after-effect');
    setFaultInjector({
      shouldFail: (point) => {
        try {
          injector.hit(point);
          return false;
        } catch {
          return true;
        }
      },
    });

    const perform = vi.fn(async () => ({ result: { done: true } as JsonValue, after: [] }));
    const spec = specFor(runId, { idempotencyKey: 'grant-crash-1', consumesGrant: approvalId }, perform);

    await expect(journal.run(lease, spec, new AbortController().signal)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(perform).toHaveBeenCalledTimes(1);

    const afterCrash = (await store.readRunTree(runId)).approvals.find((a) => a.approvalId === approvalId);
    expect(afterCrash?.consumedByEffect).toBeDefined();
    const consumingEffect = afterCrash?.consumedByEffect;

    // The next incarnation retries the SAME idempotency key. No crash armed this time: the intent row is still
    // `intent` (never blindly redone, DESIGN 4.1), so the journal fails closed instead of re-running `perform`.
    setFaultInjector(null);
    const thrown: unknown = await journal.run(lease, spec, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CohorteError);
    expect((thrown as CohorteError).info.code).toBe('human-required/in-doubt-effect');
    expect(perform).toHaveBeenCalledTimes(1); // nothing re-executed

    const afterRetry = (await store.readRunTree(runId)).approvals.find((a) => a.approvalId === approvalId);
    expect(afterRetry?.consumedByEffect).toBe(consumingEffect); // consumed exactly once, by the same effect
  });
});
