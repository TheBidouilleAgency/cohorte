// U1.10 — `createResumer().recover()` end to end, DESIGN 4.4 steps 1-11, over a real `MemoryStateStore` (synthetic
// journals: the store is seeded directly, without running an engine, matching each step's "On disk" column).
import { CohorteError, type EffectId, type RunId } from '@cohorte/base';
import type { StateStore } from '@cohorte/persistence/contract';
import { FixedClock, fakeRedactor, SeqIds } from '@cohorte/testkit';
import { makeSpool, makeStore, sealForTest } from '@cohorte/testkit/store-factory';
import { describe, expect, test } from 'vitest';
import { createEventWriter } from '../../src/events/index.ts';
import { createResumer, type ResumeDeps } from '../../src/resume/index.ts';
import {
  agentId2,
  agentRecord,
  approvalId2,
  approvalRecord,
  at,
  builtinVerifiersFor,
  canonicalPath,
  commandEnvelope,
  fakeSweeper,
  fakeToolHostReplay,
  fakeWorktreeService,
  hostContext,
  incarnationRecord,
  installInspectorFor,
  lockOwner,
  phaseRecord,
  phaseRunId2,
  seedResumableRun,
  seedResumableRunNoLock,
  sha256Of,
  toolCallId2,
  worktreeRecord,
} from './support.ts';

const INSTALL_DIR = '/opt/cohorte/3.0.0';

function baseDeps(store: StateStore, overrides: Partial<ResumeDeps> = {}, seed = 500): ResumeDeps {
  const clock = new FixedClock('2026-02-01T00:00:00.000Z');
  // seeded 500: `support.ts`'s `seedEventWriter()` mints from a SEPARATE, independently-counting `SeqIds` (its own
  // `evt_…01`, `evt_…02`, …) for the run's `pipeline.started` / `run.state.changed`; without an offset here
  // `recover()`'s own writer would mint the SAME ids for its first events and the store would refuse them as
  // duplicates (`StoreUsageError: appendEvents: eventId … exists`). The same source mints the `apr_…` of the
  // `blocked-ack` approvals of steps 6 / 11: `SeqIds` counts per prefix, so the two never collide.
  const ids = new SeqIds({ seed });
  return {
    store,
    clock,
    ids,
    sweeper: fakeSweeper(),
    effectVerifiers: builtinVerifiersFor(),
    worktrees: fakeWorktreeService(),
    events: createEventWriter({ redactor: fakeRedactor(), clock, ids, spool: makeSpool() }),
    redactor: fakeRedactor(),
    toolHostReplay: fakeToolHostReplay(),
    installInspector: installInspectorFor(INSTALL_DIR),
    ...overrides,
  };
}

/** The human-facing text of an `approval.requested` payload (an `ApprovalRequest`, DESIGN 2.3.3). */
function previewTextOf(payload: unknown): string {
  const request = payload as { preview?: { text?: string } } | undefined;
  return request?.preview?.text ?? '';
}

async function reject(promise: Promise<unknown>): Promise<CohorteError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CohorteError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject with a CohorteError');
}

describe('step 1 — migration check, never automatic', () => {
  test('a store with no pending migration resumes past step 1', async () => {
    const store = await makeStore();
    const runId = 'run_step1_a'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const deps = baseDeps(store);
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.hostId).toBe('host-1');
    await store.close();
  });
});

describe('step 2 — verifyChain + projection compare', () => {
  test('a hand-edited projection (state patched with no matching event) is refused as corruption/projection-mismatch', async () => {
    const store = await makeStore();
    const runId = 'run_step2_a'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    // No `run.state.changed` event backs this: `evolve()`'s replay still says BUILD, the row now says REVIEW.
    await store.transact({ runId }, lease, (tx) => {
      tx.patchRun(runId, { state: 'REVIEW' });
    });
    const deps = baseDeps(store);
    const error = await reject(createResumer(deps).recover(runId, hostContext()));
    expect(error.info.code).toBe('corruption/projection-mismatch');
    await store.close();
  });
});

describe('step 3 — lease: live owner refused, dead owner taken over with fencing+1', () => {
  test('live owner ⇒ conflict/run-host-alive', async () => {
    const store = await makeStore();
    const runId = 'run_step3_a'.padEnd(36, '0') as RunId;
    await seedResumableRunNoLock(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.acquireLock({
      scope: 'run',
      key: runId,
      mode: 'exclusive',
      owner: lockOwner('alive-host', runId),
      ttlMs: 60_000,
    });
    const deps = baseDeps(store, { sweeper: fakeSweeper(new Set(['4242:start-alive-host'])) }); // the lock owner IS alive
    const error = await reject(createResumer(deps).recover(runId, hostContext()));
    expect(error.info.code).toBe('conflict/run-host-alive');
    await store.close();
  });

  test('dead owner ⇒ takeover, fencing token bumped, lock.stolen written', async () => {
    const store = await makeStore();
    const runId = 'run_step3_b'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const deps = baseDeps(store); // default fakeSweeper(): everything reported dead
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.takeover).toBe(true);
    expect(report.fencingToken).toBeGreaterThan(lease.fencingToken);
    const events = await store.readEvents(runId, { afterSequence: 0, limit: 100 });
    expect(events.some((e) => e.type === 'lock.stolen')).toBe(true);
    await store.close();
  });

  test('no existing lock ⇒ fresh acquire, takeover: false', async () => {
    const store = await makeStore();
    const runId = 'run_step3_c'.padEnd(36, '0') as RunId;
    await seedResumableRunNoLock(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const deps = baseDeps(store);
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.takeover).toBe(false);
    await store.close();
  });
});

describe('step 4 — immutability: pin mismatch ⇒ BLOCKED, resumeRequires: reinstall-pinned-version, no adopt flag', () => {
  test('install dir differs from runs.pinned_install_dir', async () => {
    const store = await makeStore();
    const runId = 'run_step4_a'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const deps = baseDeps(store, { installInspector: installInspectorFor('/opt/cohorte/OTHER') });
    const error = await reject(createResumer(deps).recover(runId, hostContext()));
    expect(error.info.code).toBe('security/runtime-pin-mismatch');
    expect(error.info.details?.resumeRequires).toBe('reinstall-pinned-version');
    await store.close();
  });

  test('an unshipped table version', async () => {
    const store = await makeStore();
    const runId = 'run_step4_b'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR, tableVersion: 999 });
    const deps = baseDeps(store);
    const error = await reject(createResumer(deps).recover(runId, hostContext()));
    expect(error.info.code).toBe('security/runtime-pin-mismatch');
    expect(error.info.details?.resumeRequires).toBe('reinstall-pinned-version');
    await store.close();
  });
});

