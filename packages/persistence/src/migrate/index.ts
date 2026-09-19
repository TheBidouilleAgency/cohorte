// `@cohorte/persistence/migrate` — numbered, monotonic, sha256-pinned migrations (DESIGN 2.4, ADR-0002). Synchronous,
// like `SqlDriver`: `available/check/apply` never return a promise, so `SqliteStateStore.migrate()` is the only async
// boundary. `apply()` assumes its caller (the store) already holds whatever lock the situation needs and has taken
// the backup (DESIGN 2.4 `migrate(mode)`); this module never locks or backs up on its own.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CohorteError, errorOf, type Sha256, sha256Hex, toIsoInstant } from '@cohorte/base';
import type { MigrationReport, MigrationStep, SqlDriver } from '../contract.ts';

export interface MigratorOptions {
  driver: SqlDriver;
  /** numbered, monotonic `NNNN_name.sql` files; each one is sha256-pinned once applied */
  migrationsDir: string;
  cohorteVersion: string;
}

export interface Migrator {
  /** the files on disk, in order */
  available(): MigrationStep[];
  /** refuses a gap, a renumbering, or an applied file whose sha256 changed (corruption/incompatible-schema) */
  check(): MigrationReport;
  /** one transaction per file; the caller holds the exclusive `migration` lock and has taken the backup */
  apply(): MigrationReport;
}

const FILE_PATTERN = /^(\d{4,})_([A-Za-z0-9_]+)\.sql$/;

interface AvailableFile {
  readonly id: number;
  readonly name: string;
  readonly sha256: Sha256;
  readonly filename: string;
}

function incompatible(message: string): CohorteError {
  return new CohorteError(errorOf('corruption/incompatible-schema', message));
}

/** Reads and sha-pins every `NNNN_name.sql` of `migrationsDir`, refusing a gap or a renumbering. A missing directory is zero migrations. */
function readAvailable(migrationsDir: string): AvailableFile[] {
  let names: string[];
  try {
    names = readdirSync(migrationsDir);
  } catch {
    return [];
  }
  const matched = names
    .map((name) => ({ name, match: FILE_PATTERN.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = matched.map(({ name, match }) => ({
    id: Number.parseInt(match[1] as string, 10),
    name: match[2] as string,
    filename: name,
  }));
  files.forEach((file, index) => {
    if (file.id !== index + 1) {
      throw incompatible(
        `migrations/state is not numbered monotonically from 1: ${file.filename} sits at position ${index + 1}`,
      );
    }
  });
  return files.map((file) => ({
    ...file,
    sha256: sha256Hex(readFileSync(join(migrationsDir, file.filename))),
  }));
}

function tableExists(driver: SqlDriver, name: string): boolean {
  return driver.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

interface AppliedRow {
  id: number;
  name: string;
  sha256: Sha256;
}

/** The `migrations` table itself is created by `0001_init.sql`: before that runs, "applied" is simply empty. */
function readApplied(driver: SqlDriver): AppliedRow[] {
  if (!tableExists(driver, 'migrations')) return [];
  return driver.prepare('SELECT id, name, sha256 FROM migrations ORDER BY id').all() as AppliedRow[];
}

const asStep = ({ id, name, sha256 }: { id: number; name: string; sha256: Sha256 }): MigrationStep => ({
  id,
  name,
  sha256,
});

export function createMigrator(options: MigratorOptions): Migrator {
  const { driver, migrationsDir, cohorteVersion } = options;

  function available(): MigrationStep[] {
    return readAvailable(migrationsDir).map(asStep);
  }

  function check(): MigrationReport {
    const files = readAvailable(migrationsDir);
    const applied = readApplied(driver);
    for (const row of applied) {
      const file = files.find((candidate) => candidate.id === row.id);
      if (file && file.sha256 !== row.sha256) {
        throw incompatible(
          `migration ${row.id} (${row.name}) was edited after it was applied: its sha256 no longer matches migrations/state`,
        );
      }
    }
    const current = applied.length > 0 ? Math.max(...applied.map((row) => row.id)) : 0;
    const target = files.length > 0 ? Math.max(...files.map((file) => file.id)) : 0;
    const appliedIds = new Set(applied.map((row) => row.id));
    const pending = files.filter((file) => !appliedIds.has(file.id)).map(asStep);
    return { mode: 'check', current, target, pending, applied: applied.map(asStep) };
  }

  function apply(): MigrationReport {
    const report = check();
    if (report.current > report.target) {
      throw incompatible(
        `the state database is at schema ${report.current}, newer than this build's migrations/state (target ${report.target}); run the Cohorte version that wrote it`,
      );
    }
    const files = readAvailable(migrationsDir);
    const applied: MigrationStep[] = [];
    for (const step of report.pending) {
      const file = files.find((candidate) => candidate.id === step.id);
      if (!file) throw incompatible(`migration ${step.id} vanished from migrations/state mid-apply`);
      const sql = readFileSync(join(migrationsDir, file.filename), 'utf8');
      driver.exec('BEGIN IMMEDIATE');
      try {
        driver.exec(sql);
        driver
          .prepare('INSERT INTO migrations (id, name, sha256, applied_at, cohorte_version) VALUES (?, ?, ?, ?, ?)')
          .run(file.id, file.name, file.sha256, toIsoInstant(Date.now()), cohorteVersion);
        driver.exec('COMMIT');
      } catch (error) {
        try {
          driver.exec('ROLLBACK');
        } catch {
          // the failed statement may already have forced an implicit rollback
        }
        throw error;
      }
      applied.push(asStep(file));
    }
    return { mode: 'apply', current: report.current, target: report.target, pending: [], applied };
  }

  return { available, check, apply };
}
