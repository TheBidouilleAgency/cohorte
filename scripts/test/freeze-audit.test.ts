// Gate G0 (PLAN U0.G, "Freeze audit"). Every package-level barrel test pins ITS package; this one is the whole-tree
// pass the gate owes: the package graph of DESIGN 1.1 is exactly what is on disk, every frozen barrel loads, every
// Wave-0 contract entry point resolves, no barrel entry is a missing symbol (LEAD.md L2), and every W1-W6 unit has a
// per-unit tsconfig whose `include` points inside this repository.
//
// Ownership note: `scripts/test/**` is U0.01's owned path; the G0 integrator adds files to it (PLAN §5 rule 2,
// recorded in docs/v3/gates/G0.md).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { LayersFile } from '../check-layers.ts';
import { CHECKS_DIRECTORY, loadPlan, unitsOf } from '../gen-unit-checks.ts';
import { REPO_ROOT } from './support/tree.ts';

const layers = JSON.parse(readFileSync(join(REPO_ROOT, 'layers.json'), 'utf8')) as LayersFile;
const PACKAGE_NAMES = Object.keys(layers.packages);

/** `cohorte` (apps/cli) is the published app: it is not a root devDependency, so it is loaded by path. */
const barrelPathOf = (name: string): string => join(REPO_ROOT, layers.packages[name]?.dir ?? '', 'src/index.ts');

/** The Wave-0 contract entry points of workspace.md: what any unit of any wave is allowed to import. */
const CONTRACT_ENTRY_POINTS: readonly string[] = [
  '@cohorte/base',
  '@cohorte/runtime-contract',
  '@cohorte/runtime-contract/conformance',
  '@cohorte/protocol',
  '@cohorte/config/schema',
  '@cohorte/persistence/contract',
  '@cohorte/persistence/conformance',
  '@cohorte/security/contract',
  '@cohorte/git/contract',
  '@cohorte/providers/contract',
  '@cohorte/telemetry/contract',
  '@cohorte/project-model/contract',
  '@cohorte/core/contract',
  '@cohorte/tools/catalogue',
  '@cohorte/runtime-pi/host-protocol',
];

describe('the package graph of DESIGN 1.1 is what is on disk', () => {
  test('every package of layers.json has a directory, a package.json and a frozen barrel', () => {
    for (const name of PACKAGE_NAMES) {
      const dir = join(REPO_ROOT, layers.packages[name]?.dir ?? '');
      expect(existsSync(join(dir, 'package.json')), name).toBe(true);
      expect(existsSync(join(dir, 'src/index.ts')), name).toBe(true);
    }
  });

  test('no package directory on disk is missing from layers.json', () => {
    const onDisk = [
      ...readdirSync(join(REPO_ROOT, 'packages')).map((entry) => `packages/${entry}`),
      ...readdirSync(join(REPO_ROOT, 'apps')).map((entry) => `apps/${entry}`),
    ].filter((relative) => existsSync(join(REPO_ROOT, relative, 'package.json')));
    const declared = new Set(PACKAGE_NAMES.map((name) => layers.packages[name]?.dir));
    expect(onDisk.filter((relative) => !declared.has(relative))).toEqual([]);
  });
});

describe('every frozen barrel is loadable and hands out live exports (LEAD.md L2)', () => {
  for (const name of PACKAGE_NAMES) {
    test(`${name}`, async () => {
      const loaded = (await import(barrelPathOf(name))) as Record<string, unknown>;
      const names = Object.keys(loaded).filter((key) => key !== 'default');
      // `cohorte`'s barrel is the deliberate placeholder of U0.01 R4 (the app is reached through its bin, never
      // imported by name); every other barrel publishes something.
      if (name !== 'cohorte') expect(names.length, name).toBeGreaterThan(0);
      expect(
        names.filter((key) => loaded[key] === undefined),
        `${name}: a barrel entry must be a live export, never a missing symbol`,
      ).toEqual([]);
      expect(
        names.filter((key) => key.startsWith('create') && typeof loaded[key] !== 'function'),
        `${name}: every create* of a frozen barrel is callable`,
      ).toEqual([]);
    });
  }
});

describe('every Wave-0 contract entry point resolves', () => {
  for (const specifier of CONTRACT_ENTRY_POINTS) {
    test(specifier, async () => {
      const loaded = (await import(specifier)) as Record<string, unknown>;
      expect(
        Object.keys(loaded).filter((key) => loaded[key] === undefined),
        specifier,
      ).toEqual([]);
    });
  }
});

describe('tsconfig.checks/ covers every unit of plan.json', () => {
  const plan = loadPlan(REPO_ROOT);
  const units = unitsOf(plan);
  const checksDir = join(REPO_ROOT, CHECKS_DIRECTORY);

  test('one config per unit, and no stale config', () => {
    const files = readdirSync(checksDir)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    expect(files).toEqual(units.map((unit) => `${unit.id}.json`).sort());
  });

  test('the W1-W6 units all have one', () => {
    const later = units.filter((unit) => !unit.id.startsWith('U0.'));
    expect(later.length).toBeGreaterThan(50);
    for (const unit of later) expect(existsSync(join(checksDir, `${unit.id}.json`)), unit.id).toBe(true);
  });

  test('every `include` of every unit config points inside this repository (exists, or is creatable)', () => {
    for (const unit of units) {
      const config = JSON.parse(readFileSync(join(checksDir, `${unit.id}.json`), 'utf8')) as {
        include?: string[];
        files?: string[];
      };
      for (const pattern of config.include ?? []) {
        expect(isAbsolute(pattern), `${unit.id}: ${pattern}`).toBe(false);
        // The pattern is relative to tsconfig.checks/, so exactly one leading `../` reaches the repository root.
        const withoutGlob = pattern.split('*')[0] ?? '';
        const target = resolve(checksDir, withoutGlob);
        expect(normalize(target).startsWith(`${REPO_ROOT}/`), `${unit.id}: ${pattern} escapes the repository`).toBe(
          true,
        );
        // Creatable: the nearest EXISTING ancestor is a real directory of this repository, so nothing but the unit's
        // own work is missing.
        let ancestor = target;
        while (!existsSync(ancestor) && ancestor.length > REPO_ROOT.length) ancestor = dirname(ancestor);
        expect(existsSync(ancestor), `${unit.id}: ${pattern} has no existing ancestor`).toBe(true);
      }
    }
  });
});
