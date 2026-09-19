import { BudgetCounters as BaseBudgetCounters } from '@cohorte/base';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { compileOpen, compileSchema } from '../../src/compile.ts';
import {
  ACTIVE_PIPELINE_STATES,
  Actor,
  AGENT_STATES,
  BudgetCounters,
  CheckResult,
  COHORTE_ROLES,
  type CohorteRole,
  EscalationPolicy,
  EscalationStep,
  GuardOutcome,
  HALTED_STATES,
  isKnownProfile,
  NODE_STATUSES,
  PIPELINE_PROFILES,
  PIPELINE_STATES,
  PipelineProfile,
  PipelineState,
  SEVERITIES,
  type Severity,
  STOP_REASONS,
  StopReason,
  StopRecord,
  SUSPENDED_STATES,
  TERMINAL_STATES,
  TRANSITION_REASONS,
} from '../../src/vocabulary.ts';

const HEX64 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('StopReason', () => {
  test('is the ten of spec 11.2 in spec order, then the eight added ones', () => {
    expect(STOP_REASONS).toEqual([
      'review-clean',
      'iteration-limit',
      'budget-exhausted',
      'timeout',
      'identical-failure',
      'no-progress',
      'policy-violation',
      'approval-required',
      'unexpected-repo-change',
      'runtime-incompatible',
      'auth-required',
      'quota-exceeded',
      'paused',
      'cancelled',
      'agent-dead',
      'unreviewed',
      'internal-error',
      'check-environment',
    ]);
    expect(new Set(STOP_REASONS).size).toBe(18);
  });

  test('is a CLOSED wire enum', () => {
    const check = compileOpen(StopReason);
    expect(check('check-environment').ok).toBe(true);
    expect(check('a-future-reason').ok).toBe(false);
  });
});

describe('roles', () => {
  test('the eleven roles of spec 8, then the reserved verifier', () => {
    expect(COHORTE_ROLES).toEqual([
      'discoverer',
      'brainstormer',
      'architect',
      'spec-author',
      'implementer',
      'tester',
      'reviewer',
      'security-reviewer',
      'fixer',
      'release-manager',
      'reconciler',
      'verifier',
    ]);
    expectTypeOf<'verifier'>().toExtend<CohorteRole>();
  });
});

describe('pipeline states', () => {
  test('every state of spec 11.1 is present, plus the two suspended states spec 10.1 names', () => {
    const spec111 = [
      'IDLE',
      'BRAINSTORM',
      'SPEC',
      'PREFLIGHT',
      'BUILD',
      'TEST',
      'FIX',
      'REVIEW',
      'SHIP',
      'COMPLETED',
      'WAITING_APPROVAL',
      'PAUSED',
      'CANCELLED',
      'FAILED',
      'BLOCKED',
    ];
    for (const state of [...spec111, 'AUTH_REQUIRED', 'QUOTA_EXCEEDED']) expect(PIPELINE_STATES).toContain(state);
    expect(PIPELINE_STATES).toHaveLength(17);
  });

  test('IDLE and the four families partition the states', () => {
    const families = ['IDLE', ...ACTIVE_PIPELINE_STATES, ...SUSPENDED_STATES, ...HALTED_STATES, ...TERMINAL_STATES];
    expect([...families].sort()).toEqual([...PIPELINE_STATES].sort());
    expect(ACTIVE_PIPELINE_STATES).toEqual([
      'BRAINSTORM',
      'SPEC',
      'PREFLIGHT',
      'BUILD',
      'TEST',
      'REVIEW',
      'FIX',
      'SHIP',
    ]);
    expect(SUSPENDED_STATES).toEqual(['PAUSED', 'WAITING_APPROVAL', 'AUTH_REQUIRED', 'QUOTA_EXCEEDED']);
    expect(HALTED_STATES).toEqual(['FAILED', 'BLOCKED']);
    expect(TERMINAL_STATES).toEqual(['COMPLETED', 'CANCELLED']);
    expect(compileSchema(PipelineState)('QUOTA_EXCEEDED').ok).toBe(true);
    expect(compileSchema(PipelineState)('quota_exceeded').ok).toBe(false);
  });

  test('the other closed lists have the size DESIGN 2.3.1 gives them', () => {
    expect(TRANSITION_REASONS).toHaveLength(24);
    expect(AGENT_STATES).toHaveLength(11);
    expect(NODE_STATUSES).toHaveLength(9);
    expect(SEVERITIES).toEqual(['critical', 'major', 'minor', 'info']);
    expectTypeOf<Severity>().toEqualTypeOf<'critical' | 'major' | 'minor' | 'info'>();
  });
});

describe('shared records', () => {
  test.for([
    ['Actor', Actor, { kind: 'human', id: 'enzo', transport: 'cli' }],
    ['GuardOutcome', GuardOutcome, { id: 'spec-frozen', ok: false, detail: 'spec is a draft' }],
    [
      'StopRecord',
      StopRecord,
      { reason: 'timeout', detail: 'phase BUILD', resumable: true, resumeRequires: 'budget-raise' },
    ],
    [
      'EscalationStep model-tier',
      EscalationStep,
      { kind: 'model-tier', role: 'fixer', from: 'coding', to: 'reasoning' },
    ],
    ['EscalationStep role', EscalationStep, { kind: 'role', from: 'fixer', to: 'architect' }],
    ['EscalationStep human', EscalationStep, { kind: 'human' }],
    ['EscalationPolicy', EscalationPolicy, { sameFailureCount: 2, ladder: [{ kind: 'human' }], maxPerRun: 2 }],
    [
      'CheckResult',
      CheckResult,
      {
        name: 'unit',
        status: 'errored',
        argv: ['pnpm', 'test'],
        durationMs: 12,
        treeDigest: HEX64,
        output: {
          artifactId: `art_${'0'.repeat(32)}`,
          kind: 'log',
          path: 'artifacts/x.log',
          sha256: HEX64,
          bytes: 3,
        },
      },
    ],
  ] as const)('%s validates strictly', ([, schema, value]) => {
    expect(compileSchema(schema)(value)).toEqual({ ok: true, value });
  });

  test('an escalation to an unknown capability is refused', () => {
    const step = { kind: 'model-tier', role: 'fixer', from: 'coding', to: 'genius' };
    expect(compileSchema(EscalationStep)(step).ok).toBe(false);
  });

  test('BudgetCounters is the one declared in @cohorte/base', () => {
    expect(BudgetCounters).toBe(BaseBudgetCounters);
  });
});

describe('PipelineProfile', () => {
  test('is open on the wire, and isKnownProfile narrows a parsed value to the known union at the door', () => {
    expect(compileSchema(PipelineProfile)('feature').ok).toBe(true);
    expect(compileOpen(PipelineProfile)('migration').ok).toBe(true);
    for (const profile of PIPELINE_PROFILES) expect(isKnownProfile(profile)).toBe(true);
    expect(isKnownProfile('migration')).toBe(false);
    const parsed: string = 'bugfix';
    if (!isKnownProfile(parsed)) throw new Error('unreachable');
    expectTypeOf(parsed).toEqualTypeOf<PipelineProfile>();
  });
});
