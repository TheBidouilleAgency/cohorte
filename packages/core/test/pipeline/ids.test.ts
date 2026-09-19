// DESIGN 2.5.1 — "every guard id / effect id used by a row is in GUARD_IDS / TRANSITION_EFFECT_IDS; row ids unique
// and stable." Row ids are typed against the closed `GuardId` / `TransitionEffectId` sets at COMPILE time already
// (`as const satisfies TransitionTable`, contract/types.ts): this file is the runtime cross-check that the closed
// sets and the rows actually shipped agree — and pins the canonical DESIGN row ids so a rename is a visible diff.
import { describe, expect, it } from 'vitest';
import { GUARD_IDS, TRANSITION_EFFECT_IDS } from '../../src/contract/ids.ts';
import type { TransitionTable } from '../../src/contract/types.ts';
import { BUGFIX_V1, FEATURE_V1, REVIEW_V1 } from '../../src/pipeline/tables/index.ts';

const TABLES: readonly TransitionTable[] = [FEATURE_V1, BUGFIX_V1, REVIEW_V1];
const GUARD_SET = new Set<string>(GUARD_IDS);
const EFFECT_SET = new Set<string>(TRANSITION_EFFECT_IDS);

describe.each(TABLES)('$profile@$version row ids', (table) => {
  it('every precondition of every row is a member of GUARD_IDS', () => {
    for (const row of table.rows) {
      for (const guardId of row.preconditions) {
        expect(GUARD_SET.has(guardId), `${table.profile} ${row.id}: guard "${guardId}"`).toBe(true);
      }
    }
  });

  it('every effect of every row is a member of TRANSITION_EFFECT_IDS', () => {
    for (const row of table.rows) {
      for (const effectId of row.effects) {
        expect(EFFECT_SET.has(effectId), `${table.profile} ${row.id}: effect "${effectId}"`).toBe(true);
      }
    }
  });

  it('row ids are unique within the table', () => {
    const ids = table.rows.map((row) => row.id);
    expect(new Set(ids).size, `${table.profile}: duplicate row id among ${ids.join(', ')}`).toBe(ids.length);
  });
});

it('the canonical DESIGN row ids are stable in feature@1 (T01-T16, T20-T27, T30-T32, and one T33-<phase> per skippable phase)', () => {
  const ids = new Set(FEATURE_V1.rows.map((row) => row.id));
  const canonical = [
    'T01',
    'T02',
    'T03',
    'T04',
    'T05',
    'T06',
    'T07',
    'T08',
    'T09',
    'T10',
    'T11',
    'T12',
    'T13',
    'T14',
    'T15',
    'T16',
    'T20',
    'T21',
    'T22',
    'T23',
    'T24',
    'T25',
    'T26',
    'T27',
    'T30',
    'T31',
    'T32',
    'T33-PREFLIGHT',
    'T33-BUILD',
    'T33-TEST',
    'T33-REVIEW',
    'T33-FIX',
    'T33-SHIP',
  ];
  for (const id of canonical) expect(ids, `missing canonical row id ${id}`).toContain(id);
});

it('bugfix@1 is feature@1 minus T01-T03 (BRAINSTORM/SPEC), everything else identical by id', () => {
  const featureIds = new Set(FEATURE_V1.rows.map((row) => row.id));
  const bugfixIds = new Set(BUGFIX_V1.rows.map((row) => row.id));
  expect(bugfixIds.has('T01')).toBe(false);
  expect(bugfixIds.has('T02')).toBe(false);
  expect(bugfixIds.has('T03')).toBe(false);
  for (const id of featureIds) {
    if (id === 'T01' || id === 'T02' || id === 'T03') continue;
    expect(bugfixIds, `bugfix@1 is missing ${id}`).toContain(id);
  }
  expect(bugfixIds.size).toBe(featureIds.size - 3);
});

it('review@1 uses its own R-numbered ids for the head rows, and the shared T20-T32 tail', () => {
  const ids = new Set(REVIEW_V1.rows.map((row) => row.id));
  for (const id of ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'T20', 'T27', 'T30', 'T31', 'T32']) {
    expect(ids, `review@1 is missing ${id}`).toContain(id);
  }
});
