// Configuration migration runner (PLAN U2.09).
// V3.0 has no historical config transform yet: schema version 1 is the first
// published configuration shape. The runner is nevertheless strict so a
// future incompatible document cannot silently enter the loader.
import type { JsonValue } from '@cohorte/base';

export interface ConfigMigrationResult {
  document: JsonValue;
  fromVersion: number;
  toVersion: number;
  /** ids of the migrations that ran, in order */
  applied: string[];
}

export function migrateConfig(document: JsonValue): ConfigMigrationResult {
  if (document === null || Array.isArray(document) || typeof document !== 'object') {
    throw new Error('configuration/migration-required: configuration document must be an object with schemaVersion: 1');
  }

  const version = document.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error('configuration/migration-required: configuration document has no integer schemaVersion');
  }

  if (version !== 1) {
    throw new Error(
      `configuration/migration-required: configuration schemaVersion ${version} is incompatible; back up the file and run "cohorte migrate --apply"`,
    );
  }

  return {
    // The migration API promises a document, but must not give callers a
    // mutable alias to their input while later migrations are added.
    document: structuredClone(document),
    fromVersion: 1,
    toVersion: 1,
    applied: [],
  };
}
