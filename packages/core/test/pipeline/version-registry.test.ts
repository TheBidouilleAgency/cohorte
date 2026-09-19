// DESIGN 2.5.1 "Versioning" — "resuming a run whose table version is not shipped -> stop `runtime-incompatible`
// (never re-interpreted)". `resolveTable(profile, tableVersion)` is the version registry lookup.
import { describe, expect, it } from 'vitest';
import { resolveTable, TABLE_REGISTRY } from '../../src/pipeline/tables/index.ts';

describe('resolveTable — the version registry', () => {
  it('resolves every (profile, version) pair TABLE_REGISTRY actually ships', () => {
    for (const [profile, versions] of Object.entries(TABLE_REGISTRY)) {
      for (const versionKey of Object.keys(versions)) {
        const version = Number(versionKey);
        const result = resolveTable(profile, version);
        expect(result, `${profile}@${version}`).toEqual({ ok: true, table: expect.anything() });
      }
    }
  });

  it('an unshipped version of a KNOWN profile stops runtime-incompatible, never a re-interpretation', () => {
    expect(resolveTable('feature', 999)).toEqual({ ok: false, stop: 'runtime-incompatible' });
    expect(resolveTable('feature', 0)).toEqual({ ok: false, stop: 'runtime-incompatible' });
  });

  it('an unknown profile stops runtime-incompatible too', () => {
    expect(resolveTable('refactor', 1)).toEqual({ ok: false, stop: 'runtime-incompatible' });
  });

  it('a resolved table is exactly the registered instance (identity, not a copy)', () => {
    const result = resolveTable('feature', 1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.table).toBe(TABLE_REGISTRY.feature[1]);
  });
});