describe('step 5 — orphan sweep: dead agent incarnations are killed and reported', () => {
  test('an incarnation whose (pid, startToken) is dead is swept and reported as an orphan', async () => {
    const store = await makeStore();
    const runId = 'run_step5_a'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('a1'), { runId, state: 'running', incarnation: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('a1'), 1, { runId, pid: 555, startToken: 'tok-555', state: 'running' }),
      );
    });
    const sweeper = fakeSweeper();
    const deps = baseDeps(store, { sweeper });
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.orphans).toContainEqual({
      agentId: agentId2('a1'),
      incarnation: 1,
      pid: 555,
      kind: 'brain',
      killed: true,
    });
    expect(sweeper.killed).toContain('555:tok-555');
    await store.close();
  });

  test('a live incarnation is left alone', async () => {
    const store = await makeStore();
    const runId = 'run_step5_b'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('a2'), { runId, state: 'completed', incarnation: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('a2'), 1, { runId, pid: 777, startToken: 'tok-777', state: 'running' }),
      );
    });
    const sweeper = fakeSweeper(new Set(['777:tok-777'])); // this one IS alive
    const deps = baseDeps(store, { sweeper });
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.orphans).toHaveLength(0);
    await store.close();
  });
});

describe('step 7 — replay-class reconciliation, via a synthetic journal (crash points #6/#12/#13)', () => {
  test('idempotent, re-provisioned by the probe ⇒ done in the store, re-executed in the report', async () => {
    const store = await makeStore();
    const runId = 'run_step7_a'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: 'prov:1',
        kind: 'provision.command',
        replayClass: 'idempotent',
        slot: 'w1',
        request: sealForTest({}),
        verify: sealForTest({ slot: 'w1' }),
      });
    });
    // `ensure()` answered 'fresh': the marker was gone and the probe itself re-provisioned — the "re-execute" of
    // DESIGN 4.1's `idempotent` row, already done. The effect is therefore DONE (a `failed(interrupted)` here would
    // have the next incarnation provision a third time), and the report says `re-executed`.
    const deps = baseDeps(store, { effectVerifiers: builtinVerifiersFor({ ensureOutcome: 'fresh' }) });
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.effects).toHaveLength(1);
    expect(report.effects[0]?.verdict).toBe('re-executed');
    expect(await store.listEffects(runId, { states: ['done'] })).toHaveLength(1);
    expect(await store.listEffects(runId, { states: ['failed'] })).toHaveLength(0);
    await store.close();
  });

  test('idempotent, marker found ⇒ done, and reported done: nothing re-ran', async () => {
    const store = await makeStore();
    const runId = 'run_step7_b'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: 'prov:2',
        kind: 'provision.command',
        replayClass: 'idempotent',
        slot: 'w1',
        request: sealForTest({}),
        verify: sealForTest({ slot: 'w1' }),
      });
    });
    const deps = baseDeps(store, { effectVerifiers: builtinVerifiersFor({ ensureOutcome: 'reused' }) });
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.effects[0]?.verdict).toBe('done');
    const stored = await store.listEffects(runId, { states: ['done'] });
    expect(stored).toHaveLength(1);
    await store.close();
  });

  test('at-most-once ⇒ NEVER re-executed, surfaces in ResumeReport.inDoubt', async () => {
    const store = await makeStore();
    const runId = 'run_step7_c'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    let effectId!: EffectId;
    await store.transact({ runId }, lease, (tx) => {
      const begun = tx.beginEffect({
        runId,
        idempotencyKey: 'tool:at-most-once:1',
        kind: 'tool.run_command',
        replayClass: 'at-most-once',
        request: sealForTest({}),
        verify: sealForTest({}),
      });
      if (begun.status === 'started') effectId = begun.effectId;
    });
    const deps = baseDeps(store);
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.inDoubt).toContain(effectId);
    expect(report.effects.find((e) => e.effectId === effectId)?.verdict).toBe('in-doubt');
    const stored = await store.listEffects(runId, { states: ['in-doubt'] });
    expect(stored).toHaveLength(1);
    await store.close();
  });

  test('verifiable, found in the world ⇒ done (crash point #15: commit.after-git-commit)', async () => {
    const store = await makeStore();
    const runId = 'run_step7_d'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: 'commit:1',
        kind: 'git.commit',
        replayClass: 'verifiable',
        request: sealForTest({}),
        verify: sealForTest({ repo: '/repo', branch: 'agent/x', key: 'commit:1' }),
      });
    });
    const deps = baseDeps(store, {
      effectVerifiers: builtinVerifiersFor({ commits: { 'agent/x:commit:1': 'a'.repeat(40) } }),
    });
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.effects[0]?.verdict).toBe('done');
    await store.close();
  });

  test('unregistered kind (owned by a different unit) ⇒ in-doubt, never a blind re-execution', async () => {
    const store = await makeStore();
    const runId = 'run_step7_e'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: 'w:1',
        kind: 'tool.write_file',
        replayClass: 'verifiable',
        request: sealForTest({}),
        verify: sealForTest({}),
      });
    });
    const deps = baseDeps(store);
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.effects[0]?.verdict).toBe('in-doubt');
    await store.close();
  });
});

