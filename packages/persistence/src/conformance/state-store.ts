// The StateStore conformance suite (DESIGN 2.4, ADR-0002). COMPLETE in Wave 0: a store package RUNS it
// (`stateStoreConformance(factory, hooks)` in one of its test files), nobody fills it.
import {
  type ApprovalId,
  CohorteError,
  canonicalJson,
  computeAnchorMac,
  errorOf,
  type JsonValue,
  type RunId,
  type Sealed,
  sha256Hex,
} from '@cohorte/base';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type ApprovalRecord,
  type EffectIntent,
  type EventDraft,
  type LeaseToken,
  type StateStore,
  StoreUsageError,
} from '../contract.ts';
import {
  activeRun,
  agentId,
  anchorDraft,
  approvalId,
  artifactId,
  draft,
  effectIdOf,
  eventId,
  findingId,
  HOST_COLUMNS,
  HUMAN,
  hostDetachedDraft,
  idleRun,
  owner,
  pauseCommand,
  phaseRunId,
  runId,
  runLock,
  SHA_A,
  SHA_B,
  startCommand,
  T0,
  transition,
} from './fixtures.ts';

export type ChainDamage =
  /** the stored envelope of one event is rewritten, its hash left as it was */
  | { kind: 'rewrite'; sequence: number }
  /** one event disappears */
  | { kind: 'remove'; sequence: number }
  /** one event is stored a second time under the same sequence */
  | { kind: 'duplicate'; sequence: number };

export interface StateStoreConformanceHooks {
  label?: string;
  /** Seals a value the suite built and knows to be harmless (I7). Only a Redactor mints `Sealed<T>`: pass testkit's. */
  seal<T>(value: T): Sealed<T>;
  /**
   * Damages the journal BEHIND the contract, the way somebody with write access to the storage would (protections
   * bypassed). Resolves `false` when this store cannot even represent that damage (a PRIMARY KEY forbids a duplicate).
   */
  damage(store: StateStore, id: RunId, damage: ChainDamage): Promise<boolean>;
  /** A raw UPDATE of one event through the store's own protections: MUST reject, always. */
  rewriteEvent(store: StateStore, id: RunId, sequence: number): Promise<void>;
  /** A raw DELETE of a run's events through the store's own protections (what `gc` does): MUST reject unless `runs.purgeable`. */
  purgeEvents(store: StateStore, id: RunId): Promise<void>;
  /** How many snapshots the storage really holds for a run (the contract only ever loads the latest). */
  snapshotCount(store: StateStore, id: RunId): Promise<number>;
}

const KEY = new Uint8Array(32).fill(7);

