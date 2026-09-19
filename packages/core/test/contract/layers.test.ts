// DESIGN 1.2 — `core/src/contract/**` does no I/O of its own and stays below `runtime-pi` / `runtime-fake`
// (`scripts/check-layers.ts`, run separately by this unit's check command, is the authoritative net over the WHOLE
// tree; this test pins the two properties `core/src/contract/**` owns on its own, so a regression here is caught by
// `pnpm --reporter=silent vitest run packages/core/test/contract` alone, without a whole-tree scan).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as factories from '../../src/contract/factories.ts';

const CONTRACT_DIR = join(import.meta.dirname, '..', '..', 'src', 'contract');
const FORBIDDEN_NODE_IMPORTS = ['node:fs', 'node:child_process', 'node:sqlite', 'node:net'];
const FORBIDDEN_PACKAGES = ['@cohorte/runtime-pi', '@cohorte/runtime-fake'];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...collectTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('core/src/contract/** imports (DESIGN 1.2 rule c + the L0-L3-except-runtime-pi/fake rule)', () => {
  const files = collectTsFiles(CONTRACT_DIR);

  it('scans at least one file (the test itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relative = file.slice(CONTRACT_DIR.length + 1);
    const text = readFileSync(file, 'utf8');
    it(`${relative}: no forbidden node: import`, () => {
      for (const forbidden of FORBIDDEN_NODE_IMPORTS) {
        expect(text.includes(`'${forbidden}'`) || text.includes(`"${forbidden}"`)).toBe(false);
      }
    });
    it(`${relative}: no runtime-pi / runtime-fake import`, () => {
      for (const forbidden of FORBIDDEN_PACKAGES) {
        expect(text.includes(forbidden)).toBe(false);
      }
    });
  }
});

describe('core factory implementation status (DESIGN 10.1 rule 3)', () => {
  const factoryNames = Object.keys(factories).filter((name) => name.startsWith('create'));
  const implemented = new Set([
    'createEngine',
    'createEffectJournal',
    'createEffectVerifierRegistry',
    'createEventWriter',
    'createGrantComputer',
    'createApprovalService',
    'createBudgetTracker',
    'createToolHostReplay',
    'createToolHost',
    'createIntegrationService',
    'createLeaseManager',
    'createLoopController',
    'createModelResolver',
    'createPipelineGuards',
    'createProcessSweeper',
    'createProjection',
    'createReviewCalculator',
    'createResumer',
    'createPhaseContracts',
    'createPhaseExecutor',
    'createPinReader',
    'createContextBuilder',
    'createTransitionEffectRunner',
  ]);

  it('found every documented area factory', () => {
    expect(factoryNames.sort()).toEqual(
      [
        'createAgentSupervisor',
        'createApprovalService',
        'createBudgetTracker',
        'createContextBuilder',
        'createEffectJournal',
        'createEffectVerifierRegistry',
        'createEngine',
        'createEventWriter',
        'createGrantComputer',
        'createIntegrationService',
        'createLeaseManager',
        'createLoopController',
        'createModelResolver',
        'createPhaseContracts',
        'createPhaseExecutor',
        'createPinReader',
        'createPipelineGuards',
        'createProcessSweeper',
        'createProjection',
        'createProvisioner',
        'createResumer',
        'createReviewCalculator',
        'createRunSnapshotter',
        'createToolHost',
        'createToolHostReplay',
        'createTransitionEffectRunner',
        'createWorktreeService',
      ].sort(),
    );
  });

  for (const name of factoryNames.filter((name) => !implemented.has(name))) {
    it(`${name} remains an explicit seam`, async () => {
      // biome-ignore lint/suspicious/noExplicitAny: every factory ignores its argument in Wave 0 (it just throws)
      const factory = (factories as any)[name] as (deps: unknown) => unknown;
      await expect(Promise.resolve().then(() => factory({}))).rejects.toThrow('not implemented');
    });
  }
});