describe('step 8 — worktree ledger audit', () => {
  test('ledger-explained is kept, no BLOCK', async () => {
    const store = await makeStore();
    const runId = 'run_step8_a'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => tx.putWorktree(worktreeRecord('w1', { runId })));
    const deps = baseDeps(store, { worktrees: fakeWorktreeService({ w1: 'ledger-explained' }) });
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.worktrees).toContainEqual({ slot: 'w1', path: expect.any(String), verdict: 'ledger-explained' });
    await store.close();
  });

  test('unexplained change WITH an in-doubt COMMAND effect ⇒ quarantine + reset (crash point #21)', async () => {
    const store = await makeStore();
    const runId = 'run_step8_b'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putWorktree(worktreeRecord('w2', { runId }));
      tx.beginEffect({
        runId,
        idempotencyKey: 'w:doubt',
        // DESIGN 4.4 step 8's second bullet is about a COMMAND effect: `tool.run_command`, the one agent-command
        // kind of DESIGN 4.1. A `tool.write_file` here would pin the too-broad reading (see the next test).
        kind: 'tool.run_command',
        replayClass: 'at-most-once',
        slot: 'w2',
        request: sealForTest({}),
        verify: sealForTest({}),
      });
    });
    const worktrees = fakeWorktreeService({ w2: 'unexplained-change' });
    const deps = baseDeps(store, { worktrees });
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.worktrees.find((w) => w.slot === 'w2')?.verdict).toBe('quarantined-reset');
    expect(worktrees.quarantined).toHaveLength(1);
    await store.close();
  });

  test('unexplained change whose only open effect is NOT a command ⇒ BLOCKED, never an automatic reset', async () => {
    // DESIGN 4.4 step 8 / ADR-0025 item 2: quarantine+reset is reserved for "a COMMAND effect that is `in-doubt` or
    // `failed(interrupted)`". An interrupted `git.commit` (or `git.worktree.add`, `agent.spawn`, ...) explains
    // nothing about the bytes in the tree, so the unexplained change stays the security signal it is — resetting
    // here would throw away the agent's uncommitted work to hide a change nothing accounts for.
    const store = await makeStore();
    const runId = 'run_step8_e'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putWorktree(worktreeRecord('w5', { runId }));
      tx.beginEffect({
        runId,
        idempotencyKey: 'commit:w5:1',
        kind: 'git.commit',
        replayClass: 'verifiable',
        slot: 'w5',
        request: sealForTest({}),
        // no commit carries this trailer in the fake repo ⇒ the verifier says `not-done`, i.e. an open, non-done
        // effect of this slot — the exact shape the too-broad predicate accepted as "explaining".
        verify: sealForTest({ repo: '/repo', branch: 'agent/w5', key: 'commit:w5:1' }),
      });
    });
    const worktrees = fakeWorktreeService({ w5: 'unexplained-change' });
    const error = await reject(createResumer(baseDeps(store, { worktrees })).recover(runId, hostContext()));
    expect(error.info.code).toBe('security/write-outside-ownership');
    expect(worktrees.quarantined).toEqual([]);
    const events = await store.readEvents(runId, { afterSequence: 0, limit: 200, types: ['repo.change.detected'] });
    expect(events).toHaveLength(1);
    await store.close();
  });

  test('unexplained change with NO explaining effect ⇒ BLOCKED (unexpected-repo-change)', async () => {
    const store = await makeStore();
    const runId = 'run_step8_c'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => tx.putWorktree(worktreeRecord('w3', { runId })));
    const deps = baseDeps(store, { worktrees: fakeWorktreeService({ w3: 'unexplained-change' }) });
    const error = await reject(createResumer(deps).recover(runId, hostContext()));
    expect(error.info.code).toBe('security/write-outside-ownership');
    const events = await store.readEvents(runId, { afterSequence: 0, limit: 100 });
    expect(events.some((e) => e.type === 'repo.change.detected')).toBe(true);
    await store.close();
  });
});

describe('step 9 — approvals expiry (crash point #11: an approval survives with no host)', () => {
  test('a due approval is expired and no longer carried', async () => {
    const store = await makeStore();
    const runId = 'run_step9_a'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putApproval(
        approvalRecord({
          approvalId: approvalId2('due'),
          runId,
          status: 'pending',
          expiresAt: at('2026-01-15T00:00:00.000Z'),
        }),
      );
    });
    const deps = baseDeps(store); // FixedClock starts 2026-02-01: past the expiry
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.approvalsCarried).not.toContain(approvalId2('due'));
    const events = await store.readEvents(runId, { afterSequence: 0, limit: 200 });
    expect(events.some((e) => e.type === 'approval.resolved')).toBe(true);
    await store.close();
  });

  test('an approval not yet due survives and IS carried (it needs no host, ADR-0025)', async () => {
    const store = await makeStore();
    const runId = 'run_step9_b'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putApproval(
        approvalRecord({
          approvalId: approvalId2('ok'),
          runId,
          status: 'pending',
          expiresAt: at('2026-06-01T00:00:00.000Z'),
        }),
      );
    });
    const deps = baseDeps(store);
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.approvalsCarried).toContain(approvalId2('ok'));
    await store.close();
  });
});

describe('step 10 — reincarnation, approved-call replay, maxIncarnations not maxAttempts', () => {
  test('an agent whose incarnation died is reincarnated: incarnation+1, attempt unchanged', async () => {
    const store = await makeStore();
    const runId = 'run_step10_a'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('r1'), { runId, state: 'running', incarnation: 2, attempt: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('r1'), 2, { runId, pid: 800, startToken: 'tok-800', state: 'running' }),
      );
    });
    const deps = baseDeps(store, { sweeper: fakeSweeper() });
    await createResumer(deps).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('r1'));
    expect(agent?.state).toBe('spawning');
    expect(agent?.incarnation).toBe(3);
    expect(agent?.attempt).toBe(1);
    const events = await store.readEvents(runId, { afterSequence: 0, limit: 200 });
    const changed = events.find((e) => e.type === 'agent.state.changed');
    expect(changed).toBeDefined();
    await store.close();
  });

  test('exhausting maxIncarnations fails THAT agent with budget/incarnations, not the whole recovery', async () => {
    const store = await makeStore();
    const runId = 'run_step10_b'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(
        agentRecord(agentId2('r2'), { runId, state: 'running', incarnation: 5, maxIncarnations: 5, attempt: 1 }),
      );
      tx.putIncarnation(
        incarnationRecord(agentId2('r2'), 5, { runId, pid: 900, startToken: 'tok-900', state: 'running' }),
      );
    });
    const deps = baseDeps(store, { sweeper: fakeSweeper() });
    const report = await createResumer(deps).recover(runId, hostContext()); // does NOT throw
    expect(report.hostId).toBe('host-1');
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('r2'));
    expect(agent?.state).toBe('failed');
    expect(agent?.lastError?.code).toBe('budget/incarnations');
    await store.close();
  });

  test('approvedReplays is filled from a fake ToolHostReplay for an unconsumed approved call', async () => {
    const store = await makeStore();
    const runId = 'run_step10_c'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('r3'), { runId, state: 'running', incarnation: 1, attempt: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('r3'), 1, { runId, pid: 1000, startToken: 'tok-1000', state: 'running' }),
      );
      tx.putApproval(
        approvalRecord({
          approvalId: approvalId2('replay'),
          runId,
          agentId: agentId2('r3'),
          incarnation: 1,
          toolCallId: toolCallId2(1, 2),
          status: 'allow-once',
          request: sealForTest({ tool: 'run_command', args: { argv: ['echo', 'hi'] } }),
        }),
      );
    });
    const toolHostReplay = fakeToolHostReplay('executed');
    const deps = baseDeps(store, { sweeper: fakeSweeper(), toolHostReplay });
    const report = await createResumer(deps).recover(runId, hostContext());
    expect(report.approvedReplays).toContainEqual({
      approvalId: approvalId2('replay'),
      toolCallId: toolCallId2(1, 2),
      outcome: 'executed',
    });
    expect(toolHostReplay.calls).toHaveLength(1);
    await store.close();
  });

  test('a completed agent is never re-executed by resume', async () => {
    const store = await makeStore();
    const runId = 'run_step10_d'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('done'), { runId, state: 'completed', incarnation: 1, attempt: 1 }));
    });
    const deps = baseDeps(store);
    await createResumer(deps).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('done'));
    expect(agent?.state).toBe('completed');
    expect(agent?.incarnation).toBe(1);
    await store.close();
  });
});

