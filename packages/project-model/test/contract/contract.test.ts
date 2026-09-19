import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Sha256, toIsoInstant } from '@cohorte/base';
import { DEFAULT_CONFIG } from '@cohorte/config/schema';
import { FixedClock } from '@cohorte/testkit';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  DIFF_CLASSES,
  DriftReport,
  FIELD_CLASSES,
  type FieldClass,
  type ModelField,
  ProjectModel,
  ReconcilePlan,
  type RepositoryScanner,
} from '../../src/contract.ts';
import * as barrel from '../../src/index.ts';
import {
  applyInit,
  deriveDesiredState,
  diffStates,
  planInit,
  planReconcile,
  readActualState,
  scanRepository,
} from '../../src/index.ts';

const pathsOf = (schema: TSchema, value: unknown): string[] => {
  const compiled = Compile(schema);
  return compiled.Check(value) ? [] : [...compiled.Errors(value)].map((issue) => issue.instancePath);
};
const SHA = 'c'.repeat(64) as Sha256;
const AT = toIsoInstant(0);

const observed = <T>(value: T, detector: string, ...sources: string[]): ModelField<T> => ({
  value,
  class: 'observed',
  provenance: { detector, sources },
});

const model = (): ProjectModel => ({
  schemaVersion: 1,
  project: { id: { ...observed('shop', 'package-json', 'package.json'), class: 'human' }, root: observed('.', 'git') },
  stack: {
    languages: observed(['typescript'], 'file-extensions'),
    packageManager: observed<string | null>('pnpm', 'lockfile', 'pnpm-lock.yaml'),
    frameworks: observed(['react'], 'package-json', 'apps/web/package.json'),
  },
  surfaces: { frontend: { paths: { ...observed(['apps/web/**'], 'workspace-layout'), class: 'mixed' } } },
  commands: { test: observed(['pnpm', 'test'], 'package-json', 'package.json') },
  testStrategy: observed({ runner: 'vitest', locations: ['apps/web/test'] }, 'package-json'),
  deploymentHints: observed(['Dockerfile'], 'file-presence', 'Dockerfile'),
  ownership: observed<{ codeowners: string | null }>({ codeowners: null }, 'file-presence'),
  risks: [{ id: 'no-lockfile-in-api', severity: 'medium', message: 'apps/api has no lockfile', sources: ['apps/api'] }],
  conventions: observed([], 'file-presence'),
  generatedArtifacts: { ...observed(['.cohorte/generated/README.md'], 'manifest'), class: 'generated' },
  unknowns: [
    {
      id: 'lint-command',
      question: 'two lint scripts exist',
      candidates: ['lint', 'lint:ci'],
      sources: ['package.json'],
    },
  ],
  provenance: { generatedAt: AT, toolVersion: '3.0.0', analysis: 'deterministic' },
});

describe('ProjectModel [S] (spec 12)', () => {
  test('the sample is schema-valid', () => {
    expect(pathsOf(ProjectModel, model())).toEqual([]);
  });

  test('the five field classes of spec 13, and nothing else', () => {
    expect([...FIELD_CLASSES]).toEqual(['human', 'generated', 'derived', 'observed', 'mixed']);
    expectTypeOf<FieldClass>().toEqualTypeOf<'human' | 'generated' | 'derived' | 'observed' | 'mixed'>();
    const wrong = model() as unknown as { stack: { languages: { class: string } } };
    wrong.stack.languages.class = 'guessed';
    expect(pathsOf(ProjectModel, wrong)).toContain('/stack/languages/class');
  });

  test('every field carries its class AND its provenance', () => {
    const bare = model() as unknown as { stack: { languages: unknown } };
    bare.stack.languages = ['typescript'];
    expect(pathsOf(ProjectModel, bare)).not.toEqual([]);
    const noProvenance = model() as unknown as { commands: Record<string, object> };
    noProvenance.commands.test = { value: ['pnpm', 'test'], class: 'observed' };
    expect(pathsOf(ProjectModel, noProvenance)).toContain('/commands/test');
  });

  test('a command is an argv array: never a shell string, never empty', () => {
    const shell = model() as unknown as { commands: Record<string, { value: unknown }> };
    (shell.commands.test as { value: unknown }).value = 'pnpm test';
    expect(pathsOf(ProjectModel, shell)).toContain('/commands/test/value');
  });

  test('`unknowns` is required: ambiguity is recorded, not resolved', () => {
    const { unknowns: _dropped, ...rest } = model();
    expect(pathsOf(ProjectModel, rest)).not.toEqual([]);
  });
});

