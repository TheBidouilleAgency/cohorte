// U1.01: the Wave-0 conformance suite, unchanged, green on a real temp-file `node:sqlite` store (DESIGN 2.4,
// ADR-0002) — plus the two SQLite-specific properties the plan calls out that the conformance suite (store-agnostic
// by construction) cannot: a lease stolen from ANOTHER connection is still refused, and a reader never blocks a
// writer even when it is SIGKILLed mid-read.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunId } from '@cohorte/base';
import { stateStoreConformance } from '@cohorte/persistence/conformance';
import { type LeaseToken, type SqlDriver, type StateStore, StoreUsageError } from '@cohorte/persistence/contract';
import { openSqliteStore } from '@cohorte/persistence/sqlite';
import { sealForTest } from '@cohorte/testkit/store-factory';
import { afterEach, describe, expect, test } from 'vitest';
import { draft, HOST_COLUMNS, idleRun, runId, runLock } from '../../src/conformance/fixtures.ts';
import { createNodeSqliteDriver } from '../../src/sqlite/driver.ts';
import { openTempSqliteStore, sqliteStoreConformanceHooks, sqliteStoreFactory } from './support/factory.ts';

const READER_HOLD = fileURLToPath(new URL('./support/reader-hold.ts', import.meta.url));

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

async function startedRun(store: StateStore, name: string): Promise<{ id: RunId; lease: LeaseToken }> {
  const id = runId(name);
  await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));
  const granted = await store.acquireLock(runLock(id));
  if (!granted.ok) throw new Error(`lock of ${id} already held`);
  return { id, lease: granted.lease };
}

stateStoreConformance(sqliteStoreFactory(), sqliteStoreConformanceHooks());