describe('step 11 — run.resumed committed; recovery never silently un-suspends', () => {
  test('run.resumed{mode: recovery, report} is written', async () => {
    const store = await makeStore();
    const runId = 'run_step11_a'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const deps = baseDeps(store);
    const report = await createResumer(deps).recover(runId, hostContext());
    const events = await store.readEvents(runId, { afterSequence: 0, limit: 200, types: ['run.resumed'] });
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { mode: string; report: unknown } | undefined;
    expect(payload?.mode).toBe('recovery');
    expect(payload?.report).toEqual(report);
    await store.close();
  });

  test('a WAITING_APPROVAL run stays WAITING_APPROVAL after recovery (never silently un-suspends)', async () => {
    const store = await makeStore();
    const runId = 'run_step11_b'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR, state: 'WAITING_APPROVAL' });
    const deps = baseDeps(store);
    await createResumer(deps).recover(runId, hostContext());
    const run = await store.getRun(runId);
    expect(run?.state).toBe('WAITING_APPROVAL');
    await store.close();
  });

  /** Seeds a SUSPENDED run holding one parked agent and one approved-but-unconsumed call: the shape a human
   * `pause` (T20, `park-agents`) leaves behind, and the one on which "recovery never silently un-suspends" is
   * decided — un-suspending here would both reincarnate the brain and EXECUTE the approved command (4.5). */
  async function seedSuspendedRunWithParkedAgent(
    store: StateStore,
    runId: RunId,
    state: 'PAUSED' | 'AUTH_REQUIRED' | 'QUOTA_EXCEEDED' | 'WAITING_APPROVAL' | 'BLOCKED',
    approvalStatus: 'pending' | 'allow-once' = 'allow-once',
  ): Promise<void> {
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR, state });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('parked'), { runId, state: 'paused', incarnation: 1, attempt: 1 }));
      tx.putApproval(
        approvalRecord({
          approvalId: approvalId2(`parked-${state}`),
          runId,
          agentId: agentId2('parked'),
          incarnation: 1,
          toolCallId: toolCallId2(1, 1),
          status: approvalStatus,
          request: sealForTest({ tool: 'run_command', args: { argv: ['rm', '-rf', 'build'] } }),
        }),
      );
    });
  }

  test('a PAUSED run: the parked agent stays paused and its approved call is NOT replayed', async () => {
    const store = await makeStore();
    const runId = 'run_step11_f'.padEnd(36, '0') as RunId;
    await seedSuspendedRunWithParkedAgent(store, runId, 'PAUSED');
    const toolHostReplay = fakeToolHostReplay('executed');
    const report = await createResumer(baseDeps(store, { toolHostReplay })).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('parked'));
    expect(agent?.state).toBe('paused');
    expect(agent?.incarnation).toBe(1);
    expect(toolHostReplay.calls).toEqual([]);
    expect(report.approvedReplays).toEqual([]);
    expect((await store.getRun(runId))?.state).toBe('PAUSED');
    // the report says WHY the work was not continued (DESIGN 4.4 step 11).
    const resumed = await store.readEvents(runId, { afterSequence: 0, limit: 200, types: ['run.resumed'] });
    expect(resumed.at(0)?.summary).toContain('PAUSED');
    expect(resumed.at(0)?.summary).toContain('not continued');
    await store.close();
  });

  test('two successive recoveries of the same PAUSED run leave the agent at incarnation 1', async () => {
    // Without the run-state gate each recovery burned an incarnation (paused -> spawning, inc+1) until the agent
    // died of `budget/incarnations` — on a run a human had merely paused.
    const store = await makeStore();
    const runId = 'run_step11_g'.padEnd(36, '0') as RunId;
    await seedSuspendedRunWithParkedAgent(store, runId, 'PAUSED');
    await createResumer(baseDeps(store)).recover(runId, hostContext());
    // a second host: its own id source, or it would mint event ids the first recovery already used.
    await createResumer(baseDeps(store, {}, 9000)).recover(runId, hostContext({ hostId: 'host-2' }));
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('parked'));
    expect(agent?.state).toBe('paused');
    expect(agent?.incarnation).toBe(1);
    expect(agent?.lastError).toBeUndefined();
    await store.close();
  });

  test.for([
    ['AUTH_REQUIRED', 'run_sus_auth'],
    ['QUOTA_EXCEEDED', 'run_sus_quota'],
    ['BLOCKED', 'run_sus_blocked'],
  ] as const)('a %s run is reconciled but never continued', async ([state, id]) => {
    const store = await makeStore();
    const runId = id.padEnd(36, '0') as RunId;
    await seedSuspendedRunWithParkedAgent(store, runId, state);
    const toolHostReplay = fakeToolHostReplay('executed');
    await createResumer(baseDeps(store, { toolHostReplay })).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    expect(tree.agents.find((a) => a.agentId === agentId2('parked'))?.state).toBe('paused');
    expect(toolHostReplay.calls).toEqual([]);
    await store.close();
  });

  test('a WAITING_APPROVAL run whose ask is still pending does not continue either', async () => {
    const store = await makeStore();
    const runId = 'run_step11_h'.padEnd(36, '0') as RunId;
    await seedSuspendedRunWithParkedAgent(store, runId, 'WAITING_APPROVAL', 'pending');
    const toolHostReplay = fakeToolHostReplay('executed');
    const report = await createResumer(baseDeps(store, { toolHostReplay })).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    expect(tree.agents.find((a) => a.agentId === agentId2('parked'))?.state).toBe('paused');
    expect(toolHostReplay.calls).toEqual([]);
    expect(report.approvalsCarried).toContain(approvalId2('parked-WAITING_APPROVAL'));
    await store.close();
  });

  test('a WAITING_APPROVAL run whose ask was ANSWERED continues: the 4.5 parked replay happens', async () => {
    // DESIGN 2.5.3 resumes WAITING_APPROVAL "by `approve` / `deny`", and ADR-0025 item 6's host-side replay exists
    // exactly for an ask answered while no host was alive: once nothing blocking is pending, the work goes on.
    const store = await makeStore();
    const runId = 'run_step11_i'.padEnd(36, '0') as RunId;
    await seedSuspendedRunWithParkedAgent(store, runId, 'WAITING_APPROVAL', 'allow-once');
    const toolHostReplay = fakeToolHostReplay('executed');
    const report = await createResumer(baseDeps(store, { toolHostReplay })).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('parked'));
    expect(agent?.state).toBe('spawning');
    expect(agent?.incarnation).toBe(2);
    expect(agent?.attempt).toBe(1); // a reincarnation, never a retry
    expect(report.approvedReplays).toHaveLength(1);
    expect(toolHostReplay.calls).toHaveLength(1);
    await store.close();
  });
});

