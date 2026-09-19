// DESIGN 2.5.1 "Versioning" — the version registry: `(profile, tableVersion)` -> the table that executes it, or
// `'runtime-incompatible'` for a version this build does not ship. Tables are APPEND-ONLY files; resuming a run on
// an unshipped version is never re-interpreted (ADR-0018 §2).
import type { PipelineProfile } from '@cohorte/protocol';
import type { TransitionTable } from '../../contract/types.ts';
import { BUGFIX_STOP_ROW_MAP, BUGFIX_V1 } from './bugfix.v1.ts';
import { FEATURE_STOP_ROW_MAP, FEATURE_V1 } from './feature.v1.ts';
import { REVIEW_STOP_ROW_MAP, REVIEW_V1 } from './review.v1.ts';

export { BUGFIX_STOP_ROW_MAP, BUGFIX_V1 } from './bugfix.v1.ts';
export { FEATURE_STOP_ROW_MAP, FEATURE_V1 } from './feature.v1.ts';
export { REVIEW_STOP_ROW_MAP, REVIEW_V1 } from './review.v1.ts';
export { entryEffectsOf, matchesFrom } from './shared.ts';

/** Every table this build can execute, keyed by profile then version. Appending a version or a profile only ever
 * ADDS an entry (DESIGN 2.5.1: "the engine keeps every version it can still execute"). */
export const TABLE_REGISTRY = {
  feature: { 1: FEATURE_V1 },
  bugfix: { 1: BUGFIX_V1 },
  review: { 1: REVIEW_V1 },
} as const satisfies Readonly<Record<string, Readonly<Record<number, TransitionTable>>>>;

/** The `StopReason -> row id` map for the given, already-resolved table (DESIGN 2.5.3 / spec 11.2). */
export const STOP_ROW_MAPS: Readonly<Record<PipelineProfile, Readonly<Record<string, string>>>> = {
  feature: FEATURE_STOP_ROW_MAP,
  bugfix: BUGFIX_STOP_ROW_MAP,
  review: REVIEW_STOP_ROW_MAP,
};

export type TableLookup = { ok: true; table: TransitionTable } | { ok: false; stop: 'runtime-incompatible' };

/** Resolve `(profile, tableVersion)` to the table that must execute it. An unknown profile OR an unshipped version
 * of a known profile alike stop `runtime-incompatible` — never a re-interpretation (DESIGN 2.5.1). */
export function resolveTable(profile: string, tableVersion: number): TableLookup {
  const byVersion: Readonly<Record<number, TransitionTable>> | undefined = (
    TABLE_REGISTRY as Readonly<Record<string, Readonly<Record<number, TransitionTable>>>>
  )[profile];
  const table = byVersion?.[tableVersion];
  if (!table) return { ok: false, stop: 'runtime-incompatible' };
  return { ok: true, table };
}