describe('DriftReport / ReconcilePlan [S] (spec 13)', () => {
  const report = (): DriftReport => ({
    schemaVersion: 1,
    generatedAt: AT,
    entries: DIFF_CLASSES.map((diff, index) => ({
      target: `generated/file-${index}.md`,
      class: 'generated',
      diff,
      desiredSha256: SHA,
      detail: diff,
    })),
  });
  const plan = (): ReconcilePlan => ({
    schemaVersion: 1,
    cohorteVersion: '3.0.0',
    generatedAt: AT,
    drift: report(),
    operations: [
      { op: 'create', target: 'generated/file-0.md', diff: 'absent', reason: 'missing' },
      { op: 'ask', target: 'generated/file-3.md', diff: 'conflict', reason: 'edited by a human since it was rendered' },
    ],
    conflicts: ['generated/file-3.md'],
    applyAvailable: false,
  });

  test('the six diff classes', () => {
    expect([...DIFF_CLASSES]).toEqual([
      'absent',
      'expected-change',
      'human-change',
      'conflict',
      'potential-deletion',
      'unknown',
    ]);
    expect(pathsOf(DriftReport, report())).toEqual([]);
    const wrong = report() as unknown as { entries: { diff: string }[] };
    (wrong.entries[0] as { diff: string }).diff = 'overwritten';
    expect(pathsOf(DriftReport, wrong)).toContain('/entries/0/diff');
  });

  test('the plan publishes whether authorized apply is available', () => {
    expect(pathsOf(ReconcilePlan, plan())).toEqual([]);
    expect(pathsOf(ReconcilePlan, { ...plan(), applyAvailable: true })).toEqual([]);
    expect(
      pathsOf(ReconcilePlan, {
        ...plan(),
        operations: [{ op: 'overwrite', target: 'x', diff: 'conflict', reason: '' }],
      }),
    ).toContain('/operations/0/op');
  });

  test('identical files are not drift, and human edits are never replacements', () => {
    const clock = new FixedClock();
    const same = diffStates(
      { cohorteVersion: '3.0.0', files: [{ path: 'config.yaml', class: 'human', sha256: SHA }] },
      { manifest: null, files: [{ path: 'config.yaml', class: 'human', sha256: SHA }] },
      clock,
    );
    expect(same.entries).toEqual([]);
    const changed = diffStates(
      {
        cohorteVersion: '3.0.0',
        files: [{ path: 'config.yaml', class: 'human', sha256: 'd'.repeat(64) as Sha256 }],
      },
      { manifest: null, files: [{ path: 'config.yaml', class: 'human', sha256: SHA }] },
      clock,
    );
    expect(changed.entries[0]?.diff).toBe('human-change');
  });

  test('both are exported as schemas, for gen-schemas', () => {
    for (const schema of [ProjectModel, DriftReport, ReconcilePlan]) {
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
});

describe('the Wave-0 frozen barrel of @cohorte/project-model', () => {
  const _scan: RepositoryScanner = async () => model();

  test('the public API of DESIGN 1.1 exists', () => {
    for (const name of [
      'scanRepository',
      'planInit',
      'applyInit',
      'planReconcile',
      'ProjectModel',
      'DriftReport',
      'ReconcilePlan',
    ]) {
      expect(Object.keys(barrel), name).toContain(name);
    }
  });

  test('the public operations are executable', async () => {
    const clock = new FixedClock();
    const root = await mkdtemp(join(tmpdir(), 'cohorte-model-'));
    try {
      const scanned = await scanRepository(root, { clock, toolVersion: '3.0.0' });
      const init = await planInit({ root, model: scanned, cohorteVersion: '3.0.0' });
      expect(await applyInit(init)).toMatchObject({ written: expect.arrayContaining(['manifest.yaml']) });
      expect(
        deriveDesiredState({ model: scanned, config: DEFAULT_CONFIG, cohorteVersion: '3.0.0', skills: {} }).files
          .length,
      ).toBeGreaterThan(0);
      expect((await readActualState(root)).manifest).not.toBeNull();
      expect(
        diffStates({ cohorteVersion: '3.0.0', files: [] }, { manifest: null, files: [] }, clock).schemaVersion,
      ).toBe(1);
      const reconcile = await planReconcile({ root, scan: async () => scanned, cohorteVersion: '3.0.0', clock });
      expect(reconcile.applyAvailable).toBe(true);
      expect(reconcile.drift.entries.map((entry) => entry.target)).not.toEqual(
        expect.arrayContaining(['manifest.yaml', 'project.yaml', '.gitignore', 'generated/.gitkeep']),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('init creates the generated directory and never guesses between lockfiles', async () => {
    const clock = new FixedClock();
    const root = await mkdtemp(join(tmpdir(), 'cohorte-model-ambiguous-'));
    try {
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await writeFile(join(root, 'package-lock.json'), '{}\n');
      const scanned = await scanRepository(root, { clock, toolVersion: '3.0.0' });
      expect(scanned.stack.packageManager.value).toBeNull();
      expect(scanned.unknowns[0]?.id).toBe('package-manager');
      const init = await planInit({ root, model: scanned, cohorteVersion: '3.0.0' });
      await applyInit(init);
      await expect(readFile(join(root, '.cohorte', 'generated', '.gitkeep'))).resolves.toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the scanner is injected into planReconcile', () => {
    expectTypeOf<Parameters<typeof planReconcile>[0]['scan']>().toEqualTypeOf<RepositoryScanner>();
  });
});
