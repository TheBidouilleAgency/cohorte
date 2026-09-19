// Test-only support: a temp-file SQLite store per call, and the conformance hooks that damage/inspect it BEHIND the
// contract (never collected by vitest itself — no `.test.ts`/`.itest.ts` suffix).
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunId } from '@cohorte/base';
import type { ChainDamage, StateStoreConformanceHooks } from '@cohorte/persistence/conformance';
import type { StateStore } from '@cohorte/persistence/contract';
import { openSqliteStore, type SqliteStoreOptions } from '@cohorte/persistence/sqlite';
import { sealForTest } from '@cohorte/testkit/store-factory';

/** Every store this module opened, so a hook can find the file behind a `StateStore` it did not create. */
const pathOf = new WeakMap<StateStore, string>();

export interface OpenedSqliteStore {
  store: StateStore;
  dbPath: string;
  dir: string;
}

/** A migrated, open store in a fresh temp directory. `store.close()` also removes the directory. */
export async function openTempSqliteStore(options: Partial<SqliteStoreOptions> = {}): Promise<OpenedSqliteStore> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cohorte-sqlite-')));
  const dbPath = join(dir, 'cohorte.db');
  const store = openSqliteStore({ path: dbPath, ...options });
  await store.migrate('apply');
  await store.open();
  pathOf.set(store, dbPath);
  const close = store.close.bind(store);
  store.close = async (): Promise<void> => {
    await close();
    await rm(dir, { recursive: true, force: true });
  };
  return { store, dbPath, dir };
}

/** `stateStoreConformance`'s factory: a fresh temp-file store per test. */
export function sqliteStoreFactory(): () => Promise<StateStore> {
  return async () => (await openTempSqliteStore()).store;
}

/** The db path of a store `openTempSqliteStore`/`sqliteStoreFactory` produced. */
export function pathOfStore(store: StateStore): string {
  const found = pathOf.get(store);
  if (!found) throw new Error('pathOfStore: this store was not opened by openTempSqliteStore/sqliteStoreFactory');
  return found;
}

function withRawConnection<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { open: true, timeout: 5000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Verbatim from `migrations/state/0001_init.sql`: what `damage()` drops to bypass the store's own protections, and restores before returning. */
const APPEND_ONLY_TRIGGERS = `
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events WHEN (SELECT purgeable FROM runs WHERE run_id = OLD.run_id) = 0
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

function damageRow(db: DatabaseSync, id: RunId, damage: ChainDamage): boolean {
  if (damage.kind === 'remove') {
    const result = db.prepare('DELETE FROM events WHERE run_id=? AND sequence=?').run(id, damage.sequence);
    return Number(result.changes) > 0;
  }
  if (damage.kind === 'duplicate') {
    const row = db.prepare('SELECT * FROM events WHERE run_id=? AND sequence=?').get(id, damage.sequence) as
      | Record<string, unknown>
      | undefined;
    if (!row) return false;
    try {
      db.prepare(
        `INSERT INTO events (run_id, sequence, event_id, type, timestamp, source, phase_run_id, agent_id,
         causation_id, severity, summary, envelope, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.run_id as string,
        row.sequence as number,
        `${row.event_id as string}-dup`,
        row.type as string,
        row.timestamp as string,
        row.source as string,
        (row.phase_run_id as string | null) ?? null,
        (row.agent_id as string | null) ?? null,
        (row.causation_id as string | null) ?? null,
        row.severity as string,
        row.summary as string,
        row.envelope as string,
        row.prev_hash as string,
        row.hash as string,
      );
      return true;
    } catch {
      // PRIMARY KEY (run_id, sequence): a second row at the same sequence is not representable.
      return false;
    }
  }
  // 'rewrite': the hash is left untouched, only the envelope changes underneath it.
  const row = db.prepare('SELECT envelope FROM events WHERE run_id=? AND sequence=?').get(id, damage.sequence) as
    | { envelope: string }
    | undefined;
  if (!row) return false;
  const rewritten = row.envelope.replace('"summary":"', '"summary":"rewritten ');
  db.prepare('UPDATE events SET envelope=? WHERE run_id=? AND sequence=?').run(rewritten, id, damage.sequence);
  return true;
}

/** The `StateStoreConformanceHooks` for `openTempSqliteStore`/`sqliteStoreFactory` stores. */
export function sqliteStoreConformanceHooks(label = 'sqlite'): StateStoreConformanceHooks {
  return {
    label,
    seal: sealForTest,
    damage: async (store, id, damage) =>
      withRawConnection(pathOfStore(store), (db) => {
        db.exec('DROP TRIGGER events_no_update');
        db.exec('DROP TRIGGER events_no_delete');
        try {
          return damageRow(db, id, damage);
        } finally {
          db.exec(APPEND_ONLY_TRIGGERS);
        }
      }),
    rewriteEvent: async (store, id, sequence) => {
      withRawConnection(pathOfStore(store), (db) => {
        db.exec('PRAGMA busy_timeout=5000');
        db.prepare("UPDATE events SET summary='tampered' WHERE run_id=? AND sequence=?").run(id, sequence);
      });
    },
    purgeEvents: async (store, id) => {
      withRawConnection(pathOfStore(store), (db) => {
        db.exec('PRAGMA busy_timeout=5000');
        db.prepare('DELETE FROM events WHERE run_id=?').run(id);
      });
    },
    snapshotCount: async (store, id) =>
      withRawConnection(pathOfStore(store), (db) => {
        const row = db.prepare('SELECT COUNT(*) AS c FROM snapshots WHERE run_id=?').get(id) as { c: number };
        return row.c;
      }),
  };
}