describe('step 5 — the report states a FACT about the sweep', () => {
  test('a kill that the sweeper refuses is reported killed: false, never true', async () => {
    const store = await makeStore();
    const runId = 'run_step5_c'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('a3'), { runId, state: 'running', incarnation: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('a3'), 1, { runId, pid: 606, startToken: 'tok-606', state: 'running' }),
      );
    });
    const sweeper = fakeSweeper(new Set(), { killRejects: true });
    const report = await createResumer(baseDeps(store, { sweeper })).recover(runId, hostContext());
    expect(sweeper.killed).toContain('606:tok-606');
    expect(report.orphans.find((o) => o.pid === 606)?.killed).toBe(false);
    await store.close();
  });

  test('a dead incarnation parked in `waiting` is swept too: only completed/cancelled/failed are terminal', async () => {
    const store = await makeStore();
    const runId = 'run_step5_d'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('a4'), { runId, state: 'waiting', incarnation: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('a4'), 1, { runId, pid: 1234, startToken: 'tok-1234', state: 'waiting' }),
      );
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.orphans.map((o) => o.pid)).toContain(1234);
    await store.close();
  });

  test('an incarnation already recorded `completed` is not swept', async () => {
    const store = await makeStore();
    const runId = 'run_step5_e'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('a5'), { runId, state: 'completed', incarnation: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('a5'), 1, { runId, pid: 1313, startToken: 'tok-1313', state: 'completed' }),
      );
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.orphans).toHaveLength(0);
    await store.close();
  });
});

describe('step 6 — a zone held by another run is not passed over in silence', () => {
  test('an unrebuilt zone lock ⇒ conflict recorded, blocked-ack approval opened, nothing reincarnated', async () => {
    const store = await makeStore();
    const runId = 'run_step6_a'.padEnd(36, '0') as RunId;
    const otherRunId = 'run_step6_other'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const held = await store.acquireLock({
      scope: 'zone',
      key: 'src/app',
      mode: 'exclusive',
      owner: lockOwner('other-host', otherRunId),
      ttlMs: 60_000,
      zones: ['src/app'],
    });
    expect(held.ok).toBe(true);
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('z1'), { runId, state: 'running', incarnation: 1 }));
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.locks.conflicts).toContain('zone:src/app');
    expect(report.approvalsCarried).toHaveLength(1);
    const pendingApprovals = await store.listPendingApprovals(runId);
    expect(pendingApprovals.map((a) => a.kind)).toEqual(['blocked-ack']);
    const tree = await store.readRunTree(runId);
    expect(tree.agents.find((a) => a.agentId === agentId2('z1'))?.state).toBe('running');
    await store.close();
  });
});

describe('step 8 — a quarantined slot reports its effects as compensated (ADR-0025 item 2)', () => {
  test('crash point #21: after quarantineAndReset the slot`s effects carry verdict `compensated`', async () => {
    const store = await makeStore();
    const runId = 'run_step8_d'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    let effectId!: EffectId;
    await store.transact({ runId }, lease, (tx) => {
      tx.putWorktree(worktreeRecord('w4', { runId }));
      const begun = tx.beginEffect({
        runId,
        idempotencyKey: 'w4:doubt',
        kind: 'tool.run_command',
        replayClass: 'at-most-once',
        slot: 'w4',
        request: sealForTest({}),
        verify: sealForTest({}),
      });
      if (begun.status === 'started') effectId = begun.effectId;
    });
    const worktrees = fakeWorktreeService({ w4: 'unexplained-change' });
    const report = await createResumer(baseDeps(store, { worktrees })).recover(runId, hostContext());
    expect(report.worktrees.find((w) => w.slot === 'w4')?.verdict).toBe('quarantined-reset');
    expect(report.effects.find((e) => e.effectId === effectId)?.verdict).toBe('compensated');
    await store.close();
  });
});

