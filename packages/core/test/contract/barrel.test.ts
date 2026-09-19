// PLAN §3 rule 3 — "Every barrel re-exports from files that already exist as typed stubs … Later units FILL stub
// files that lie inside their owned paths; they never edit a barrel". The invariant this pins: for every area of the
// frozen `@cohorte/core` barrel, the symbol the barrel hands out is THE SAME OBJECT the area subpath exports. A unit
// that fills its own `src/<area>/index.ts` therefore reaches the barrel (and so the composition root, DESIGN 1.2 L5)
// without editing `contract/factories.ts`, which it does not own.
//
// The second invariant (LEAD.md L2): a barrel entry is a LIVE export — filled, or still refusing loudly with
// `NotImplemented` — never a missing or renamed symbol. So this file never asserts that a given factory throws.
import { describe, expect, it } from 'vitest';
import * as agentsSupervisor from '../../src/agents/supervisor/index.ts';
import * as approvals from '../../src/approvals/index.ts';
import * as budgets from '../../src/budgets/index.ts';
import * as context from '../../src/context/index.ts';
import * as factories from '../../src/contract/factories.ts';
import * as journal from '../../src/durability/journal/index.ts';
import * as lease from '../../src/durability/lease/index.ts';
import * as engine from '../../src/engine/index.ts';
import * as events from '../../src/events/index.ts';
import * as grants from '../../src/grants/index.ts';
import * as barrel from '../../src/index.ts';
import * as integration from '../../src/integration/index.ts';
import * as loop from '../../src/loop/index.ts';
import * as phasesContracts from '../../src/phases/contracts/index.ts';
import * as phasesExecutor from '../../src/phases/executor/index.ts';
import * as pipelineGuards from '../../src/pipeline/guards/index.ts';
import * as projection from '../../src/projection/index.ts';
import * as provision from '../../src/provision/index.ts';
import * as resume from '../../src/resume/index.ts';
import * as review from '../../src/review/index.ts';
import * as snapshot from '../../src/snapshot/index.ts';
import * as toolhost from '../../src/toolhost/index.ts';
import * as worktrees from '../../src/worktrees/index.ts';

/** Every area of the barrel's frozen list that has a directory of its own, and the factories it publishes.
 * `pipeline/guards` was the exception — `U0.09` owns `packages/core/src/pipeline/guards/index.ts` and filled it with
 * guard predicates rather than the thin re-export (docs/v3/requests/U0.08.md R2/R10) — until gate G0 added that
 * re-export beside them (docs/v3/gates/G0.md), so the twenty-one areas are uniform. */
const AREAS: { readonly area: string; readonly module: Record<string, unknown>; readonly names: readonly string[] }[] =
  [
    { area: 'engine', module: engine, names: ['createEngine'] },
    { area: 'resume', module: resume, names: ['createResumer'] },
    { area: 'events', module: events, names: ['createEventWriter'] },
    { area: 'durability/journal', module: journal, names: ['createEffectJournal'] },
    { area: 'durability/lease', module: lease, names: ['createLeaseManager'] },
    { area: 'toolhost', module: toolhost, names: ['createToolHost'] },
    { area: 'approvals', module: approvals, names: ['createApprovalService', 'createToolHostReplay'] },
    { area: 'context', module: context, names: ['createContextBuilder'] },
    { area: 'snapshot', module: snapshot, names: ['createRunSnapshotter', 'createPinReader'] },
    { area: 'agents/supervisor', module: agentsSupervisor, names: ['createAgentSupervisor'] },
    { area: 'worktrees', module: worktrees, names: ['createWorktreeService'] },
    { area: 'provision', module: provision, names: ['createProvisioner'] },
    { area: 'phases/executor', module: phasesExecutor, names: ['createPhaseExecutor'] },
    { area: 'phases/contracts', module: phasesContracts, names: ['createPhaseContracts'] },
    { area: 'integration', module: integration, names: ['createIntegrationService'] },
    { area: 'loop', module: loop, names: ['createLoopController'] },
    { area: 'review', module: review, names: ['createReviewCalculator'] },
    { area: 'budgets', module: budgets, names: ['createBudgetTracker'] },
    { area: 'grants', module: grants, names: ['createGrantComputer'] },
    { area: 'projection', module: projection, names: ['createProjection'] },
    { area: 'pipeline/guards', module: pipelineGuards, names: ['createPipelineGuards'] },
  ];

const barrelExports = barrel as unknown as Record<string, unknown>;

describe('the @cohorte/core barrel serves the AREA file, not the factory stub it shadows', () => {
  for (const { area, module, names } of AREAS) {
    for (const name of names) {
      it(`${area}: barrel.${name} is the function @cohorte/core/${area} exports`, () => {
        expect(typeof module[name]).toBe('function');
        expect(barrelExports[name]).toBe(module[name]);
      });
    }
  }

  it('covers every area directory that re-exports a factory', () => {
    const covered = new Set(AREAS.flatMap(({ names }) => names));
    // The ports PLAN PC-4 adds have a factory but no area directory of their own (contract/factories.ts's own comment).
    const withoutArea = ['createModelResolver', 'createProcessSweeper'];
    const factoryNames = Object.keys(factories).filter((name) => name.startsWith('create'));
    expect(
      factoryNames.filter(
        (name) =>
          !covered.has(name) &&
          !withoutArea.includes(name) &&
          name !== 'createTransitionEffectRunner' &&
          name !== 'createEffectVerifierRegistry',
      ),
    ).toEqual([]);
  });
});

describe('every barrel entry is a live export (LEAD.md L2)', () => {
  const factoryNames = Object.keys(factories).filter((name) => name.startsWith('create'));

  it('found the documented area factories', () => {
    expect(factoryNames.length).toBeGreaterThanOrEqual(AREAS.length);
  });

  for (const name of factoryNames) {
    it(`${name} is exported by the barrel as a function`, () => {
      expect(typeof barrelExports[name]).toBe('function');
    });
  }
});
