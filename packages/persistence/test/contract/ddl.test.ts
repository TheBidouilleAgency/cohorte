import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { TABLE_COLUMNS, TABLE_NAMES } from '@cohorte/persistence/contract';
import { test as base, describe, expect } from 'vitest';

const DDL = readFileSync(new URL('../../../../migrations/state/0001_init.sql', import.meta.url), 'utf8');

const test = base.extend<{ db: DatabaseSync }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest requires the destructuring form
  db: async ({}, use) => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(DDL);
    await use(db);
    db.close();
  },
});

const RUN_COLUMNS =
  'run_id, profile, table_version, spec_id, spec_sha256, title, state, pinned_install_dir, base_branch, schema_version, cohorte_version, started_at, updated_at';
const insertIdleRun = (db: DatabaseSync, id: string): void => {
  db.prepare(
    `INSERT INTO runs (${RUN_COLUMNS}) VALUES (?, 'feature', 1, 'spec-29', 'aa', 't', 'IDLE', '/opt', 'main', 1, '3.0.0', 'now', 'now')`,
  ).run(id);
};
const HOST_COLUMNS_SET =
  "snapshot_digest = 'd', runtime_pin_json = '{}', plan_json = '{}', base_sha = 's', integration_branch = 'b', zones_json = '[]'";
const insertEvent = (db: DatabaseSync, id: string, sequence: number): void => {
  db.prepare(
    "INSERT INTO events (run_id, sequence, event_id, type, timestamp, source, severity, summary, envelope, prev_hash, hash) VALUES (?, ?, ?, 'check.started', 'now', 'cohorte', 'info', 's', '{}', '', 'h')",
  ).run(id, sequence, `evt_${id}_${sequence}`);
};

describe('migrations/state/0001_init.sql', () => {
  test('applies on an in-memory node:sqlite and leaves foreign_key_check clean', ({ db }) => {
    insertIdleRun(db, 'run_a');
    insertEvent(db, 'run_a', 1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  test('has exactly the 18 tables of DESIGN 2.4, every one STRICT', ({ db }) => {
    const tables = db
      .prepare(
        "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    expect(tables.map((row) => row.name).sort()).toEqual([...TABLE_NAMES].sort());
    expect(TABLE_NAMES).toHaveLength(18);
    expect(tables.filter((row) => row.strict !== 1)).toEqual([]);
  });

  test('spec-20 minimum concepts all exist as tables', ({ db }) => {
    const names = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const concept of [
      'runs',
      'phases',
      'agents',
      'events',
      'artifacts',
      'approvals',
      'budgets',
      'locks',
      'migrations',
    ]) {
      expect(names).toContain(concept);
    }
  });

  test.for(TABLE_NAMES)('columns of %s == keys of its record type', (table, { db }) => {
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map((row) => row.name);
    expect(columns.sort()).toEqual(Object.keys(TABLE_COLUMNS[table]).sort());
    // One key per column: two columns can never feed the same record key.
    const keys = Object.values(TABLE_COLUMNS[table]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every *_json column refuses text that is not JSON', ({ db }) => {
    insertIdleRun(db, 'run_a');
    expect(() => db.exec("UPDATE runs SET stop_json = 'not json' WHERE run_id = 'run_a'")).toThrow(/CHECK/);
    const jsonColumns = TABLE_NAMES.flatMap((table) =>
      Object.keys(TABLE_COLUMNS[table])
        .filter((column) => column.endsWith('_json') || column === 'envelope')
        .map((column) => ({ table, column })),
    );
    expect(jsonColumns.length).toBeGreaterThan(20);
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all();
    for (const { table, column } of jsonColumns) {
      const sql = String(schema.find((row) => row.name === table)?.sql);
      expect(sql, `${table}.${column}`).toMatch(new RegExp(`json_valid\\(${column}\\)`));
    }
  });

  test('UPDATE events always aborts; DELETE events aborts unless runs.purgeable', ({ db }) => {
    insertIdleRun(db, 'run_a');
    insertEvent(db, 'run_a', 1);
    expect(() => db.exec("UPDATE events SET summary = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/);
    db.exec("UPDATE runs SET purgeable = 1 WHERE run_id = 'run_a'");
    expect(() => db.exec("UPDATE events SET summary = 'x'")).toThrow(/append-only/);
    db.exec('DELETE FROM events');
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  test('a run leaves IDLE | CANCELLED | FAILED only with the six host-computed columns', ({ db }) => {
    insertIdleRun(db, 'run_a');
    expect(() => db.exec("UPDATE runs SET state = 'PREFLIGHT' WHERE run_id = 'run_a'")).toThrow(/CHECK/);
    db.exec("UPDATE runs SET state = 'CANCELLED' WHERE run_id = 'run_a'");
    db.exec("UPDATE runs SET state = 'FAILED' WHERE run_id = 'run_a'");
    for (const missing of [
      'snapshot_digest',
      'runtime_pin_json',
      'plan_json',
      'base_sha',
      'integration_branch',
      'zones_json',
    ]) {
      const partial = HOST_COLUMNS_SET.split(', ')
        .filter((assignment) => !assignment.startsWith(missing))
        .join(', ');
      expect(() => db.exec(`UPDATE runs SET state = 'PREFLIGHT', ${partial} WHERE run_id = 'run_a'`), missing).toThrow(
        /CHECK/,
      );
    }
    db.exec(`UPDATE runs SET state = 'PREFLIGHT', ${HOST_COLUMNS_SET} WHERE run_id = 'run_a'`);
    expect(db.prepare("SELECT state FROM runs WHERE run_id = 'run_a'").get()).toEqual({ state: 'PREFLIGHT' });
  });

  test('profile is not constrained in SQL; pinned_install_dir is mandatory from the first byte', ({ db }) => {
    insertIdleRun(db, 'run_a');
    db.exec("UPDATE runs SET profile = 'a-fourth-profile' WHERE run_id = 'run_a'");
    expect(() => db.exec("UPDATE runs SET pinned_install_dir = NULL WHERE run_id = 'run_a'")).toThrow(/NOT NULL/);
  });

  test('idempotency keys are UNIQUE per run; open effects have their partial index', ({ db }) => {
    insertIdleRun(db, 'run_a');
    const effect = db.prepare(
      "INSERT INTO effects (effect_id, run_id, idempotency_key, kind, replay_class, state, request_json, verify_json, fencing_token, intent_seq, created_at, updated_at) VALUES (?, 'run_a', ?, 'tool.read', 'idempotent', 'intent', '{}', '{}', 1, 0, 'now', 'now')",
    );
    effect.run('eff_1', 'k1');
    expect(() => effect.run('eff_2', 'k1')).toThrow(/UNIQUE/);
    const index = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'effects_open'").get();
    expect(String(index?.sql)).toMatch(/WHERE state IN \('intent','in-doubt'\)/);
    for (const table of ['transitions', 'approvals']) {
      const sql = String(db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(table)?.sql);
      expect(sql, table).toMatch(/UNIQUE \(run_id, idempotency_key\)/);
    }
  });

  test('events reference their run', ({ db }) => {
    expect(() => insertEvent(db, 'run_missing', 1)).toThrow(/FOREIGN KEY/);
  });
});
