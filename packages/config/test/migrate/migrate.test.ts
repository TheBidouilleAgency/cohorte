import { describe, expect, test } from 'vitest';
import { migrateConfig } from '../../src/migrate/index.ts';

describe('configuration migrations', () => {
  test('accepts the first published schema without claiming a migration', () => {
    const input = { schemaVersion: 1, project: { id: 'project' } } as const;
    const result = migrateConfig(input);

    expect(result).toEqual({
      document: input,
      fromVersion: 1,
      toVersion: 1,
      applied: [],
    });
    expect(result.document).not.toBe(input);
  });

  test('does not mutate the source document', () => {
    const input = { schemaVersion: 1, nested: { value: 'before' } } as const;
    const result = migrateConfig(input);

    expect(result.document).not.toBe(input);
    if (result.document !== null && !Array.isArray(result.document) && typeof result.document === 'object') {
      result.document.nested = { value: 'after' };
    }
    expect(input.nested.value).toBe('before');
  });

  test.for([
    { name: 'a scalar', value: null },
    { name: 'an array', value: [] },
    { name: 'a missing version', value: {} },
    { name: 'a fractional version', value: { schemaVersion: 1.5 } },
    { name: 'an older version', value: { schemaVersion: 0 } },
    { name: 'a newer version', value: { schemaVersion: 2 } },
  ])('refuses $name', ({ value }) => {
    expect(() => migrateConfig(value)).toThrow(/configuration\/migration-required/);
  });

  test('includes the explicit command for an incompatible version', () => {
    expect(() => migrateConfig({ schemaVersion: 2 })).toThrow('cohorte migrate --apply');
  });
});
