// U1.08 deliverable: `createEffectJournal` (DESIGN 4.1, 4.2 E6/E7, 0.2 I5 "events first, then effects: an effect
// without a committed intent cannot start", 0.2 I6 "one writer per run, fenced"). Tests first (PLAN §3 rule 9).
import { CohorteError, type JsonValue, type RunId } from '@cohorte/base';
import type { EffectKind, StateStore } from '@cohorte/persistence/contract';
import { FixedClock, fakeRedactor, SeqIds } from '@cohorte/testkit';
import { makeSpool, makeStore, sealForTest } from '@cohorte/testkit/store-factory';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EffectSpec } from '../../src/contract/internal.ts';
import {
  type Crashpoint,
  isCrashpoint,
  resetCrashpointOccurrences,
  setFaultInjector,
} from '../../src/durability/crashpoints.ts';
import { crashFamilyOf, createEffectJournal } from '../../src/durability/journal/index.ts';
import { createEventWriter } from '../../src/events/index.ts';
import { asRunId, lockOwner, seedActiveRun } from './support.ts';

async function setup() {
  const store: StateStore = await makeStore();
  const clock = new FixedClock();
  const ids = new SeqIds();
  const redactor = fakeRedactor();
  const writer = createEventWriter({ redactor, clock, ids, spool: makeSpool() });
  const journal = createEffectJournal({ store, events: writer, clock, redactor });
  const runId: RunId = asRunId('journal-i5');
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

describe('I5 — events first, then effects: EffectJournal.run() is the only caller of the external effect', () => {
  test('the spy standing in for Executor/GitPort/AgentRuntime.spawn runs only once run() has committed the intent', async () => {
    const { journal, runId, lease } = await setup();
    const perform = vi.fn(async () => ({ result: {} as JsonValue, after: [] }));
    const spec = specFor(runId, { idempotencyKey: 'i5-fresh' }, perform);

    const result = await journal.run(lease, spec, new AbortController().signal);

    expect(result).toEqual({ status: 'done', result: {} });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  test('an intent left over from a crashed incarnation ("open") is never blindly redone: perform is unreachable', async () => {
    const { store, journal, runId, lease } = await setup();
    // A prior incarnation committed tx A and died before tx B: the row is stuck at `intent`.
    await store.transact({ runId }, lease, (tx) =>
      tx.beginEffect({
        runId,
        idempotencyKey: 'i5-open',
        kind: 'tool.write_file',
        replayClass: 'verifiable',
        request: sealForTest({}),
        verify: sealForTest({}),
      }),
    );

    const perform = vi.fn(async () => ({ result: {} as JsonValue, after: [] }));
    const spec = specFor(runId, { idempotencyKey: 'i5-open' }, perform);

    const thrown: unknown = await journal.run(lease, spec, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CohorteError);
    expect((thrown as CohorteError).info.code).toBe('human-required/in-doubt-effect');
    expect(perform).not.toHaveBeenCalled();
  });

  test('an unknown effect kind still cannot start without a committed intent: beginEffect is always first', async () => {
    const { store, journal, runId, lease } = await setup();
    const perform = vi.fn(async () => ({ result: {} as JsonValue, after: [] }));
    const spec = specFor(runId, { idempotencyKey: 'i5-fresh-2', kind: 'git.commit' }, perform);

    await journal.run(lease, spec, new AbortController().signal);

    const effects = await store.listEffects(runId, { states: ['done'] });
    expect(effects.map((e) => e.idempotencyKey)).toContain('i5-fresh-2');
    expect(effects.find((e) => e.idempotencyKey === 'i5-fresh-2')?.kind).toBe('git.commit');
  });
});

describe('a lease lost mid-run: the next transaction fails, the journal stops (DESIGN 0.2 I6, 2.4)', () => {
  test('a run lease stolen out from under the journal fails closed before perform ever runs', async () => {
    const { store, journal, runId, lease } = await setup();
    const [held] = await store.listLocks({ scope: 'run' });
    if (!held) throw new Error('no run lock listed');
    // Another host takes over (heartbeat lost): the fencing token moves, the old lease is now stale.
    await store.stealLock(
      { scope: 'run', key: runId, mode: 'exclusive', owner: lockOwner('host-2', runId), ttlMs: 60_000 },
      held,
    );

    const perform = vi.fn(async () => ({ result: {} as JsonValue, after: [] }));
    const spec = specFor(runId, { idempotencyKey: 'lease-lost-1' }, perform);

    const thrown: unknown = await journal.run(lease, spec, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CohorteError);
    expect((thrown as CohorteError).info.code).toBe('conflict/lease-lost');
    expect(perform).not.toHaveBeenCalled();
  });

  test('the lease stolen INSIDE perform: the external effect ran once, tx B fails, the row stays `intent`', async () => {
    const { store, journal, runId, lease } = await setup();

    // The real mid-run case (DESIGN 4.1's crash window 2, but with a takeover instead of a crash): tx A committed,
    // the external effect is under way, and another host steals the run lock while it runs. tx B must be refused —
    // this is the in-doubt path that matters, and the one the deliverable names ("a lost lease stops every further
    // effect with conflict/lease-lost").
    const perform = vi.fn(async () => {
      const [held] = await store.listLocks({ scope: 'run' });
      if (!held) throw new Error('no run lock listed');
      await store.stealLock(
        { scope: 'run', key: runId, mode: 'exclusive', owner: lockOwner('host-2', runId), ttlMs: 60_000 },
        held,
      );
      return { result: { written: true } as JsonValue, after: [] };
    });
    const spec = specFor(runId, { idempotencyKey: 'lease-lost-mid' }, perform);

    const thrown: unknown = await journal.run(lease, spec, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CohorteError);
    expect((thrown as CohorteError).info.code).toBe('conflict/lease-lost');
    expect(perform).toHaveBeenCalledTimes(1); // the effect happened exactly once, and is not retried

    // The row never reached `done`: recovery sees an `intent` row and reconciles it by replay class (DESIGN 4.1).
    const open = await store.listEffects(runId, { states: ['intent'] });
    expect(open.map((e) => e.idempotencyKey)).toContain('lease-lost-mid');
    expect(await store.listEffects(runId, { states: ['done'] })).toHaveLength(0);
  });

  test('perform throws AND the lease is gone: the caller learns what the tool failed with, not that the store refused', async () => {
    const { store, journal, runId, lease } = await setup();

    // Both halves of the same accident: the tool failed, and while it ran another host took the run over. Recording
    // the failure needs a transaction the stale lease can no longer open — so the `failEffect` transaction rejects
    // too. What the caller needs is the PERFORM error (why the tool failed); the lost lease is noticed by the next
    // effect, which fails closed on its own (the test above), and by the lease keeper.
    const boom = new Error('the tool blew up');
    const perform = vi.fn(async () => {
      const [held] = await store.listLocks({ scope: 'run' });
      if (!held) throw new Error('no run lock listed');
      await store.stealLock(
        { scope: 'run', key: runId, mode: 'exclusive', owner: lockOwner('host-2', runId), ttlMs: 60_000 },
        held,
      );
      throw boom;
    });
    const spec = specFor(runId, { idempotencyKey: 'fail-and-stolen' }, perform);

    const thrown: unknown = await journal.run(lease, spec, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBe(boom);

    // The row could not be marked `failed`, so it stays `intent`: recovery reconciles it by replay class (4.1).
    const open = await store.listEffects(runId, { states: ['intent'] });
    expect(open.map((e) => e.idempotencyKey)).toContain('fail-and-stolen');
  });

  test('every further effect on the stale lease also fails closed: the journal stops, it does not retry with the old lease', async () => {
    const { store, journal, runId, lease } = await setup();
    const [held] = await store.listLocks({ scope: 'run' });
    if (!held) throw new Error('no run lock listed');
    await store.stealLock(
      { scope: 'run', key: runId, mode: 'exclusive', owner: lockOwner('host-2', runId), ttlMs: 60_000 },
      held,
    );

    const perform = vi.fn(async () => ({ result: {} as JsonValue, after: [] }));
    for (const key of ['lease-lost-a', 'lease-lost-b']) {
      const spec = specFor(runId, { idempotencyKey: key }, perform);
      await expect(journal.run(lease, spec, new AbortController().signal)).rejects.toBeInstanceOf(CohorteError);
    }
    expect(perform).not.toHaveBeenCalled();
  });
});

describe('crash points are named per effect KIND (DESIGN 4.3), never by a fixed `tool.` prefix', () => {
  const hit: Crashpoint[] = [];

  beforeEach(() => {
    hit.length = 0;
    resetCrashpointOccurrences();
    // A recording injector that never crashes: `crashpoint()` consults it for every point it fires, so this is the
    // cheapest way to observe which points one `run()` hits, in order.
    setFaultInjector({
      shouldFail: (point) => {
        hit.push(point);
        return false;
      },
    });
  });
  afterEach(() => {
    setFaultInjector(null);
    resetCrashpointOccurrences();
  });

  const runEffect = async (kind: EffectKind, key: string): Promise<void> => {
    const { journal, runId, lease } = await setup();
    const spec = specFor(runId, { idempotencyKey: key, kind }, async () => ({ result: {} as JsonValue, after: [] }));
    await journal.run(lease, spec, new AbortController().signal);
  };

  test('a tool call keeps the three `tool.*` positions of rows 12 and 13', async () => {
    await runEffect('tool.write_file', 'cp-tool');
    expect(hit).toEqual(['tool.after-intent', 'tool.after-effect', 'tool.after-done']);
  });

  test('a git.commit effect fires row 15 only — the `tool.after-intent` occurrence counter is not polluted', async () => {
    await runEffect('git.commit', 'cp-commit');
    expect(hit).toEqual(['commit.after-git-commit']);
    expect(hit.some((point) => point.startsWith('tool.'))).toBe(false);
  });

  test('a merge, a worktree add and a provisioning command each fire their own row', async () => {
    await runEffect('git.merge', 'cp-merge');
    await runEffect('git.worktree.add', 'cp-wt');
    await runEffect('provision.command', 'cp-prov');
    expect(hit).toEqual(['merge.after-update-ref', 'provision.after-worktree-add', 'provision.after-install']);
  });

  test('a transition effect fires the two points DESIGN 4.3 row 6 declares (a declared point never hit fails the crash suite)', async () => {
    await runEffect('git.ref.create', 'cp-ref'); // T08 `mint-review-ref`
    expect(hit).toEqual(['transition-effect.after-intent', 'transition-effect.after-external']);
  });

  test('an agent spawn fires row 9', async () => {
    await runEffect('agent.spawn', 'cp-spawn');
    expect(hit).toEqual(['spawn.after-intent', 'spawn.after-ready']);
  });

  const EVERY_KIND: EffectKind[] = [
    'fs.snapshot.materialize',
    'git.branch.create',
    'git.ref.create',
    'git.worktree.add',
    'git.worktree.remove',
    'git.worktree.reset',
    'git.commit',
    'git.merge',
    'provision.command',
    'check.command',
    'agent.spawn',
    'tool.read',
    'tool.write_file',
    'tool.patch_file',
    'tool.run_command',
    'tool.network_request',
    'tool.git_commit',
  ];

  test.for(EVERY_KIND)('%s maps to at least one point of the frozen registry', (kind) => {
    const family = crashFamilyOf(kind);
    const points = [family.afterIntent, family.afterExternal, family.afterDone].filter((point) => point !== undefined);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) expect(isCrashpoint(point)).toBe(true);
  });
});
