// U1.01: the migration runner (DESIGN 2.4 `migrate(mode)`, ADR-0002) — monotonic, sha256-pinned, backed up before
// `apply`, and refusing rather than guessing. Every scenario builds its OWN temp `migrations/state`-shaped directory;
// the real one (frozen at G0) is only ever READ, from `DEFAULT_MIGRATIONS_DIR`, never written.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CohorteError } from '@cohorte/base';
import { type StateStore, StoreUsageError } from '@cohorte/persistence/contract';
import { DEFAULT_MIGRATIONS_DIR, openSqliteStore } from '@cohorte/persistence/sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { idleRun, runId } from '../../src/conformance/fixtures.ts';

const REAL_0001 = join(DEFAULT_MIGRATIONS_DIR, '0001_init.sql');

interface Workspace {
  dir: string;
  migrationsDir: string;
  dbPath: string;
}

async function workspace(): Promise<Workspace> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cohorte-migrate-')));
  const migrationsDir = join(dir, 'migrations', 'state');
  await mkdir(migrationsDir, { recursive: true });
  return { dir, migrationsDir, dbPath: join(dir, 'cohorte.db') };
}

async function seedReal0001(migrationsDir: string): Promise<void> {
  await copyFile(REAL_0001, join(migrationsDir, '0001_init.sql'));
}