describe('step 9 — the inbox: what recovery claims and what a pending cancel does', () => {
  test('a pending cancel stops recovery from reincarnating anything (crash point #19)', async () => {
    const store = await makeStore();
    const runId = 'run_step9_c'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('c1'), { runId, state: 'running', incarnation: 1, attempt: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('c1'), 1, { runId, pid: 1500, startToken: 'tok-1500', state: 'running' }),
      );
    });
    await store.enqueueCommand(commandEnvelope(runId, 'cancel', { keepWorktrees: false }));
    const toolHostReplay = fakeToolHostReplay();
    const report = await createResumer(baseDeps(store, { toolHostReplay })).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('c1'));
    expect(agent?.state).toBe('running');
    expect(agent?.incarnation).toBe(1);
    expect(toolHostReplay.calls).toHaveLength(0);
    // the stray brain is still swept: the cancellation only stops the run from CONTINUING.
    expect(report.orphans.map((o) => o.pid)).toContain(1500);
    await store.close();
  });

  test('commandsApplied never names a command this procedure did not apply (D6)', async () => {
    const store = await makeStore();
    const runId = 'run_step9_d'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.enqueueCommand(commandEnvelope(runId, 'pause', { reason: 'human' }));
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.commandsApplied).toEqual([]);
    expect(await store.pendingCommands(runId)).toHaveLength(1); // still there, for the engine
    await store.close();
  });
});

describe('step 10 — a `waiting` agent whose host died (crash point #11 / ADR-0025 item 6)', () => {
  test('its approved-but-unconsumed call is replayed and it reincarnates: incarnation+1, attempt unchanged', async () => {
    const store = await makeStore();
    const runId = 'run_step10_e'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('w1'), { runId, state: 'waiting', incarnation: 1, attempt: 2 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('w1'), 1, { runId, pid: 1234, startToken: 'tok-1234', state: 'waiting' }),
      );
      tx.putApproval(
        approvalRecord({
          approvalId: approvalId2('parked'),
          runId,
          agentId: agentId2('w1'),
          incarnation: 1,
          toolCallId: toolCallId2(1, 4),
          status: 'allow-once',
          request: sealForTest({ tool: 'run_command', args: { argv: ['pnpm', 'test'] } }),
        }),
      );
    });
    const toolHostReplay = fakeToolHostReplay('executed');
    const report = await createResumer(baseDeps(store, { toolHostReplay })).recover(runId, hostContext());
    expect(report.orphans.map((o) => o.pid)).toContain(1234);
    expect(report.approvedReplays).toContainEqual({
      approvalId: approvalId2('parked'),
      toolCallId: toolCallId2(1, 4),
      outcome: 'executed',
    });
    expect(toolHostReplay.calls).toHaveLength(1);
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('w1'));
    expect(agent?.state).toBe('spawning');
    expect(agent?.incarnation).toBe(2);
    expect(agent?.attempt).toBe(2); // a host restart counts against maxIncarnations, never maxAttempts
    await store.close();
  });

  test('a `paused` agent with no incarnation row at all still continues (no child of this run survived)', async () => {
    const store = await makeStore();
    const runId = 'run_step10_f'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('p1'), { runId, state: 'paused', incarnation: 1, attempt: 1 }));
    });
    await createResumer(baseDeps(store)).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    expect(tree.agents.find((a) => a.agentId === agentId2('p1'))?.state).toBe('spawning');
    await store.close();
  });
});

describe('step 11 — an in-doubt effect opens a blocked-ack approval before the agent continues', () => {
  test('inDoubt non-empty ⇒ a pending blocked-ack approval, carried in the report', async () => {
    const store = await makeStore();
    const runId = 'run_step11_c'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('d1'), { runId, state: 'running', incarnation: 1 }));
      tx.beginEffect({
        runId,
        agentId: agentId2('d1'),
        idempotencyKey: 'tool:amo:1',
        kind: 'tool.run_command',
        replayClass: 'at-most-once',
        request: sealForTest({}),
        verify: sealForTest({}),
      });
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.inDoubt).toHaveLength(1);
    expect(report.approvalsCarried).toHaveLength(1);
    const opened = await store.listPendingApprovals(runId);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.kind).toBe('blocked-ack');
    expect(opened[0]?.approvalId).toBe(report.approvalsCarried[0]);
    const events = await store.readEvents(runId, { afterSequence: 0, limit: 300, types: ['approval.requested'] });
    expect(events).toHaveLength(1);
    // the approval a human reads carries the reconciliation note of step 10, not a bare effect id
    const preview = previewTextOf(events.at(0)?.payload);
    expect(preview).toContain('recovery note');
    expect(preview).toContain('Do not assume it ran');
    await store.close();
  });

  test('the note names every situation steps 7-8 produced, in DESIGN 4.4 step 10`s order', async () => {
    const store = await makeStore();
    const runId = 'run_step11_e'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('n1'), { runId, state: 'running', incarnation: 1, slot: 'w7' }));
      tx.beginEffect({
        runId,
        agentId: agentId2('n1'),
        toolCallId: toolCallId2(1, 1),
        idempotencyKey: 'wt:n1',
        kind: 'git.worktree.add',
        replayClass: 'verifiable',
        request: sealForTest({}),
        verify: sealForTest({ repo: '/repo', path: '/repo/.cohorte/w7', branch: 'agent/w7' }),
      });
      tx.beginEffect({
        runId,
        agentId: agentId2('n1'),
        toolCallId: toolCallId2(1, 2),
        idempotencyKey: 'tool:n1:amo',
        kind: 'tool.run_command',
        replayClass: 'at-most-once',
        request: sealForTest({}),
        verify: sealForTest({}),
      });
      tx.putApproval(
        approvalRecord({
          approvalId: approvalId2('n1-parked'),
          runId,
          agentId: agentId2('n1'),
          incarnation: 1,
          toolCallId: toolCallId2(1, 3),
          status: 'allow-once',
          request: sealForTest({ tool: 'write_file', args: { path: 'a.txt' } }),
        }),
      );
    });
    const toolHostReplay = fakeToolHostReplay('binding-changed');
    await createResumer(baseDeps(store, { toolHostReplay })).recover(runId, hostContext());
    const events = await store.readEvents(runId, { afterSequence: 0, limit: 300, types: ['approval.requested'] });
    const note = previewTextOf(events.at(0)?.payload);
    expect(note.indexOf('was requested but never ran')).toBeGreaterThan(-1); // git.worktree.add, not verified
    expect(note.indexOf('outcome is unknown')).toBeGreaterThan(note.indexOf('was requested but never ran'));
    expect(note.indexOf('was approved but NOT executed')).toBeGreaterThan(note.indexOf('outcome is unknown'));
    expect(note).not.toMatch(/please re-issue/i);
    await store.close();
  });

  test('a second recovery reuses that approval instead of opening a duplicate', async () => {
    const store = await makeStore();
    const runId = 'run_step11_d'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: 'tool:amo:2',
        kind: 'tool.run_command',
        replayClass: 'at-most-once',
        request: sealForTest({}),
        verify: sealForTest({}),
      });
    });
    const first = await createResumer(baseDeps(store)).recover(runId, hostContext());
    // a second host: its own id source, or it would mint event ids the first recovery already used.
    const second = await createResumer(baseDeps(store, {}, 9000)).recover(runId, hostContext({ hostId: 'host-2' }));
    expect(second.approvalsCarried).toEqual(first.approvalsCarried);
    expect(await store.listPendingApprovals(runId)).toHaveLength(1);
    await store.close();
  });
});