describe('SQLite-specific: fencing and readers across real connections', () => {
  const opened: Array<{ store: { close(): Promise<void> } }> = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const { store } of opened.splice(0)) await store.close();
  });

  test('a lease stolen through a SECOND connection to the same file is refused on the first', async () => {
    const a = await openTempSqliteStore();
    opened.push(a);
    const id = runId('zombie');
    await a.store.transact('project', null, (tx) => tx.putRun(idleRun(id)));
    const grantedToA = await a.store.acquireLock(runLock(id, 'host-a'));
    if (!grantedToA.ok) throw new Error('lock held');
    await a.store.transact({ runId: id }, grantedToA.lease, (tx) =>
      tx.patchRun(id, { state: 'BUILD', ...HOST_COLUMNS }),
    );

    // Host B: a SEPARATE `SqliteStateStore` instance over the SAME file, simulating a second process taking over.
    const b = openSqliteStore({ path: a.dbPath });
    await b.open();
    const [held] = await b.listLocks({ scope: 'run' });
    if (!held) throw new Error('no run lock listed');
    const stolen = await b.stealLock(runLock(id, 'host-b'), held);

    // Host A, still holding its now-stale lease, tries to write: refused, nothing written.
    const thrown: unknown = await a.store
      .transact({ runId: id }, grantedToA.lease, (tx) => tx.patchRun(id, { title: 'from the zombie host-a' }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((thrown as { info?: { code?: string } } | undefined)?.info?.code).toBe('conflict/lease-lost');

    // Host B, with the fresh lease, succeeds.
    await b.transact({ runId: id }, stolen, (tx) => tx.patchRun(id, { title: 'from host-b' }));
    expect((await a.store.getRun(id))?.title).toBe('from host-b');
    await b.close();
  });

  test('SIGKILL of a reader mid-read never blocks the writer', async () => {
    const { store, dbPath } = await openTempSqliteStore();
    opened.push({ store });
    const id = runId('sigkill-reader');
    await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));
    const granted = await store.acquireLock(runLock(id));
    if (!granted.ok) throw new Error('lock held');
    await store.transact({ runId: id }, granted.lease, (tx) => tx.patchRun(id, { state: 'BUILD', ...HOST_COLUMNS }));

    const child = spawn(process.execPath, [READER_HOLD, dbPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let buffered = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        if (buffered.includes('ready')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`reader-hold exited early with code ${code}`)));
    });
    child.kill('SIGKILL');

    const startedAt = Date.now();
    await store.transact({ runId: id }, granted.lease, (tx) => tx.appendEvents([]));
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  // I6 ("every write transaction is fenced") + DESIGN 2.4 ("body MUST be synchronous (a returned thenable is
  // rejected)"): rejecting the caller is only half of it. The continuation of the async body still holds the `StoreTx`,
  // and on SQLite that object writes straight to the connection — after the ROLLBACK, in autocommit, with no
  // `BEGIN IMMEDIATE` and no fencing assertion. The tx must be DEAD once `transact` returns.
  test('the StoreTx of a rejected async body is dead: nothing it writes after the await reaches the database', async () => {
    const a = await openTempSqliteStore();
    opened.push(a);
    const { id, lease } = await startedRun(a.store, 'leaky-async-body');
    const before = await a.store.getRun(id);

    let afterAwait: Promise<void> | undefined;
    const thrown = await rejectionOf(
      a.store.transact({ runId: id }, lease, (tx) => {
        tx.appendEvents([sealForTest(draft(id, 'before-await'))]);
        afterAwait = (async (): Promise<void> => {
          await Promise.resolve();
          tx.appendEvents([sealForTest(draft(id, 'after-await'))]);
          tx.patchRun(id, { title: 'leaked from an async body' });
        })();
        return afterAwait;
      }),
    );
    expect(thrown).toBeInstanceOf(StoreUsageError);
    expect(await rejectionOf(afterAwait as Promise<void>)).toBeInstanceOf(StoreUsageError);

    expect(await a.store.getRun(id)).toEqual(before);
    expect(await a.store.readEvents(id, { afterSequence: 0, limit: 10 })).toEqual([]);
    expect(await a.store.verifyChain(id)).toEqual({ ok: true, events: 0, anchors: 0 });
  });

  test('a committed StoreTx is dead too: reusing it after transact() resolved is a usage error', async () => {
    const a = await openTempSqliteStore();
    opened.push(a);
    const { id, lease } = await startedRun(a.store, 'escaped-tx');
    const escaped = await a.store.transact({ runId: id }, lease, (tx) => tx);
    expect(() => escaped.patchRun(id, { title: 'after the commit' })).toThrow(StoreUsageError);
    expect(() => escaped.run()).toThrow(StoreUsageError);
    expect((await a.store.getRun(id))?.title).toBe(idleRun(id).title);
  });

  // DESIGN 2.4 `open()`: "refuses rather than guessing; never auto-migrates". A read that materialises an empty
  // database (and a `-wal`/`-shm` beside it) as a side effect is the opposite of that.
  test('a read on a store that was never opened is refused and creates no file', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cohorte-unopened-')));
    try {
      const store = openSqliteStore({ path: join(dir, 'cohorte.db') });
      expect(await rejectionOf(store.getRun(runId('never')))).toBeInstanceOf(StoreUsageError);
      expect(await rejectionOf(store.listRuns({ limit: 10, offset: 0 }))).toBeInstanceOf(StoreUsageError);
      expect(await rejectionOf(store.listLocks())).toBeInstanceOf(StoreUsageError);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // `node:sqlite` reports EVERY constraint failure as `ERR_SQLITE_ERROR`. Reading that one code as "the eventId
  // already exists" / "duplicate transition" turns a NOT NULL, CHECK, foreign-key or append-only-trigger failure into
  // a benign-looking no-op at the exact layer whose job is to refuse rather than guess.
  test('a constraint failure that is not a uniqueness violation is rethrown unchanged', async () => {
    const constraint = Object.assign(new Error('NOT NULL constraint failed: events.summary'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 1299,
    });
    let armed = false;
    const driver = (path: string): SqlDriver => {
      const inner = createNodeSqliteDriver(path);
      return {
        exec: (sql) => inner.exec(sql),
        prepare: (sql) => {
          const statement = inner.prepare(sql);
          return {
            run: (...parameters) => {
              if (armed && sql.startsWith('INSERT INTO events')) throw constraint;
              return statement.run(...parameters);
            },
            get: (...parameters) => statement.get(...parameters),
            all: (...parameters) => statement.all(...parameters),
          };
        },
        close: () => inner.close(),
      };
    };

    const a = await openTempSqliteStore({ driver });
    opened.push(a);
    const { id, lease } = await startedRun(a.store, 'not-a-duplicate');
    armed = true;
    const thrown = await rejectionOf(
      a.store.transact({ runId: id }, lease, (tx) => tx.appendEvents([sealForTest(draft(id, 'boom'))])),
    );
    expect(thrown).toBe(constraint);
    expect(thrown).not.toBeInstanceOf(StoreUsageError);
  });
});
