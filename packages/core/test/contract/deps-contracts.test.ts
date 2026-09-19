// One `*Deps` contract per area, in `contract/factories.ts`, and nowhere else. An area file that declares a SECOND
// interface of the same name makes `@cohorte/core` and `@cohorte/core/<area>` export two incompatible types under one
// name, and a composition root typed against the barrel can then no longer build the real service (reviewer finding,
// fix round 1). The frozen type is the one a later unit WIDENS (docs/v3/requests/U0.08.md R1); the area file
// re-exports it.
//
// The `expectTypeOf` assertions below are checked by `tsc -p tsconfig.checks/U0.08.json` (the unit's own check) and
// by `tsconfig.tests.json` afterwards — vitest does not typecheck, so each `it` also asserts something at runtime.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EventsDeps as FrozenEventsDeps,
  JournalDeps as FrozenJournalDeps,
  LeaseDeps as FrozenLeaseDeps,
} from '../../src/contract/factories.ts';
import { type JournalDeps as AreaJournalDeps, createEffectJournal } from '../../src/durability/journal/index.ts';
import { type LeaseDeps as AreaLeaseDeps, createLeaseManager } from '../../src/durability/lease/index.ts';
import { type EventsDeps as AreaEventsDeps, createEventWriter } from '../../src/events/index.ts';

const SRC_DIR = join(import.meta.dirname, '..', '..', 'src');
const FACTORIES = join('contract', 'factories.ts');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const DEPS_DECLARATION = /^export (?:interface|type) (\w+Deps)\b/gm;

describe('every `*Deps` contract is declared once, in contract/factories.ts', () => {
  const declarations = new Map<string, string[]>();
  for (const file of collectTsFiles(SRC_DIR)) {
    const relative = file.slice(SRC_DIR.length + 1);
    for (const match of readFileSync(file, 'utf8').matchAll(DEPS_DECLARATION)) {
      const name = match[1] as string;
      declarations.set(name, [...(declarations.get(name) ?? []), relative]);
    }
  }

  it('found the frozen contracts (the scan is not vacuous)', () => {
    expect([...declarations.keys()].length).toBeGreaterThan(10);
  });

  for (const name of ['EventsDeps', 'JournalDeps', 'LeaseDeps', 'EngineDeps', 'ToolHostDeps']) {
    it(`${name} is declared only in ${FACTORIES}`, () => {
      expect(declarations.get(name)).toEqual([FACTORIES]);
    });
  }
});

describe('the area subpath and the barrel agree on the deps type', () => {
  it('events: `EventsDeps` reaches the spool port (DESIGN 2.3.2: ephemerals never reach the store)', () => {
    expectTypeOf<AreaEventsDeps>().toEqualTypeOf<FrozenEventsDeps>();
    expectTypeOf<FrozenEventsDeps>().toHaveProperty('spool');
    expect(typeof createEventWriter).toBe('function');
  });

  it('durability/journal: `JournalDeps` carries the redactor `completeEffect` needs (I7)', () => {
    expectTypeOf<AreaJournalDeps>().toEqualTypeOf<FrozenJournalDeps>();
    expectTypeOf<FrozenJournalDeps>().toHaveProperty('redactor');
    expect(typeof createEffectJournal).toBe('function');
  });

  it('durability/lease: `LeaseDeps` is the frozen one, unchanged', () => {
    expectTypeOf<AreaLeaseDeps>().toEqualTypeOf<FrozenLeaseDeps>();
    expect(typeof createLeaseManager).toBe('function');
  });
});