/**
 * DESIGN 4.3's table, row by row, against `recover()` alone. Every row whose "On disk" column is reachable through
 * `StateStore` is seeded here and its "Resume does" column asserted. Four rows are NOT reachable from this port set
 * and are named in `docs/v3/requests/U1.10.md` as the crash-harness unit's (U5.01): #2's liveness of a real
 * `(pid, startToken)` (covered here through `ProcessSweeper`, not a real process), #18's snapshot-vs-events
 * optimisation beyond what `readEvents` replays, #20's `locks.after-release` against a real filesystem, and #22
 * (SQLite mid-transaction), which is a property of the SQLite store's WAL, not of this procedure.
 */
describe('DESIGN 4.3 — the crash-point matrix', () => {
  test('#1 start.after-run-row: an IDLE run with its start command still pending is not touched and no second run appears', async () => {
    const store = await makeStore();
    const runId = 'run_cp01'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR, state: 'IDLE' });
    await store.enqueueCommand(
      commandEnvelope(runId, 'start', { profile: 'feature', unattended: false }, 'start-cp01'),
    );
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.commandsApplied).toEqual([]);
    expect((await store.getRun(runId))?.state).toBe('IDLE');
    expect(await store.pendingCommands(runId)).toHaveLength(1);
    await store.close();
  });

  test('#3 snapshot.mid-materialize: the intent digest is compared with the RUN`s own snapshot digest', async () => {
    const store = await makeStore();
    const runId = 'run_cp03'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const digest = (await store.getRun(runId))?.snapshotDigest;
    expect(digest).toBeDefined();
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: `snap:${runId}`,
        kind: 'fs.snapshot.materialize',
        replayClass: 'idempotent',
        request: sealForTest({}),
        verify: sealForTest({ manifestDigest: digest as string }),
      });
    });
    const matching = await createResumer(
      baseDeps(store, { effectVerifiers: builtinVerifiersFor({ runSnapshotDigest: digest }) }),
    ).recover(runId, hostContext());
    expect(matching.effects[0]?.verdict).toBe('done');
    await store.close();
  });

  test('#3 (mismatch) a digest that is not the run`s own is in-doubt, never a guessed `done`', async () => {
    const store = await makeStore();
    const runId = 'run_cp03b'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: `snap:${runId}`,
        kind: 'fs.snapshot.materialize',
        replayClass: 'idempotent',
        request: sealForTest({}),
        verify: sealForTest({ manifestDigest: 'c'.repeat(64) }),
      });
    });
    const report = await createResumer(
      baseDeps(store, { effectVerifiers: builtinVerifiersFor({ runSnapshotDigest: sha256Of('d'.repeat(64)) }) }),
    ).recover(runId, hostContext());
    expect(report.effects[0]?.verdict).toBe('in-doubt');
    await store.close();
  });

  test('#4 transition.before-commit: nothing new on disk ⇒ recovery changes nothing', async () => {
    const store = await makeStore();
    const runId = 'run_cp04'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const before = await store.getRun(runId);
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.effects).toEqual([]);
    expect(report.worktrees).toEqual([]);
    expect((await store.getRun(runId))?.state).toBe(before?.state);
    await store.close();
  });

  test('#5 transition.after-commit: a phase row at step `plan` is left exactly where the executor must re-enter', async () => {
    const store = await makeStore();
    const runId = 'run_cp05'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const phaseRunId = phaseRunId2('BUILD', 1);
    await store.transact({ runId }, lease, (tx) => {
      tx.putPhase(phaseRecord({ phaseRunId, runId, state: 'BUILD', status: 'running' }));
    });
    await createResumer(baseDeps(store)).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    expect(tree.phases).toHaveLength(1);
    expect(tree.phases[0]?.status).toBe('running');
    expect(tree.phases[0]?.state).toBe('BUILD');
    await store.close();
  });

  test('#7 plan.after-commit: a `declared` agent has no runtime session yet and is not reincarnated', async () => {
    const store = await makeStore();
    const runId = 'run_cp07'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('dec'), { runId, state: 'declared', incarnation: 1 }));
    });
    await createResumer(baseDeps(store)).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('dec'));
    expect(agent?.state).toBe('declared');
    expect(agent?.incarnation).toBe(1);
    await store.close();
  });

  test('#8 provision.after-worktree-add: an exact porcelain match ⇒ done, no second `worktree add`', async () => {
    const store = await makeStore();
    const runId = 'run_cp08'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: `wt:${runId}:w1`,
        kind: 'git.worktree.add',
        replayClass: 'verifiable',
        slot: 'w1',
        request: sealForTest({}),
        verify: sealForTest({ repo: '/repo', path: '/repo/.cohorte/w1', branch: 'agent/w1' }),
      });
    });
    const effectVerifiers = builtinVerifiersFor({
      worktrees: [
        { path: canonicalPath('/repo/.cohorte/w1'), branch: 'agent/w1', head: 'a'.repeat(40), locked: false },
      ],
    });
    const report = await createResumer(baseDeps(store, { effectVerifiers })).recover(runId, hostContext());
    expect(report.effects[0]?.verdict).toBe('done');
    await store.close();
  });

  test('#8 (dir without registration) ⇒ failed(interrupted): the next incarnation redoes it under the same key', async () => {
    const store = await makeStore();
    const runId = 'run_cp08b'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: `wt:${runId}:w9`,
        kind: 'git.worktree.add',
        replayClass: 'verifiable',
        request: sealForTest({}),
        verify: sealForTest({ repo: '/repo', path: '/repo/.cohorte/w9', branch: 'agent/w9' }),
      });
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.effects[0]?.verdict).toBe('failed');
    expect(await store.listEffects(runId, { states: ['failed'] })).toHaveLength(1);
    await store.close();
  });

  test('#9 spawn.after-intent: the child is dead ⇒ the effect fails and a NEW incarnation of the same attempt is planned', async () => {
    const store = await makeStore();
    const runId = 'run_cp09'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('sp'), { runId, state: 'spawning', incarnation: 1, attempt: 2 }));
      tx.beginEffect({
        runId,
        agentId: agentId2('sp'),
        idempotencyKey: `${runId}:${agentId2('sp')}:1`,
        kind: 'agent.spawn',
        replayClass: 'verifiable',
        request: sealForTest({}),
        verify: sealForTest({ pid: 2222, startToken: 'tok-2222', nonce: 'n-2222' }),
      });
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.effects[0]?.verdict).toBe('failed');
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('sp'));
    expect(agent?.state).toBe('spawning');
    expect(agent?.incarnation).toBe(2);
    expect(agent?.attempt).toBe(2);
    await store.close();
  });

  test('#10 tool.after-requested: a request with no effect row means nothing ran and nothing is reconciled', async () => {
    const store = await makeStore();
    const runId = 'run_cp10'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('tr'), { runId, state: 'running', incarnation: 1 }));
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.effects).toEqual([]);
    expect(report.inDoubt).toEqual([]);
    await store.close();
  });

  test('#14 agent.after-exit-before-collect: a `completed` agent with a dead incarnation is swept but never re-spawned', async () => {
    const store = await makeStore();
    const runId = 'run_cp14'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putAgent(agentRecord(agentId2('ex'), { runId, state: 'completed', incarnation: 1 }));
      tx.putIncarnation(
        incarnationRecord(agentId2('ex'), 1, { runId, pid: 1414, startToken: 'tok-1414', state: 'running' }),
      );
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.orphans.map((o) => o.pid)).toContain(1414);
    const tree = await store.readRunTree(runId);
    const agent = tree.agents.find((a) => a.agentId === agentId2('ex'));
    expect(agent?.state).toBe('completed');
    expect(agent?.incarnation).toBe(1);
    await store.close();
  });

  test('#16 merge.after-update-ref: the head carries the trailer ⇒ done, the merge is not redone', async () => {
    const store = await makeStore();
    const runId = 'run_cp16'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.beginEffect({
        runId,
        idempotencyKey: 'merge:1',
        kind: 'git.merge',
        replayClass: 'verifiable',
        request: sealForTest({}),
        verify: sealForTest({ repo: '/repo', into: 'main', key: 'merge:1', expectedOldHead: 'a'.repeat(40) }),
      });
    });
    const effectVerifiers = builtinVerifiersFor({ commits: { 'main:merge:1': 'b'.repeat(40) } });
    const report = await createResumer(baseDeps(store, { effectVerifiers })).recover(runId, hostContext());
    expect(report.effects[0]?.verdict).toBe('done');
    await store.close();
  });

  test('#17 phase.before-completed-commit: a `running` phase keeps its row; recovery re-runs nothing itself', async () => {
    const store = await makeStore();
    const runId = 'run_cp17'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const phaseRunId = phaseRunId2('TEST', 2);
    await store.transact({ runId }, lease, (tx) => {
      tx.putPhase(phaseRecord({ phaseRunId, runId, state: 'TEST', iteration: 2, status: 'running' }));
    });
    await createResumer(baseDeps(store)).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    expect(tree.phases[0]).toMatchObject({ phaseRunId, status: 'running', iteration: 2 });
    await store.close();
  });

  test('#18 checkpoint.after-events-before-snapshot: events past the last snapshot replay through evolve', async () => {
    const store = await makeStore();
    const runId = 'run_cp18'.padEnd(36, '0') as RunId;
    await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    // No snapshot was ever stored for this run: step 2 must fold the whole stream and agree with the projection.
    expect(await store.loadSnapshot(runId)).toBeUndefined();
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.hostId).toBe('host-1');
    await store.close();
  });

  test('#20 ship.after-approval: a resolved approval is not carried, and the locks are rebuilt from nothing', async () => {
    const store = await makeStore();
    const runId = 'run_cp20'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    await store.transact({ runId }, lease, (tx) => {
      tx.putApproval(approvalRecord({ approvalId: approvalId2('shipped'), runId, kind: 'ship', status: 'pending' }));
      tx.resolveApproval(approvalId2('shipped'), {
        actor: { kind: 'human', id: 'tester', transport: 'cli' },
        answer: 'allow-once',
        decidedAt: at('2026-01-20T00:00:00.000Z'),
        resolvedSeq: 2,
      });
    });
    const report = await createResumer(baseDeps(store)).recover(runId, hostContext());
    expect(report.approvalsCarried).toEqual([]);
    expect(report.locks.rebuilt).toEqual(
      expect.arrayContaining([`run:${runId}`, 'project', 'zone:src/app', `integration:${runId}`]),
    );
    expect(report.locks.conflicts).toEqual([]);
    await store.close();
  });

  test('completed phases are never re-executed (the plan`s last bullet)', async () => {
    const store = await makeStore();
    const runId = 'run_cp_done'.padEnd(36, '0') as RunId;
    const { lease } = await seedResumableRun(store, runId, { pinnedInstallDir: INSTALL_DIR });
    const phaseRunId = phaseRunId2('BUILD', 1);
    await store.transact({ runId }, lease, (tx) => {
      tx.putPhase(
        phaseRecord({
          phaseRunId,
          runId,
          state: 'BUILD',
          status: 'completed',
          outcome: 'passed',
          endedAt: at('2026-01-10T00:00:00.000Z'),
        }),
      );
    });
    await createResumer(baseDeps(store)).recover(runId, hostContext());
    const tree = await store.readRunTree(runId);
    expect(tree.phases[0]).toMatchObject({ phaseRunId, status: 'completed', outcome: 'passed' });
    expect(tree.phases[0]?.endedAt).toBe('2026-01-10T00:00:00.000Z');
    await store.close();
  });
});
