// DESIGN 2.5.1 / 2.5.2 / 2.5.3 — the frozen seam is CLOSED where DESIGN gives a closed type. These assertions are
// what makes `U0.09`'s tables (`as const satisfies TransitionTable`) typo-proof for free, instead of needing a
// runtime scan: they are checked by `tsconfig.tests.json` (`pnpm verify`, CI), which is the only project that
// typechecks test files (PLAN PC-10).
import type { ErrorClass } from '@cohorte/base';
import type {
  ActivePipelineState,
  EscalationPolicy,
  EscalationStep,
  GuardOutcome,
  PipelineProfile,
  StopRecord,
} from '@cohorte/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GuardId, TransitionEffectId } from '../../src/contract/ids.ts';
import type {
  Guard,
  LoopDecision,
  LoopPolicy,
  LoopState,
  PhaseContract,
  PhaseOutcome,
  RetryPolicy,
  RoundRecord,
  TransitionDef,
  TransitionTable,
} from '../../src/contract/types.ts';

describe('TransitionDef', () => {
  it('accepts a DESIGN 2.5.1 row verbatim', () => {
    const t03 = {
      id: 'T03',
      from: 'SPEC',
      to: 'PREFLIGHT',
      reason: 'ready',
      actor: 'human',
      preconditions: ['spec.schema-valid', 'spec.frozen'],
      effects: ['record-spec-hash'],
    } as const satisfies TransitionDef;
    expect(t03.effects).toEqual(['record-spec-hash']);
  });

  it('accepts the three wildcards', () => {
    const wildcards = [
      { from: '*active', to: 'PAUSED' },
      { from: '*suspended', to: '*resumeTo' },
      { from: '*any-non-terminal', to: 'CANCELLED' },
    ] as const satisfies readonly { from: TransitionDef['from']; to: TransitionDef['to'] }[];
    expect(wildcards).toHaveLength(3);
  });

  it('rejects a state, a reason, a guard id and an effect id that are not in their closed set', () => {
    const bad = {
      id: 'T99',
      // @ts-expect-error 'BANANA' is not a PipelineState nor one of the three wildcards
      from: 'BANANA',
      // @ts-expect-error 'PINEAPPLE' is not a PipelineState nor '*resumeTo'
      to: 'PINEAPPLE',
      // @ts-expect-error 'because-i-said-so' is not a TransitionReason
      reason: 'because-i-said-so',
      actor: 'system',
      // @ts-expect-error 'spec.frozeen' is a typo and 'guard.nope' is not a GuardId
      preconditions: ['spec.frozeen', 'guard.nope'],
      // @ts-expect-error 'mint-reviw-ref' is a typo of 'mint-review-ref'
      effects: ['mint-reviw-ref'],
    } satisfies TransitionDef;
    expect(bad.id).toBe('T99');
  });

  it('the id arrays are exactly the closed sets of ./ids.ts', () => {
    expectTypeOf<TransitionDef['preconditions']>().toEqualTypeOf<readonly GuardId[]>();
    expectTypeOf<TransitionDef['effects']>().toEqualTypeOf<readonly TransitionEffectId[]>();
  });
});

describe('TransitionTable', () => {
  it('names a profile and the active states, not bare strings', () => {
    expectTypeOf<TransitionTable['profile']>().toEqualTypeOf<PipelineProfile>();
    expectTypeOf<TransitionTable['phases']>().toEqualTypeOf<readonly ActivePipelineState[]>();
  });

  it('rejects an unknown profile and an unknown phase', () => {
    const bad = {
      // @ts-expect-error 'not-a-profile' is not a PipelineProfile
      profile: 'not-a-profile',
      version: 1,
      initial: 'IDLE',
      // @ts-expect-error 'NOT_A_PHASE' is not an ActivePipelineState
      phases: ['NOT_A_PHASE'],
      rows: [],
    } satisfies TransitionTable;
    expect(bad.version).toBe(1);
  });
});

describe('the seam carries protocol types, never a widened local copy', () => {
  it('a guard outcome is the protocol GuardOutcome (it is forwarded into run.state.changed.guards)', () => {
    expectTypeOf<ReturnType<Guard>>().toEqualTypeOf<GuardOutcome>();
  });

  it('a suspended phase and a stop decision both carry the protocol StopRecord', () => {
    expectTypeOf<Extract<PhaseOutcome, { kind: 'suspended' }>['stop']>().toEqualTypeOf<StopRecord>();
    expectTypeOf<Extract<LoopDecision, { kind: 'stop' }>['stop']>().toEqualTypeOf<StopRecord>();
  });

  it('the escalation ladder is the protocol data type (DESIGN 2.5.3)', () => {
    expectTypeOf<Extract<LoopDecision, { kind: 'escalate' }>['step']>().toEqualTypeOf<EscalationStep>();
    expectTypeOf<LoopPolicy['escalation']>().toEqualTypeOf<EscalationPolicy>();
    expectTypeOf<LoopState['escalations']>().toEqualTypeOf<EscalationStep[]>();
    expectTypeOf<RoundRecord['escalation']>().toEqualTypeOf<EscalationStep | undefined>();
  });

  it('a phase contract names its state and its output schema (DESIGN 2.5.2)', () => {
    expectTypeOf<PhaseContract['state']>().toEqualTypeOf<ActivePipelineState>();
    expectTypeOf<RetryPolicy['retryOn']>().toEqualTypeOf<readonly ErrorClass[]>();
  });
});