export function stateStoreConformance(factory: () => Promise<StateStore>, hooks: StateStoreConformanceHooks): void {
  const opened: StateStore[] = [];
  const open = async (): Promise<StateStore> => {
    const store = await factory();
    opened.push(store);
    return store;
  };
  const sealed = (drafts: EventDraft[]) => drafts.map((one) => hooks.seal(one));

  /** A run in BUILD, created the legal way (IDLE row in a project transaction, then the host's T04 write), plus its lease. */
  const started = async (store: StateStore, name: string): Promise<{ id: RunId; lease: LeaseToken }> => {
    const id = runId(name);
    await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));
    const got = await store.acquireLock(runLock(id));
    if (!got.ok) throw new Error(`conformance: the run lock of ${id} is held in a fresh store`);
    await store.transact({ runId: id }, got.lease, (tx) => tx.patchRun(id, { state: 'BUILD', ...HOST_COLUMNS }));
    return { id, lease: got.lease };
  };

  const intent = (id: RunId, key: string, extra: Partial<EffectIntent> = {}): EffectIntent => ({
    runId: id,
    idempotencyKey: key,
    kind: 'tool.write_file',
    replayClass: 'verifiable',
    request: hooks.seal({ path: 'src/a.ts' }),
    verify: hooks.seal({ beforeSha256: SHA_A, afterSha256: SHA_B }),
    ...extra,
  });

  const approval = (id: RunId, name: string, grantKey: string): ApprovalRecord => ({
    approvalId: approvalId(name),
    runId: id,
    idempotencyKey: `apr:${name}`,
    kind: 'tool-call',
    status: 'pending',
    request: hooks.seal({ tool: 'write_file', path: 'src/a.ts' }),
    grantKey,
    requestedSeq: 0,
    createdAt: T0,
  });

  const rejectsWithCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
    const thrown: unknown = await promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CohorteError);
    expect((thrown as CohorteError).info.code).toBe(code);
  };

  describe(`StateStore conformance${hooks.label ? ` (${hooks.label})` : ''}`, () => {
    afterEach(async () => {
      for (const store of opened.splice(0)) await store.close();
    });

    describe('lifecycle', () => {
      test('open() reports the store kind and a schema version; migrate(check) has nothing pending', async () => {
        const store = await open();
        const info = await store.open();
        expect(info.kind).toBe(store.kind);
        expect(info.schemaVersion).toBeGreaterThanOrEqual(1);
        const report = await store.migrate('check');
        expect(report.mode).toBe('check');
        expect(report.pending).toEqual([]);
        expect(report.current).toBe(report.target);
      });
    });

    describe('transactions', () => {
      test('a body that throws rolls back every write it made', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'rollback');
        const boom = new Error('boom');
        await expect(
          store.transact({ runId: id }, lease, (tx) => {
            tx.appendEvents(sealed([draft(id, 'a')]));
            tx.patchRun(id, { title: 'changed' });
            tx.putLedger({
              runId: id,
              slot: 'main',
              path: 'a.ts',
              sha256: SHA_A,
              effectId: effectIdOf('x'),
              effectSeq: 1,
            });
            tx.enqueueCommand(pauseCommand('rolled-back', id));
            throw boom;
          }),
        ).rejects.toBe(boom);
        const run = await store.getRun(id);
        expect(run?.title).toBe(`run ${id}`);
        expect(run?.lastSequence).toBe(0);
        expect(await store.readEvents(id, { afterSequence: 0, limit: 10 })).toEqual([]);
        expect(await store.readLedger(id, 'main')).toEqual([]);
        expect(await store.getCommand(pauseCommand('rolled-back', id).commandId)).toBeUndefined();
      });

      test('a committed body returns its value and every write is visible', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'commit');
        const result = await store.transact({ runId: id }, lease, (tx) => {
          const [first] = tx.appendEvents(sealed([draft(id, 'a')]));
          tx.patchRun(id, { title: 'renamed' });
          return first?.sequence;
        });
        expect(result).toBe(1);
        expect((await store.getRun(id))?.title).toBe('renamed');
      });

      test('a body that returns a thenable is rejected and rolled back', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'thenable');
        await expect(
          store.transact({ runId: id }, lease, (tx) => {
            tx.patchRun(id, { title: 'async' });
            return Promise.resolve(1);
          }),
        ).rejects.toBeInstanceOf(StoreUsageError);
        expect((await store.getRun(id))?.title).toBe(`run ${id}`);
      });

      test('what a body read or wrote is a copy: mutating it after the fact changes nothing stored', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'copies');
        const zones = ['src/app'];
        const seen = await store.transact({ runId: id }, lease, (tx) => {
          tx.patchRun(id, { zones });
          return tx.run();
        });
        zones.push('src/other');
        seen.title = 'mutated outside';
        const run = await store.getRun(id);
        expect(run?.zones).toEqual(['src/app']);
        expect(run?.title).toBe(`run ${id}`);
      });

      test('a run-scoped transaction without a lease is refused', async () => {
        const store = await open();
        const { id } = await started(store, 'nolease');
        await expect(
          store.transact({ runId: id }, null, (tx) => tx.patchRun(id, { title: 'x' })),
        ).rejects.toBeInstanceOf(StoreUsageError);
      });

      test('a run-scoped transaction cannot write another run', async () => {
        const store = await open();
        const a = await started(store, 'mine');
        const b = await started(store, 'theirs');
        await expect(
          store.transact({ runId: a.id }, a.lease, (tx) => tx.patchRun(b.id, { title: 'hijacked' })),
        ).rejects.toBeInstanceOf(StoreUsageError);
        await expect(
          store.transact({ runId: a.id }, a.lease, (tx) => tx.appendEvents(sealed([draft(b.id, 'x')]))),
        ).rejects.toBeInstanceOf(StoreUsageError);
        await expect(
          store.transact({ runId: b.id }, a.lease, (tx) => tx.patchRun(b.id, { title: 'hijacked' })),
        ).rejects.toBeInstanceOf(StoreUsageError);
        expect((await store.getRun(b.id))?.title).toBe(`run ${b.id}`);
      });

      test('expectedSequence: the body runs only if the run has not moved', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'expected');
        await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'a')])), {
          expectedSequence: 0,
        });
        let ran = false;
        await rejectsWithCode(
          store.transact(
            { runId: id },
            lease,
            () => {
              ran = true;
            },
            { expectedSequence: 0 },
          ),
          'conflict/unexpected',
        );
        expect(ran).toBe(false);
        await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'b')])), {
          expectedSequence: 1,
        });
        expect((await store.getRun(id))?.lastSequence).toBe(2);
      });
    });

    describe('run creation (start is ONE atomic write)', () => {
      test('createRun + start command is atomic; a second start with the same commandId creates no second run and reports duplicate', async () => {
        const store = await open();
        const id = runId('start');
        const command = startCommand('start-1', id);
        const first = await store.transact('project', null, (tx) => {
          const status = tx.enqueueCommand(command);
          if (status === 'enqueued') tx.putRun(idleRun(id));
          return status;
        });
        expect(first).toBe('enqueued');
        expect((await store.getRun(id))?.state).toBe('IDLE');
        expect((await store.pendingCommands(id)).map((row) => row.commandId)).toEqual([command.commandId]);

        const again = await store.transact('project', null, (tx) => {
          const status = tx.enqueueCommand(command);
          if (status === 'enqueued') tx.putRun(idleRun(runId('start-twin')));
          return status;
        });
        expect(again).toBe('duplicate');
        expect(await store.getRun(runId('start-twin'))).toBeUndefined();
        expect(await store.listRuns({ limit: 10, offset: 0 })).toHaveLength(1);
        expect(await store.pendingCommands(id)).toHaveLength(1);
      });

      test('the order is load-bearing: putRun before enqueueCommand commits an orphan run on a retried start', async () => {
        const store = await open();
        const id = runId('order');
        const command = startCommand('start-order', id);
        await store.transact('project', null, (tx) => {
          const status = tx.enqueueCommand(command);
          if (status === 'enqueued') tx.putRun(idleRun(id));
          return status;
        });
        // The same start, retried by a caller that writes the run FIRST. Neither status throws, so nothing rolls the
        // transaction back: the run row commits beside the answer "duplicate". This is why `StoreTx.enqueueCommand`
        // says to call it first and to write the run only on 'enqueued'.
        const orphan = runId('order-orphan');
        const status = await store.transact('project', null, (tx) => {
          tx.putRun(idleRun(orphan));
          return tx.enqueueCommand(command);
        });
        expect(status).toBe('duplicate');
        expect((await store.getRun(orphan))?.state).toBe('IDLE');
        expect(await store.pendingCommands(id)).toHaveLength(1);
      });

      test('a start that fails after enqueueing leaves neither the run nor the command', async () => {
        const store = await open();
        const id = runId('half-start');
        const command = startCommand('start-2', id);
        await expect(
          store.transact('project', null, (tx) => {
            tx.putRun(idleRun(id));
            tx.enqueueCommand(command);
            throw new Error('disk full');
          }),
        ).rejects.toThrow('disk full');
        expect(await store.getRun(id)).toBeUndefined();
        expect(await store.getCommand(command.commandId)).toBeUndefined();
      });

      test('a project transaction may create a run and enqueue — and nothing else run-scoped', async () => {
        const store = await open();
        const { id } = await started(store, 'existing');
        await expect(
          store.transact('project', null, (tx) => tx.putRun(idleRun(id, { title: 'overwritten' }))),
        ).rejects.toBeInstanceOf(StoreUsageError);
        await expect(
          store.transact('project', null, (tx) => tx.patchRun(id, { title: 'overwritten' })),
        ).rejects.toBeInstanceOf(StoreUsageError);
        await expect(
          store.transact('project', null, (tx) => tx.appendEvents(sealed([draft(id, 'a')]))),
        ).rejects.toBeInstanceOf(StoreUsageError);
        await expect(store.transact('project', null, (tx) => tx.beginEffect(intent(id, 'k')))).rejects.toBeInstanceOf(
          StoreUsageError,
        );
        await expect(store.transact('project', null, (tx) => tx.run())).rejects.toBeInstanceOf(StoreUsageError);
        expect((await store.getRun(id))?.title).toBe(`run ${id}`);
      });

      test('a run-scoped transaction may rewrite its run but never create one', async () => {
        const store = await open();
        const unborn = runId('unborn');
        const got = await store.acquireLock(runLock(unborn));
        if (!got.ok) throw new Error('lock held');
        // A run-scope lease of a run that does not exist is legal (the lock table knows nothing of runs), but it must
        // not be a second way to create the row: `start` is { IDLE run row + signed start command }, one project
        // transaction (4.3 #1). A run born here would have no start command and no signature behind it.
        await expect(
          store.transact({ runId: unborn }, got.lease, (tx) => tx.putRun(idleRun(unborn))),
        ).rejects.toBeInstanceOf(StoreUsageError);
        expect(await store.getRun(unborn)).toBeUndefined();
        await store.releaseLock(got.lease.lockId);
      });

      test('a run row may leave IDLE only with the six host-computed columns set', async () => {
        const store = await open();
        const id = runId('six');
        await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));
        const got = await store.acquireLock(runLock(id));
        if (!got.ok) throw new Error('lock held');
        await expect(
          store.transact({ runId: id }, got.lease, (tx) => tx.patchRun(id, { state: 'PREFLIGHT' })),
        ).rejects.toBeInstanceOf(StoreUsageError);
        const { zones: _zones, ...five } = HOST_COLUMNS;
        await expect(
          store.transact({ runId: id }, got.lease, (tx) => tx.patchRun(id, { state: 'PREFLIGHT', ...five })),
        ).rejects.toBeInstanceOf(StoreUsageError);
        // "Set" means non-null: the DDL's CHECK reads `IS NOT NULL`, and `runtimePin?: JsonValue` makes an explicit
        // JSON `null` well-typed. A store that only looks for an ABSENT key would accept here and be refused by SQL.
        await expect(
          store.transact({ runId: id }, got.lease, (tx) =>
            tx.patchRun(id, { state: 'PREFLIGHT', ...HOST_COLUMNS, runtimePin: null }),
          ),
        ).rejects.toBeInstanceOf(StoreUsageError);
        await expect(
          store.transact('project', null, (tx) => tx.putRun(idleRun(runId('born-running'), { state: 'BUILD' }))),
        ).rejects.toBeInstanceOf(StoreUsageError);
        expect((await store.getRun(id))?.state).toBe('IDLE');

        // IDLE -> CANCELLED and IDLE -> FAILED need none of them; any other state needs all six.
        await store.transact({ runId: id }, got.lease, (tx) => tx.patchRun(id, { state: 'FAILED' }));
        await store.transact({ runId: id }, got.lease, (tx) =>
          tx.patchRun(id, { state: 'PREFLIGHT', ...HOST_COLUMNS }),
        );
        const run = await store.getRun(id);
        expect(run?.state).toBe('PREFLIGHT');
        expect(run?.plan).toEqual(HOST_COLUMNS.plan);
        expect(run?.zones).toEqual(HOST_COLUMNS.zones);
      });
    });

    describe('event journal', () => {
      test('sequences are gapless from 1, sub is 0, durability is durable, and the run row follows', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'gapless');
        const before = await store.getRun(id);
        const first = await store.transact({ runId: id }, lease, (tx) =>
          tx.appendEvents(sealed([draft(id, 'a'), draft(id, 'b')])),
        );
        const second = await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'c')])));
        expect([...first, ...second].map((event) => [event.sequence, event.sub, event.durability])).toEqual([
          [1, 0, 'durable'],
          [2, 0, 'durable'],
          [3, 0, 'durable'],
        ]);
        const run = await store.getRun(id);
        expect(run?.lastSequence).toBe(3);
        expect(run?.version).toBeGreaterThan(before?.version ?? 0);
        const events = await store.readEvents(id, { afterSequence: 0, limit: 10 });
        expect(events).toEqual([...first, ...second]);
        expect(events[0]).toEqual({ ...draft(id, 'a'), sequence: 1, sub: 0, durability: 'durable' });
      });

      test('the hash chain is sha256(prev_hash || "\\n" || canonical envelope), from the empty hash', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'chain');
        const events = await store.transact({ runId: id }, lease, (tx) =>
          tx.appendEvents(sealed([draft(id, 'a'), draft(id, 'b')])),
        );
        let hash = '';
        for (const event of events) hash = sha256Hex(`${hash}\n${canonicalJson(event as unknown as JsonValue)}`);
        expect((await store.getRun(id))?.lastHash).toBe(hash);
        expect(await store.verifyChain(id)).toEqual({ ok: true, events: 2, anchors: 0 });
      });

      test('an empty journal verifies', async () => {
        const store = await open();
        const { id } = await started(store, 'empty');
        expect(await store.verifyChain(id)).toEqual({ ok: true, events: 0, anchors: 0 });
      });

      test('each run has its own sequence and its own chain', async () => {
        const store = await open();
        const a = await started(store, 'one');
        const b = await started(store, 'two');
        await store.transact({ runId: a.id }, a.lease, (tx) => tx.appendEvents(sealed([draft(a.id, 'a')])));
        const [event] = await store.transact({ runId: b.id }, b.lease, (tx) =>
          tx.appendEvents(sealed([draft(b.id, 'a')])),
        );
        expect(event?.sequence).toBe(1);
        expect(await store.readEvents(b.id, { afterSequence: 0, limit: 10 })).toHaveLength(1);
      });

      test('a duplicate eventId aborts the transaction', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'dup-event');
        await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'a')])));
        await expect(
          store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'b'), draft(id, 'a')]))),
        ).rejects.toBeInstanceOf(StoreUsageError);
        expect((await store.getRun(id))?.lastSequence).toBe(1);
      });

      test('putRun and patchRun never move the store-assigned sequence, hash and version', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'assigned');
        await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'a')])));
        const before = await store.getRun(id);
        await store.transact({ runId: id }, lease, (tx) => {
          tx.patchRun(id, { lastSequence: 40, lastHash: 'forged', version: 0 });
          tx.putRun(activeRun(id, { title: 'put' }));
        });
        const after = await store.getRun(id);
        expect(after?.title).toBe('put');
        expect(after?.lastSequence).toBe(1);
        expect(after?.lastHash).toBe(before?.lastHash);
        expect(after?.version).toBe(before?.version);
        expect(await store.verifyChain(id)).toMatchObject({ ok: true });
      });

      test('verifyChain names the first rewritten event', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'tamper');
        await store.transact({ runId: id }, lease, (tx) =>
          tx.appendEvents(sealed([draft(id, 'a'), draft(id, 'b'), draft(id, 'c')])),
        );
        expect(await hooks.damage(store, id, { kind: 'rewrite', sequence: 2 })).toBe(true);
        expect(await store.verifyChain(id)).toEqual({ ok: false, firstBadSequence: 2, reason: 'hash-mismatch' });
      });

      test('verifyChain names the first missing sequence', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'gap');
        await store.transact({ runId: id }, lease, (tx) =>
          tx.appendEvents(sealed([draft(id, 'a'), draft(id, 'b'), draft(id, 'c')])),
        );
        expect(await hooks.damage(store, id, { kind: 'remove', sequence: 2 })).toBe(true);
        expect(await store.verifyChain(id)).toEqual({ ok: false, firstBadSequence: 2, reason: 'gap' });
      });

      test('verifyChain names a duplicated sequence, where the storage can hold one at all', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'duplicate');
        await store.transact({ runId: id }, lease, (tx) =>
          tx.appendEvents(sealed([draft(id, 'a'), draft(id, 'b'), draft(id, 'c')])),
        );
        const representable = await hooks.damage(store, id, { kind: 'duplicate', sequence: 2 });
        expect(await store.verifyChain(id)).toEqual(
          representable ? { ok: false, firstBadSequence: 2, reason: 'duplicate' } : { ok: true, events: 3, anchors: 0 },
        );
      });

      test('anchors: a checkpoint MAC is verified with the key, ignored without it', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'anchor');
        await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'a'), draft(id, 'b')])));
        const chainHash = (await store.getRun(id))?.lastHash ?? '';
        await store.transact({ runId: id }, lease, (tx) =>
          tx.appendEvents(
            sealed([
              anchorDraft(id, 'cp1', { atSequence: 2, chainHash, chainMac: computeAnchorMac(KEY, id, 2, chainHash) }),
            ]),
          ),
        );
        expect(await store.verifyChain(id, KEY)).toEqual({ ok: true, events: 3, anchors: 1 });
        expect(await store.verifyChain(id)).toEqual({ ok: true, events: 3, anchors: 0 });
        expect(await store.verifyChain(id, new Uint8Array(32).fill(9))).toEqual({
          ok: false,
          firstBadSequence: 3,
          reason: 'anchor-mac',
        });
      });

      test('anchors: a MAC over a hash the chain never had is refused', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'anchor-forged');
        await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'a')])));
        const forged = 'f'.repeat(64);
        await store.transact({ runId: id }, lease, (tx) =>
          tx.appendEvents(
            sealed([
              anchorDraft(id, 'cp1', {
                atSequence: 1,
                chainHash: forged,
                chainMac: computeAnchorMac(KEY, id, 1, forged),
              }),
            ]),
          ),
        );
        expect(await store.verifyChain(id, KEY)).toEqual({ ok: false, firstBadSequence: 2, reason: 'anchor-mac' });
      });

      test('events are append-only: no update ever, no delete unless the run is purgeable', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'append-only');
        await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'a'), draft(id, 'b')])));
        await expect(hooks.rewriteEvent(store, id, 1)).rejects.toThrow(/append-only/);
        await expect(hooks.purgeEvents(store, id)).rejects.toThrow(/append-only/);
        expect(await store.readEvents(id, { afterSequence: 0, limit: 10 })).toHaveLength(2);

        await store.transact({ runId: id }, lease, (tx) => tx.patchRun(id, { purgeable: true }));
        await expect(hooks.rewriteEvent(store, id, 1)).rejects.toThrow(/append-only/);
        await hooks.purgeEvents(store, id);
        expect(await store.readEvents(id, { afterSequence: 0, limit: 10 })).toEqual([]);
      });

      test('reads are paginated by sequence and filtered by type', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'pages');
        await store.transact({ runId: id }, lease, (tx) =>
          tx.appendEvents(
            sealed([draft(id, 'a'), hostDetachedDraft(id, 'b'), draft(id, 'c'), draft(id, 'd'), draft(id, 'e')]),
          ),
        );
        const sequences = async (q: Parameters<StateStore['readEvents']>[1]): Promise<number[]> =>
          (await store.readEvents(id, q)).map((event) => event.sequence);
        expect(await sequences({ afterSequence: 0, limit: 2 })).toEqual([1, 2]);
        expect(await sequences({ afterSequence: 2, limit: 2 })).toEqual([3, 4]);
        expect(await sequences({ afterSequence: 4, limit: 2 })).toEqual([5]);
        expect(await sequences({ afterSequence: 5, limit: 2 })).toEqual([]);
        expect(await sequences({ afterSequence: 0, limit: 10, types: ['run.host.detached'] })).toEqual([2]);
        expect(await sequences({ afterSequence: 1, limit: 2, types: ['check.started'] })).toEqual([3, 4]);
      });
    });

    describe('fencing (I6)', () => {
      test('a write under a stolen lease throws conflict/lease-lost before the body runs', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'fenced');
        const [held] = await store.listLocks({ scope: 'run' });
        if (!held) throw new Error('no run lock listed');
        const stolen = await store.stealLock(runLock(id, 'host-2'), held);
        let ran = false;
        await rejectsWithCode(
          store.transact({ runId: id }, lease, () => {
            ran = true;
          }),
          'conflict/lease-lost',
        );
        expect(ran).toBe(false);
        await store.transact({ runId: id }, stolen, (tx) => tx.appendEvents(sealed([draft(id, 'by-host-2')])));
        expect((await store.getRun(id))?.lastSequence).toBe(1);
      });

      test('a forged fencing token and a released lease are both refused', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'forged');
        await rejectsWithCode(
          store.transact({ runId: id }, { ...lease, fencingToken: lease.fencingToken + 1 }, () => undefined),
          'conflict/lease-lost',
        );
        await store.releaseLock(lease.lockId);
        await rejectsWithCode(
          store.transact({ runId: id }, lease, () => undefined),
          'conflict/lease-lost',
        );
      });

      test('only the RUN lease writes the run: another lock of the same run is not a licence to write it', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'zone-lease');
        // The supervisor's zone lock: same host, same run named in its owner, a different lock entirely.
        const zone = await store.acquireLock({
          scope: 'zone',
          key: id,
          mode: 'exclusive',
          owner: owner('host-1', id),
          ttlMs: 60_000,
          zones: ['src/app'],
        });
        if (!zone.ok) throw new Error('the zone lock of a fresh store is held');
        expect(zone.lease.runId).toBe(id);
        // Refused while the run lock is still held by the same host …
        await rejectsWithCode(
          store.transact({ runId: id }, zone.lease, (tx) => tx.patchRun(id, { title: 'by the zone lease' })),
          'conflict/lease-lost',
        );
        // … and, above all, after the run lease is fenced out: two writers for one run is what I6 forbids.
        const [held] = await store.listLocks({ scope: 'run' });
        if (!held) throw new Error('no run lock listed');
        await store.stealLock(runLock(id, 'host-2'), held);
        await rejectsWithCode(
          store.transact({ runId: id }, lease, (tx) => tx.patchRun(id, { title: 'by the old run lease' })),
          'conflict/lease-lost',
        );
        await rejectsWithCode(
          store.transact({ runId: id }, zone.lease, (tx) => tx.patchRun(id, { title: 'by the zone lease' })),
          'conflict/lease-lost',
        );
        expect((await store.getRun(id))?.title).toBe(`run ${id}`);
      });

      test('the effect journal records the fencing token of the writer', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'fence-effect');
        await store.transact({ runId: id }, lease, (tx) => tx.beginEffect(intent(id, 'k1')));
        const [effect] = await store.listEffects(id, { states: ['intent'] });
        expect(effect?.fencingToken).toBe(lease.fencingToken);
      });
    });

    describe('idempotency', () => {
      test('a transition is recorded once per (run, idempotency key)', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'transition');
        const outcomes = await store.transact({ runId: id }, lease, (tx) => [
          tx.recordTransition(transition(id, 'T05:1')),
          tx.recordTransition({ ...transition(id, 'T05:1'), transitionId: 'trn_other' }),
          tx.recordTransition(transition(id, 'T05:2')),
        ]);
        expect(outcomes).toEqual(['recorded', 'duplicate', 'recorded']);
      });

      test('an effect: started, then open while it is an intent, then already-done with the stored result', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'effect');
        const begun = await store.transact({ runId: id }, lease, (tx) => {
          tx.appendEvents(sealed([draft(id, 'a')]));
          return tx.beginEffect(intent(id, 'tool:1', { agentId: agentId('impl'), slot: 'main' }));
        });
        if (begun.status !== 'started') throw new Error(`expected started, got ${begun.status}`);

        const reopened = await store.transact({ runId: id }, lease, (tx) => tx.beginEffect(intent(id, 'tool:1')));
        expect(reopened.status).toBe('open');
        if (reopened.status === 'open') {
          expect(reopened.record.effectId).toBe(begun.effectId);
          expect(reopened.record.state).toBe('intent');
          expect(reopened.record.intentSeq).toBe(1);
          expect(reopened.record.agentId).toBe(agentId('impl'));
        }
        expect((await store.listEffects(id, { states: ['intent', 'in-doubt'] })).map((e) => e.effectId)).toEqual([
          begun.effectId,
        ]);

        await store.transact({ runId: id }, lease, (tx) => {
          tx.appendEvents(sealed([draft(id, 'b')]));
          tx.completeEffect(begun.effectId, hooks.seal({ bytes: 12 }));
        });
        const replay = await store.transact({ runId: id }, lease, (tx) => tx.beginEffect(intent(id, 'tool:1')));
        expect(replay.status).toBe('already-done');
        if (replay.status === 'already-done') {
          expect(replay.record.result).toEqual({ bytes: 12 });
          expect(replay.record.state).toBe('done');
          expect(replay.record.doneSeq).toBe(2);
        }
        expect(await store.listEffects(id, { states: ['intent', 'in-doubt'] })).toEqual([]);
        expect(await store.transact({ runId: id }, lease, (tx) => tx.effectByKey('tool:1')?.effectId)).toBe(
          begun.effectId,
        );
      });

      test('an in-doubt effect stays open; a failed one may be begun again; compensation names its cause', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'effect-states');
        const ids = await store.transact({ runId: id }, lease, (tx) => {
          const doubt = tx.beginEffect(intent(id, 'cmd:1', { kind: 'tool.run_command', replayClass: 'at-most-once' }));
          const failing = tx.beginEffect(intent(id, 'check:1', { kind: 'check.command', replayClass: 'idempotent' }));
          const undone = tx.beginEffect(intent(id, 'write:1'));
          const reset = tx.beginEffect(
            intent(id, 'reset:1', { kind: 'git.worktree.reset', replayClass: 'idempotent' }),
          );
          if (
            doubt.status !== 'started' ||
            failing.status !== 'started' ||
            undone.status !== 'started' ||
            reset.status !== 'started'
          ) {
            throw new Error('expected four fresh effects');
          }
          return { doubt: doubt.effectId, failing: failing.effectId, undone: undone.effectId, reset: reset.effectId };
        });
        await store.transact({ runId: id }, lease, (tx) => {
          tx.markEffectInDoubt(ids.doubt, 'host died while the command ran');
          tx.failEffect(ids.failing, errorOf('tool-transient/interrupted', 'interrupted by a crash'));
          tx.completeEffect(ids.undone, hooks.seal({}));
          tx.completeEffect(ids.reset, hooks.seal({}));
          tx.compensateEffects([ids.undone], ids.reset);
        });

        const again = await store.transact({ runId: id }, lease, (tx) => ({
          doubt: tx.beginEffect(intent(id, 'cmd:1', { kind: 'tool.run_command', replayClass: 'at-most-once' })),
          failing: tx.beginEffect(intent(id, 'check:1', { kind: 'check.command', replayClass: 'idempotent' })),
        }));
        expect(again.doubt.status).toBe('open');
        if (again.doubt.status === 'open') expect(again.doubt.record.state).toBe('in-doubt');
        expect(again.failing).toEqual({ status: 'started', effectId: ids.failing });

        const failedOnes = await store.listEffects(id, { states: ['failed'] });
        expect(failedOnes).toEqual([]);
        const [compensated] = await store.listEffects(id, { states: ['compensated'] });
        expect(compensated?.effectId).toBe(ids.undone);
        expect(compensated?.compensatedBy).toBe(ids.reset);
        const [inDoubt] = await store.listEffects(id, { states: ['in-doubt'] });
        expect(inDoubt?.error?.code).toBe('human-required/in-doubt-effect');

        // A COMPENSATED row begun again under its own key is a new attempt on the same row: back to `intent`, the
        // same effectId, and the previous attempt's result / compensatedBy cleared (see `beginEffect`'s contract).
        const recompensated = await store.transact({ runId: id }, lease, (tx) => tx.beginEffect(intent(id, 'write:1')));
        expect(recompensated).toEqual({ status: 'started', effectId: ids.undone });
        const reopened = await store.transact({ runId: id }, lease, (tx) => tx.effectByKey('write:1'));
        expect(reopened?.state).toBe('intent');
        expect(reopened?.compensatedBy).toBeUndefined();
        expect(reopened?.result).toBeUndefined();
        expect(await store.listEffects(id, { states: ['compensated'] })).toEqual([]);
      });

      test('completing an unknown effect aborts the transaction', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'unknown-effect');
        await expect(
          store.transact({ runId: id }, lease, (tx) => tx.completeEffect(effectIdOf('nope'), hooks.seal({}))),
        ).rejects.toBeInstanceOf(StoreUsageError);
      });

      test('an approval is created once per (run, idempotency key) and resolved once', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'approval');
        const created = await store.transact({ runId: id }, lease, (tx) => [
          tx.putApproval(approval(id, 'a1', 'grant-1')),
          tx.putApproval({ ...approval(id, 'a1-twin', 'grant-1'), idempotencyKey: 'apr:a1' }),
        ]);
        expect(created).toEqual(['created', 'exists']);
        expect((await store.listPendingApprovals(id)).map((row) => row.approvalId)).toEqual([approvalId('a1')]);
        expect((await store.listPendingApprovals()).map((row) => row.approvalId)).toEqual([approvalId('a1')]);

        const decision = {
          actor: HUMAN,
          commandId: pauseCommand('approve-1', id).commandId,
          answer: 'allow-once',
          note: 'looks fine',
          decidedAt: T0,
          resolvedSeq: 7,
          auth: { scheme: 'hmac-sha256', value: 'ab'.repeat(32) },
        } as const;
        const resolved = await store.transact({ runId: id }, lease, (tx) => [
          tx.resolveApproval(approvalId('a1'), decision),
          tx.resolveApproval(approvalId('a1'), { ...decision, answer: 'deny' }),
        ]);
        expect(resolved).toEqual(['resolved', 'already-resolved']);
        expect(await store.listPendingApprovals(id)).toEqual([]);
        const row = await store.transact({ runId: id }, lease, (tx) => tx.approval(approvalId('a1')));
        expect(row?.status).toBe('allow-once');
        expect(row?.decision).toEqual({
          actor: HUMAN,
          commandId: decision.commandId,
          answer: 'allow-once',
          note: 'looks fine',
          decidedAt: T0,
        });
        expect(row?.commandAuth).toEqual(decision.auth);
        expect(row?.resolvedSeq).toBe(7);
        expect(row?.resolvedAt).toBe(T0);
      });

      test('a command: enqueued once, duplicate with the same body, id-reuse-conflict with another', async () => {
        const store = await open();
        const { id } = await started(store, 'command');
        const command = pauseCommand('pause-1', id);
        const first = await store.enqueueCommand(command);
        expect(first.status).toBe('enqueued');
        expect(first.record).toMatchObject({
          commandId: command.commandId,
          runId: id,
          type: 'pause',
          status: 'pending',
          authScheme: 'hmac-sha256',
          authValue: 'ab'.repeat(32),
          envelope: command,
        });
        // The authenticator is not part of the body: a re-signed retry is the same command.
        const resigned = { ...command, auth: { scheme: 'hmac-sha256', value: 'ef'.repeat(32) } };
        const second = await store.enqueueCommand(resigned);
        expect(second.status).toBe('duplicate');
        expect(second.record).toEqual(first.record);
        const third = await store.enqueueCommand(pauseCommand('pause-1', id, 'another reason'));
        expect(third.status).toBe('id-reuse-conflict');
        expect(third.record).toEqual(first.record);
        expect(await store.pendingCommands(id)).toEqual([first.record]);
        expect(await store.getCommand(command.commandId)).toEqual(first.record);
      });
    });

    describe('grants (4.5)', () => {
      const allow = (answer: 'allow-once' | 'allow-for-run') =>
        ({ actor: HUMAN, answer, decidedAt: T0, resolvedSeq: 1 }) as const;
      const grant = async (
        store: StateStore,
        id: RunId,
        lease: LeaseToken,
        name: string,
        answer: 'allow-once' | 'allow-for-run',
      ): Promise<ApprovalId> => {
        await store.transact({ runId: id }, lease, (tx) => {
          tx.putApproval(approval(id, name, `grant-${name}`));
          tx.resolveApproval(approvalId(name), allow(answer));
        });
        return approvalId(name);
      };

      test('a pending or denied approval is no grant', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'no-grant');
        const found = await store.transact({ runId: id }, lease, (tx) => {
          tx.putApproval(approval(id, 'p', 'grant-p'));
          tx.putApproval(approval(id, 'd', 'grant-d'));
          tx.resolveApproval(approvalId('d'), { actor: HUMAN, answer: 'deny', decidedAt: T0, resolvedSeq: 1 });
          return [tx.findGrant(id, 'grant-p'), tx.findGrant(id, 'grant-d'), tx.findGrant(id, 'grant-unknown')];
        });
        expect(found).toEqual([undefined, undefined, undefined]);
      });

      test('allow-once is consumed exactly once, inside the intent transaction of its effect', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'once');
        const approved = await grant(store, id, lease, 'once', 'allow-once');
        const begun = await store.transact({ runId: id }, lease, (tx) => {
          expect(tx.findGrant(id, 'grant-once')?.approvalId).toBe(approved);
          const result = tx.beginEffect(intent(id, 'tool:1', { consumesGrant: approved }));
          expect(tx.findGrant(id, 'grant-once')).toBeUndefined();
          return result;
        });
        if (begun.status !== 'started') throw new Error('expected started');
        const row = await store.transact({ runId: id }, lease, (tx) => tx.approval(approved));
        expect(row?.consumedByEffect).toBe(begun.effectId);

        // The same key again (a crash between intent and done): no second consumption, no error.
        const replay = await store.transact({ runId: id }, lease, (tx) =>
          tx.beginEffect(intent(id, 'tool:1', { consumesGrant: approved })),
        );
        expect(replay.status).toBe('open');

        // Another effect cannot spend it a second time, and its intent is not written.
        await rejectsWithCode(
          store.transact({ runId: id }, lease, (tx) =>
            tx.beginEffect(intent(id, 'tool:2', { consumesGrant: approved })),
          ),
          'conflict/unexpected',
        );
        expect(await store.transact({ runId: id }, lease, (tx) => tx.effectByKey('tool:2'))).toBeUndefined();
      });

      test('a rolled-back intent does not consume the grant', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'once-rollback');
        const approved = await grant(store, id, lease, 'rb', 'allow-once');
        await expect(
          store.transact({ runId: id }, lease, (tx) => {
            tx.beginEffect(intent(id, 'tool:1', { consumesGrant: approved }));
            throw new Error('crash before commit');
          }),
        ).rejects.toThrow('crash before commit');
        const found = await store.transact({ runId: id }, lease, (tx) => tx.findGrant(id, 'grant-rb'));
        expect(found?.approvalId).toBe(approved);
        expect(found?.consumedByEffect).toBeUndefined();
      });

      test('allow-for-run stays live across effects; a grant that is not one is refused', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'for-run');
        const approved = await grant(store, id, lease, 'run', 'allow-for-run');
        await store.transact({ runId: id }, lease, (tx) => {
          tx.beginEffect(intent(id, 'tool:1', { consumesGrant: approved }));
          tx.beginEffect(intent(id, 'tool:2', { consumesGrant: approved }));
        });
        const found = await store.transact({ runId: id }, lease, (tx) => tx.findGrant(id, 'grant-run'));
        expect(found?.approvalId).toBe(approved);

        await store.transact({ runId: id }, lease, (tx) => tx.putApproval(approval(id, 'still-pending', 'grant-x')));
        await rejectsWithCode(
          store.transact({ runId: id }, lease, (tx) =>
            tx.beginEffect(intent(id, 'tool:3', { consumesGrant: approvalId('still-pending') })),
          ),
          'conflict/unexpected',
        );
      });

      test('an unconsumed grant can be superseded, and is then no grant', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'superseded');
        const approved = await grant(store, id, lease, 'sup', 'allow-once');
        const outcome = await store.transact({ runId: id }, lease, (tx) => {
          const status = tx.resolveApproval(approved, {
            actor: { kind: 'system', id: 'host-1', transport: 'cli' },
            answer: 'superseded',
            decidedAt: T0,
            resolvedSeq: 9,
          });
          return { status, grant: tx.findGrant(id, 'grant-sup'), row: tx.approval(approved) };
        });
        expect(outcome.status).toBe('resolved');
        expect(outcome.grant).toBeUndefined();
        expect(outcome.row?.status).toBe('superseded');
      });
    });

    describe('command inbox', () => {
      test('claim is exclusive, finish records the outcome, pending lists only pending', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'inbox');
        await store.enqueueCommand(pauseCommand('c1', id));
        await store.enqueueCommand(pauseCommand('c2', id));
        await store.enqueueCommand(pauseCommand('c3', undefined));
        expect((await store.pendingCommands(id)).map((row) => row.commandId)).toEqual([
          pauseCommand('c1', id).commandId,
          pauseCommand('c2', id).commandId,
        ]);

        const c1 = pauseCommand('c1', id).commandId;
        const claims = await store.transact({ runId: id }, lease, (tx) => [
          tx.claimCommand(c1, 'host-1'),
          tx.claimCommand(c1, 'host-2'),
          tx.claimCommand(pauseCommand('missing', id).commandId, 'host-1'),
        ]);
        expect(claims).toEqual([true, false, false]);
        expect((await store.getCommand(c1))?.status).toBe('claimed');
        expect((await store.getCommand(c1))?.claimedBy).toBe('host-1');
        expect((await store.pendingCommands(id)).map((row) => row.commandId)).toEqual([
          pauseCommand('c2', id).commandId,
        ]);

        await store.transact({ runId: id }, lease, (tx) => tx.finishCommand(c1, 'completed', eventId('done')));
        const finished = await store.getCommand(c1);
        expect(finished?.status).toBe('completed');
        expect(finished?.resultEventId).toBe(eventId('done'));
        await expect(
          store.transact({ runId: id }, lease, (tx) => tx.finishCommand(c1, 'rejected', eventId('again'))),
        ).rejects.toBeInstanceOf(StoreUsageError);
      });

      test('a transactional enqueue follows the same three rules', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'tx-inbox');
        const outcomes = await store.transact({ runId: id }, lease, (tx) => [
          tx.enqueueCommand(pauseCommand('t1', id)),
          tx.enqueueCommand(pauseCommand('t1', id)),
          tx.enqueueCommand(pauseCommand('t1', id, 'changed')),
        ]);
        expect(outcomes).toEqual(['enqueued', 'duplicate', 'id-reuse-conflict']);
      });
    });

    describe('locks', () => {
      const projectLock = (mode: 'shared' | 'exclusive', hostId: string) =>
        ({ scope: 'project', key: 'project', mode, owner: owner(hostId), ttlMs: 60_000 }) as const;
      const zoneLock = (hostId: string, zones: string[]) =>
        ({ scope: 'zone', key: 'project', mode: 'exclusive', owner: owner(hostId), ttlMs: 60_000, zones }) as const;

      test('shared locks coexist; an exclusive request is refused and told who holds', async () => {
        const store = await open();
        const a = await store.acquireLock(projectLock('shared', 'host-a'));
        const b = await store.acquireLock(projectLock('shared', 'host-b'));
        expect(a.ok && b.ok).toBe(true);
        const refused = await store.acquireLock(projectLock('exclusive', 'host-c'));
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.heldBy.map((lock) => lock.ownerHostId).sort()).toEqual(['host-a', 'host-b']);
        if (a.ok) await store.releaseLock(a.lease.lockId);
        if (b.ok) await store.releaseLock(b.lease.lockId);
        expect((await store.acquireLock(projectLock('exclusive', 'host-c'))).ok).toBe(true);
        expect((await store.acquireLock(projectLock('shared', 'host-a'))).ok).toBe(false);
      });

      test('locks on another scope or another key never conflict', async () => {
        const store = await open();
        expect((await store.acquireLock(projectLock('exclusive', 'host-a'))).ok).toBe(true);
        expect((await store.acquireLock({ ...projectLock('exclusive', 'host-b'), scope: 'migration' })).ok).toBe(true);
        expect((await store.acquireLock({ ...projectLock('exclusive', 'host-b'), key: 'other' })).ok).toBe(true);
        expect((await store.listLocks({ scope: 'project' })).map((lock) => lock.key).sort()).toEqual([
          'other',
          'project',
        ]);
        expect(await store.listLocks()).toHaveLength(3);
      });

      test('zones overlap by PATH SEGMENT, never by string prefix', async () => {
        const store = await open();
        expect((await store.acquireLock(zoneLock('host-a', ['src/app']))).ok).toBe(true);
        expect((await store.acquireLock(zoneLock('host-b', ['src/application']))).ok).toBe(true);
        expect((await store.acquireLock(zoneLock('host-c', ['docs', 'src/lib']))).ok).toBe(true);
        const child = await store.acquireLock(zoneLock('host-d', ['src/app/ui']));
        expect(child.ok).toBe(false);
        if (!child.ok) expect(child.heldBy.map((lock) => lock.ownerHostId)).toEqual(['host-a']);
        const parent = await store.acquireLock(zoneLock('host-e', ['src']));
        expect(parent.ok).toBe(false);
        if (!parent.ok) {
          expect(parent.heldBy.map((lock) => lock.ownerHostId).sort()).toEqual(['host-a', 'host-b', 'host-c']);
        }
      });

      test('a lease names its lock, run, host and token, and the lock row mirrors the request', async () => {
        const store = await open();
        const id = runId('lease');
        const got = await store.acquireLock({ ...runLock(id), zones: ['src/app'] });
        if (!got.ok) throw new Error('lock held');
        expect(got.lease.runId).toBe(id);
        expect(got.lease.hostId).toBe('host-1');
        expect(got.lease.fencingToken).toBeGreaterThanOrEqual(1);
        const [row] = await store.listLocks({ scope: 'run' });
        expect(row).toMatchObject({
          lockId: got.lease.lockId,
          scope: 'run',
          key: id,
          mode: 'exclusive',
          ownerRunId: id,
          ownerHostId: 'host-1',
          ownerPid: 4242,
          ownerStartToken: 'start-host-1',
          fencingToken: got.lease.fencingToken,
          zones: ['src/app'],
        });
      });

      test('steal = fencing + 1; renew is false after the steal; the thief can renew', async () => {
        const store = await open();
        const id = runId('steal');
        const got = await store.acquireLock(runLock(id));
        if (!got.ok) throw new Error('lock held');
        expect(await store.renewLock(got.lease.lockId, 60_000)).toBe(true);
        const [held] = await store.listLocks({ scope: 'run' });
        if (!held) throw new Error('no lock listed');
        const stolen = await store.stealLock(runLock(id, 'host-2'), held);
        expect(stolen.fencingToken).toBe(got.lease.fencingToken + 1);
        expect(stolen.hostId).toBe('host-2');
        expect(await store.renewLock(got.lease.lockId, 60_000)).toBe(false);
        expect(await store.renewLock(stolen.lockId, 60_000)).toBe(true);
        const locks = await store.listLocks({ scope: 'run' });
        expect(locks.map((lock) => [lock.ownerHostId, lock.fencingToken])).toEqual([
          ['host-2', got.lease.fencingToken + 1],
        ]);
      });

      test('a steal against a row that has changed since it was read is refused', async () => {
        const store = await open();
        const id = runId('steal-race');
        const got = await store.acquireLock(runLock(id));
        if (!got.ok) throw new Error('lock held');
        const [held] = await store.listLocks({ scope: 'run' });
        if (!held) throw new Error('no lock listed');
        await store.stealLock(runLock(id, 'host-2'), held);
        await rejectsWithCode(store.stealLock(runLock(id, 'host-3'), held), 'conflict/lease-lost');
      });

      test('a lock taken again after a release gets a greater fencing token', async () => {
        const store = await open();
        const id = runId('monotonic');
        const first = await store.acquireLock(runLock(id));
        if (!first.ok) throw new Error('lock held');
        await store.releaseLock(first.lease.lockId);
        expect(await store.renewLock(first.lease.lockId, 60_000)).toBe(false);
        const second = await store.acquireLock(runLock(id, 'host-2'));
        if (!second.ok) throw new Error('lock held');
        expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
      });

      test('an expired lease is advisory: it still blocks, still renews, still fences — stealLock is the takeover', async () => {
        const store = await open();
        const id = runId('expired');
        await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));
        const got = await store.acquireLock({ ...runLock(id), ttlMs: 0 });
        if (!got.ok) throw new Error('lock held');
        const [row] = await store.listLocks({ scope: 'run' });
        // Expired by the store's own clock: no wall-clock reading is involved.
        expect(Date.parse(row?.leaseExpiresAt ?? '')).toBeLessThanOrEqual(Date.parse(row?.acquiredAt ?? ''));

        expect((await store.acquireLock(runLock(id, 'host-2'))).ok).toBe(false);
        expect(await store.renewLock(got.lease.lockId, 0)).toBe(true);
        await store.transact({ runId: id }, got.lease, (tx) => tx.patchRun(id, { title: 'still the writer' }));
        expect((await store.getRun(id))?.title).toBe('still the writer');

        const [held] = await store.listLocks({ scope: 'run' });
        if (!held) throw new Error('no run lock listed');
        const stolen = await store.stealLock(runLock(id, 'host-2'), held);
        expect(stolen.fencingToken).toBe(got.lease.fencingToken + 1);
        expect(await store.renewLock(got.lease.lockId, 60_000)).toBe(false);
      });

      test('renew pushes the expiry forward', async () => {
        const store = await open();
        const got = await store.acquireLock(projectLock('exclusive', 'host-a'));
        if (!got.ok) throw new Error('lock held');
        const [before] = await store.listLocks();
        expect(await store.renewLock(got.lease.lockId, 3_600_000)).toBe(true);
        const [after] = await store.listLocks();
        expect(Date.parse(after?.leaseExpiresAt ?? '')).toBeGreaterThan(Date.parse(before?.leaseExpiresAt ?? ''));
      });
    });

    describe('snapshots', () => {
      const snapshot = (id: RunId, atSequence: number) => ({
        runId: id,
        atSequence,
        schemaVersion: 1,
        cohorteVersion: '3.0.0',
        stateSha256: SHA_A,
        state: hooks.seal({ at: atSequence }),
      });

      test('a snapshot is written AFTER the events it covers', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'snap-after');
        await store.transact({ runId: id }, lease, (tx) => tx.appendEvents(sealed([draft(id, 'a')])));
        await expect(
          store.transact({ runId: id }, lease, (tx) => tx.writeSnapshot(snapshot(id, 2))),
        ).rejects.toBeInstanceOf(StoreUsageError);
        expect(await store.loadSnapshot(id)).toBeUndefined();
        await store.transact({ runId: id }, lease, (tx) => {
          tx.appendEvents(sealed([draft(id, 'b')]));
          tx.writeSnapshot(snapshot(id, 2));
        });
        expect(await store.loadSnapshot(id)).toEqual(snapshot(id, 2));
      });

      test('the last three are kept and the latest is loaded', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'snap-keep');
        for (let n = 1; n <= 5; n += 1) {
          await store.transact({ runId: id }, lease, (tx) => {
            tx.appendEvents(sealed([draft(id, `e${n}`)]));
            tx.writeSnapshot(snapshot(id, n));
          });
        }
        expect((await store.loadSnapshot(id))?.atSequence).toBe(5);
        expect(await hooks.snapshotCount(store, id)).toBe(3);
      });
    });

    describe('projections', () => {
      test('readRunTree returns what core wrote, and only for that run', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'tree');
        const other = await started(store, 'tree-other');
        const phase = phaseRunId('BUILD_1');
        const agent = agentId('impl_main');
        await store.transact({ runId: id }, lease, (tx) => {
          tx.putPhase({ runId: id, phaseRunId: phase, state: 'BUILD', iteration: 1, status: 'running', checks: [] });
          tx.putAgent({
            runId: id,
            agentId: agent,
            phaseRunId: phase,
            role: 'implementer',
            label: 'Implementer',
            state: 'declared',
            attempt: 1,
            incarnation: 1,
            maxAttempts: 3,
            maxIncarnations: 5,
            model: { provider: 'fake', model: 'fake-1' },
            usage: {},
            createdAt: T0,
            updatedAt: T0,
          });
          tx.putIncarnation({ runId: id, agentId: agent, incarnation: 1, attempt: 1, state: 'spawning' });
          tx.putWorktree({
            runId: id,
            slot: 'main',
            path: '/tmp/wt/main',
            baseSha: '1'.repeat(40),
            checkpointSha: '1'.repeat(40),
            state: 'ready',
          });
          tx.putApproval(approval(id, 'tree', 'grant-tree'));
          tx.setBudget({ runId: id, level: 'run', scopeId: id, consumed: { toolCalls: 1 }, limit: {}, updatedAt: T0 });
          tx.putArtifact({
            artifactId: artifactId('log'),
            runId: id,
            kind: 'log',
            path: 'artifacts/check.log',
            sha256: SHA_A,
            bytes: 10,
            createdAt: T0,
          });
          tx.putFinding({
            runId: id,
            findingId: findingId('f1'),
            phaseRunId: phase,
            severity: 'major',
            status: 'open',
            finding: hooks.seal({ title: 'missing test' }),
            createdAt: T0,
            updatedAt: T0,
          });
        });
        await store.transact({ runId: other.id }, other.lease, (tx) =>
          tx.putPhase({
            runId: other.id,
            phaseRunId: phase,
            state: 'BUILD',
            iteration: 1,
            status: 'running',
            checks: [],
          }),
        );

        const tree = await store.readRunTree(id);
        expect(tree.run.runId).toBe(id);
        expect(tree.phases.map((row) => [row.runId, row.phaseRunId])).toEqual([[id, phase]]);
        expect(tree.agents.map((row) => row.agentId)).toEqual([agent]);
        expect(tree.incarnations.map((row) => row.incarnation)).toEqual([1]);
        expect(tree.worktrees.map((row) => row.slot)).toEqual(['main']);
        expect(tree.approvals.map((row) => row.approvalId)).toEqual([approvalId('tree')]);
        expect(tree.budgets.map((row) => row.consumed)).toEqual([{ toolCalls: 1 }]);
        expect(tree.locks.map((row) => row.lockId)).toEqual([lease.lockId]);
        expect((await store.getArtifact(id, artifactId('log')))?.path).toBe('artifacts/check.log');
        expect(await store.getArtifact(other.id, artifactId('log'))).toBeUndefined();
        await expect(store.readRunTree(runId('nobody'))).rejects.toBeInstanceOf(StoreUsageError);
      });

      test('puts are upserts by primary key, and the read helpers see the writes of their own transaction', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'upsert');
        const phase = phaseRunId('BUILD_1');
        const agent = agentId('impl_main');
        const base = {
          runId: id,
          agentId: agent,
          phaseRunId: phase,
          role: 'implementer',
          label: 'Implementer',
          attempt: 1,
          incarnation: 1,
          maxAttempts: 3,
          maxIncarnations: 5,
          model: { provider: 'fake', model: 'fake-1' },
          usage: {},
          createdAt: T0,
          updatedAt: T0,
        } as const;
        const seen = await store.transact({ runId: id }, lease, (tx) => {
          tx.putAgent({ ...base, state: 'declared' });
          tx.putAgent({ ...base, state: 'planned' });
          tx.putIncarnation({ runId: id, agentId: agent, incarnation: 1, attempt: 1, state: 'spawning' });
          tx.putIncarnation({ runId: id, agentId: agent, incarnation: 1, attempt: 1, state: 'running', pid: 99 });
          tx.setBudget({ runId: id, level: 'agent', scopeId: agent, consumed: {}, limit: {}, updatedAt: T0 });
          tx.setBudget({
            runId: id,
            level: 'agent',
            scopeId: agent,
            consumed: { tokens: 5 },
            limit: {},
            updatedAt: T0,
          });
          return {
            state: tx.agent(agent)?.state,
            pid: tx.incarnation(agent, 1)?.pid,
            missing: tx.incarnation(agent, 2),
            tokens: tx.budget('agent', agent)?.consumed.tokens,
            worktree: tx.worktree('nope'),
            run: tx.run().runId,
          };
        });
        expect(seen).toEqual({
          state: 'planned',
          pid: 99,
          missing: undefined,
          tokens: 5,
          worktree: undefined,
          run: id,
        });
        const tree = await store.readRunTree(id);
        expect(tree.agents).toHaveLength(1);
        expect(tree.incarnations).toHaveLength(1);
        expect(tree.budgets).toHaveLength(1);
      });

      test('the worktree ledger: one row per path, cleared up to an effect sequence', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'ledger');
        const entry = (path: string, effectSeq: number, sha256: typeof SHA_A | null = SHA_A) => ({
          runId: id,
          slot: 'main',
          path,
          sha256,
          effectId: effectIdOf(`e${effectSeq}`),
          effectSeq,
        });
        await store.transact({ runId: id }, lease, (tx) => {
          tx.putLedger(entry('a.ts', 1));
          tx.putLedger(entry('b.ts', 2));
          tx.putLedger(entry('a.ts', 3, null));
          tx.putLedger({ ...entry('c.ts', 1), slot: 'other' });
        });
        expect((await store.readLedger(id, 'main')).map((row) => [row.path, row.sha256, row.effectSeq])).toEqual([
          ['a.ts', null, 3],
          ['b.ts', SHA_A, 2],
        ]);
        await store.transact({ runId: id }, lease, (tx) => tx.clearLedger(id, 'main', 2));
        expect((await store.readLedger(id, 'main')).map((row) => row.path)).toEqual(['a.ts']);
        expect(await store.readLedger(id, 'other')).toHaveLength(1);
      });

      test('completeEffect(post.treeDigest) lands on the worktree of the effect slot', async () => {
        const store = await open();
        const { id, lease } = await started(store, 'post');
        await store.transact({ runId: id }, lease, (tx) => {
          tx.putWorktree({
            runId: id,
            slot: 'main',
            path: '/tmp/wt/main',
            baseSha: '1'.repeat(40),
            checkpointSha: '1'.repeat(40),
            state: 'held',
          });
          const begun = tx.beginEffect(intent(id, 'tool:1', { slot: 'main' }));
          if (begun.status !== 'started') throw new Error('expected started');
          tx.completeEffect(begun.effectId, hooks.seal({}), { treeDigest: 'tree-after' });
        });
        const tree = await store.readRunTree(id);
        expect(tree.worktrees[0]?.lastTreeDigest).toBe('tree-after');
      });

      test('listRuns filters by state and paginates without overlap', async () => {
        const store = await open();
        const names = ['r1', 'r2', 'r3'];
        for (const [index, name] of names.entries()) {
          await store.transact('project', null, (tx) =>
            tx.putRun(idleRun(runId(name), { startedAt: `2026-01-0${index + 1}T00:00:00.000Z` as typeof T0 })),
          );
        }
        const { id } = await started(store, 'r4');
        const ids = async (q: Parameters<StateStore['listRuns']>[0]): Promise<string[]> =>
          (await store.listRuns(q)).map((run) => run.runId);
        expect(await ids({ states: ['BUILD'], limit: 10, offset: 0 })).toEqual([id]);
        expect(await ids({ states: ['IDLE'], limit: 2, offset: 0 })).toHaveLength(2);
        expect(await ids({ states: ['IDLE'], limit: 2, offset: 2 })).toHaveLength(1);
        expect(await ids({ limit: 10, offset: 0 })).toHaveLength(4);
        const pageOne = await ids({ states: ['IDLE'], limit: 2, offset: 0 });
        const pageTwo = await ids({ states: ['IDLE'], limit: 2, offset: 2 });
        expect(new Set([...pageOne, ...pageTwo]).size).toBe(3);
      });
    });
  });
}
