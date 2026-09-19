// Generic row <-> record marshalling shared by every table (DESIGN 2.4). `TABLE_COLUMNS` (records.ts) is the single
// source of the column<->key map; a `*_json` column is JSON, one of `BOOLEAN_COLUMNS` is a 0/1 INTEGER, everything
// else is copied through. Keeping this generic — instead of one hand-written mapper per table — is what makes the
// eighteen tables of 0001_init.sql tractable in one unit; nothing here decides the SCHEMA, only how a JS record
// becomes SQL params and back (records.ts / 0001_init.sql stay the source of truth, proved by the DDL parity test).

import type { SqlDriver } from '../contract.ts';
import { TABLE_COLUMNS, type TableName } from '../contract.ts';

export type Row = Record<string, unknown>;

const JSON_SUFFIX = '_json';
/** The only columns whose SQL type is `INTEGER CHECK (.. IN (0,1))` standing for a TypeScript `boolean`. */
const BOOLEAN_COLUMNS = new Set(['cancel_requested', 'pause_requested', 'purgeable']);
/**
 * The only column whose record type is `X | null` rather than optional (`worktree_ledger.sha256`: `null` MEANS
 * "deleted", a fact distinct from "not recorded" — records.ts `LedgerEntry.sha256`). Every other SQL `NULL` becomes
 * an absent key; this one becomes an explicit `null`, in both directions.
 */
const NULLABLE_COLUMNS = new Set(['worktree_ledger.sha256']);

const columnsOf = (table: TableName): ReadonlyArray<[string, string]> => Object.entries(TABLE_COLUMNS[table]);

/** Every column name of a table, in the order `TABLE_COLUMNS` declares them (the order every generated SQL string uses). */
export function columnNamesOf(table: TableName): readonly string[] {
  return columnsOf(table).map(([column]) => column);
}

/** A plain record -> a row of SQL parameters: `undefined` -> `null`, a JSON column stringified, a boolean 0/1. */
export function toRow(table: TableName, record: Row): Row {
  const row: Row = {};
  for (const [column, key] of columnsOf(table)) {
    const value = record[key];
    if (NULLABLE_COLUMNS.has(`${table}.${column}`)) row[column] = value ?? null;
    else if (column.endsWith(JSON_SUFFIX)) row[column] = value === undefined ? null : JSON.stringify(value);
    else if (BOOLEAN_COLUMNS.has(column)) row[column] = value ? 1 : 0;
    else row[column] = value === undefined ? null : value;
  }
  return row;
}

/**
 * A `node:sqlite` row -> a plain record: a SQL `NULL` becomes an ABSENT key (exactOptionalPropertyTypes), never
 * `undefined`. `T` defaults to the untyped `Row`; every call site that knows the record shape casts once here rather
 * than at each use (the row really is that record — `records.ts` and 0001_init.sql are proved column-for-column
 * equal by the DDL parity test — so this is a shape assertion, not a lie).
 */
export function fromRow<T = Row>(table: TableName, row: Row): T {
  const record: Row = {};
  for (const [column, key] of columnsOf(table)) {
    const value = row[column];
    if (NULLABLE_COLUMNS.has(`${table}.${column}`)) {
      record[key] = value === undefined ? null : value;
      continue;
    }
    if (value === null || value === undefined) continue;
    if (column.endsWith(JSON_SUFFIX)) record[key] = JSON.parse(value as string);
    else if (BOOLEAN_COLUMNS.has(column)) record[key] = Boolean(value);
    else record[key] = value;
  }
  return record as unknown as T;
}

/** `INSERT INTO <table> (...) VALUES (...)`, every column of the table, in `TABLE_COLUMNS` order. */
export function insertRow(driver: SqlDriver, table: TableName, record: Row): void {
  const row = toRow(table, record);
  const columns = columnNamesOf(table);
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  driver.prepare(sql).run(...columns.map((column) => row[column]));
}

/**
 * `INSERT ... ON CONFLICT(<pk>) DO UPDATE SET <every other column> = excluded.<column>`: the "puts are upserts by
 * primary key" contract (2.4) for every table whose record is a plain replace-by-key (phases, agents, worktrees, ...).
 */
export function upsertRow(driver: SqlDriver, table: TableName, pk: readonly string[], record: Row): void {
  const row = toRow(table, record);
  const columns = columnNamesOf(table);
  const updates = columns.filter((column) => !pk.includes(column)).map((column) => `${column}=excluded.${column}`);
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
    ON CONFLICT(${pk.join(',')}) DO UPDATE SET ${updates.join(',')}`;
  driver.prepare(sql).run(...columns.map((column) => row[column]));
}

/** One row by its (possibly composite) primary key, or `undefined`. */
export function getRow<T = Row>(
  driver: SqlDriver,
  table: TableName,
  pk: readonly string[],
  values: readonly unknown[],
): T | undefined {
  const sql = `SELECT * FROM ${table} WHERE ${pk.map((column) => `${column}=?`).join(' AND ')}`;
  const row = driver.prepare(sql).get(...values) as Row | undefined;
  return row && fromRow<T>(table, row);
}