const errorCode = (thrown: unknown): string | undefined =>
  thrown instanceof CohorteError ? thrown.info.code : undefined;

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('createMigrator / SqliteStateStore.migrate (DESIGN 2.4)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  const opened: StateStore[] = [];

  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const track = (ws: Workspace): Workspace => {
    cleanups.push(() => rm(ws.dir, { recursive: true, force: true }));
    return ws;
  };
  const track2 = <T extends StateStore>(store: T): T => {
    opened.push(store);
    return store;
  };

  test('a fresh directory applies 0001 and reports schema 1', async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    const checked = await store.migrate('check');
    expect(checked).toMatchObject({ mode: 'check', current: 0, target: 1, applied: [] });
    expect(checked.pending.map((step) => step.id)).toEqual([1]);

    const applied = await store.migrate('apply');
    expect(applied).toMatchObject({ mode: 'apply', current: 0, target: 1, pending: [] });
    expect(applied.applied.map((step) => step.id)).toEqual([1]);
    expect(applied.backupPath).toBeUndefined(); // bootstrap: nothing existed to back up

    const info = await store.open();
    expect(info).toEqual({ kind: 'sqlite', schemaVersion: 1, location: ws.dbPath });
    expect(await store.migrate('check')).toMatchObject({ current: 1, target: 1, pending: [] });
  });

  test('a gap in the numbering is refused', async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    await writeFile(join(ws.migrationsDir, '0003_gap.sql'), 'CREATE TABLE gap (x INTEGER) STRICT;\n');
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    const thrown = await rejectionOf(store.migrate('check'));
    expect(thrown).toBeInstanceOf(CohorteError);
    expect(errorCode(thrown)).toBe('corruption/incompatible-schema');
  });

  test('an applied migration edited afterwards is refused (sha pin)', async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    await store.migrate('apply');
    await store.open();

    // Tamper the already-applied file in place.
    const original = await readFile(join(ws.migrationsDir, '0001_init.sql'), 'utf8');
    await writeFile(join(ws.migrationsDir, '0001_init.sql'), `${original}\n-- tampered\n`);

    const thrown = await rejectionOf(store.migrate('check'));
    expect(thrown).toBeInstanceOf(CohorteError);
    expect(errorCode(thrown)).toBe('corruption/incompatible-schema');
    expect((thrown as CohorteError).info.message).toMatch(/edited/);

    // And open() refuses the same way, on a fresh store instance over the same (untouched) database file.
    const reopened = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    const openThrown = await rejectionOf(reopened.open());
    expect(errorCode(openThrown)).toBe('corruption/incompatible-schema');
  });

  test('a synthetic 0002 applies after a backup, once the project already has schema 1', async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    await store.migrate('apply');
    await store.open();
    const id = runId('pre-0002');
    await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));

    await writeFile(
      join(ws.migrationsDir, '0002_probe.sql'),
      "CREATE TABLE probe_0002 (id TEXT PRIMARY KEY, note TEXT NOT NULL) STRICT;\nINSERT INTO probe_0002 (id, note) VALUES ('seed', 'from 0002');\n",
    );

    const report = await store.migrate('apply');
    expect(report).toMatchObject({ mode: 'apply', current: 1, target: 2 });
    expect(report.applied.map((step) => step.id)).toEqual([2]);
    expect(report.backupPath).toBeDefined();
    const backupExists = await readFile(report.backupPath as string).then(
      () => true,
      () => false,
    );
    expect(backupExists).toBe(true);

    // The backup was taken BEFORE 0002 ran: it must not contain the probe table.
    const backupStore = openSqliteStore({ path: report.backupPath as string, migrationsDir: ws.migrationsDir });
    expect(await backupStore.migrate('check')).toMatchObject({ current: 1 });
    await backupStore.close();

    expect(await store.migrate('check')).toMatchObject({ current: 2, target: 2, pending: [] });
    // The pre-existing run survived the migration untouched.
    expect((await store.getRun(id))?.runId).toBe(id);
  });

  test('a schema newer than this build knows refuses with instruction; run rows are untouched', async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    const ahead = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    await ahead.migrate('apply');
    await ahead.open();
    await writeFile(
      join(ws.migrationsDir, '0002_probe.sql'),
      'CREATE TABLE probe_0002 (id TEXT PRIMARY KEY) STRICT;\n',
    );
    await ahead.migrate('apply');
    const id = runId('ahead');
    await ahead.transact('project', null, (tx) => tx.putRun(idleRun(id)));
    const before = await ahead.getRun(id);

    // A build whose embedded migrations/state only goes up to 0001 (an older Cohorte) opens the SAME database.
    const olderMigrationsDir = join(ws.dir, 'migrations-older', 'state');
    await mkdir(olderMigrationsDir, { recursive: true });
    await seedReal0001(olderMigrationsDir);
    const older = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: olderMigrationsDir }));

    const openThrown = await rejectionOf(older.open());
    expect(errorCode(openThrown)).toBe('corruption/incompatible-schema');
    const applyThrown = await rejectionOf(older.migrate('apply'));
    expect(errorCode(applyThrown)).toBe('corruption/incompatible-schema');

    expect(await ahead.getRun(id)).toEqual(before);
  });

  test('available() lists the files sha-pinned, in order', async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    const report = await store.migrate('check');
    const bytes = await readFile(join(ws.migrationsDir, '0001_init.sql'));
    const expectedSha = createHash('sha256').update(bytes).digest('hex');
    expect(report.pending).toEqual([{ id: 1, name: 'init', sha256: expectedSha }]);
  });

  // DESIGN 2.4 / ADR-0002: "observers are lock-free readers and are SIGKILL-safe", so a second connection parked in a
  // read transaction is the NORMAL state of the file — and it is exactly what blocks `PRAGMA wal_checkpoint(TRUNCATE)`.
  // A backup that is only the main file is then a truncated, unopenable database, and `migrate --apply` would mutate
  // the schema with no usable safety net at all.
  test('a backup taken while a lock-free reader is parked on the file is a readable database', async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    await store.migrate('apply');
    await store.open();
    const ids = ['b1', 'b2', 'b3', 'b4'].map((name) => runId(name));
    for (const id of ids) await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));

    const reader = new DatabaseSync(ws.dbPath, { open: true, timeout: 5000 });
    reader.exec('BEGIN');
    expect(reader.prepare('SELECT run_id FROM runs').all()).toHaveLength(ids.length);
    try {
      const backupPath = join(ws.dir, 'under-reader.db');
      await store.backup(backupPath);
      const copy = new DatabaseSync(backupPath, { open: true, timeout: 5000 });
      try {
        const rows = copy.prepare('SELECT run_id FROM runs ORDER BY run_id').all() as Array<{ run_id: string }>;
        expect(rows.map((row) => row.run_id)).toEqual([...ids].sort());
      } finally {
        copy.close();
      }
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
  });

  test("migrate('apply') under a parked reader leaves a backup that still opens and holds every run", async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    await store.migrate('apply');
    await store.open();
    const id = runId('survives-0002');
    await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));
    await writeFile(
      join(ws.migrationsDir, '0002_probe.sql'),
      'CREATE TABLE probe_0002 (id TEXT PRIMARY KEY) STRICT;\n',
    );

    const reader = new DatabaseSync(ws.dbPath, { open: true, timeout: 5000 });
    reader.exec('BEGIN');
    reader.prepare('SELECT run_id FROM runs').all();
    let backupPath: string | undefined;
    try {
      backupPath = (await store.migrate('apply')).backupPath;
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
    expect(backupPath).toBeDefined();
    const copy = new DatabaseSync(backupPath as string, { open: true, timeout: 5000 });
    try {
      const rows = copy.prepare('SELECT run_id FROM runs').all() as Array<{ run_id: string }>;
      expect(rows.map((row) => row.run_id)).toEqual([id]);
      // Taken BEFORE 0002 ran.
      expect(copy.prepare("SELECT name FROM sqlite_master WHERE name='probe_0002'").all()).toEqual([]);
    } finally {
      copy.close();
    }
  });

  test('backup refuses to overwrite an existing file rather than producing a half-written one', async () => {
    const ws = track(await workspace());
    await seedReal0001(ws.migrationsDir);
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    await store.migrate('apply');
    await store.open();
    const backupPath = join(ws.dir, 'twice.db');
    await store.backup(backupPath);
    const thrown = await rejectionOf(store.backup(backupPath));
    expect(thrown).toBeInstanceOf(StoreUsageError);
  });

  test('a missing migrations directory is zero migrations, not an error', async () => {
    const ws = track(await workspace());
    await rm(ws.migrationsDir, { recursive: true, force: true });
    const store = track2(openSqliteStore({ path: ws.dbPath, migrationsDir: ws.migrationsDir }));
    expect(await store.migrate('check')).toMatchObject({ current: 0, target: 0, pending: [] });
  });
});
