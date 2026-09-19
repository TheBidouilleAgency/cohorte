// The default `SqlDriver` over `node:sqlite` (ADR-0002). Kept narrow on purpose (DESIGN 2.4 "Location" + toolchain
// understanding §2): everything above this file talks to `SqlDriver` only, so `better-sqlite3` is a drop-in.

import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { SqlDriver } from '../contract.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo root>/migrations/state`, the embedded default (F-2 / DESIGN 2.4 DDL). Four levels up from `src/sqlite/`. */
export const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', '..', '..', '..', 'migrations', 'state');

/**
 * Opens `path` (or `:memory:`) with the pragmas DESIGN 2.4 "Location" names: `journal_mode=WAL synchronous=FULL
 * foreign_keys=ON trusted_schema=OFF busy_timeout=5000`, plus `enableDefensive(true)`. Writers always `BEGIN
 * IMMEDIATE` (asserted by the caller, not here: this driver only executes what it is given).
 */
export function createNodeSqliteDriver(path: string): SqlDriver {
  const db = new DatabaseSync(path, { open: true, enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=FULL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA trusted_schema=OFF');
  db.exec('PRAGMA busy_timeout=5000');
  db.enableDefensive(true);
  return {
    exec: (sql: string): void => {
      db.exec(sql);
    },
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return {
        run: (...parameters: unknown[]) => statement.run(...(parameters as never[])),
        get: (...parameters: unknown[]) => statement.get(...(parameters as never[])),
        all: (...parameters: unknown[]) => statement.all(...(parameters as never[])),
      };
    },
    close: (): void => {
      db.close();
    },
  };
}
