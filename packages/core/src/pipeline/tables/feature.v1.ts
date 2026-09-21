// DESIGN 2.5.1 — `feature@1`: every row T01-T33 of the master table, `as const satisfies TransitionTable`. Rows T06
// and T12 read as "guard A or guard B [or C]" in DESIGN's prose; `TransitionDef.preconditions` is AND-only (the
// frozen contract type, DESIGN 2.5.1), so each disjunct becomes its own candidate row sharing `(from, reason, to)` —
// see `tables/shared.ts`'s header comment for why this is exactly OR semantics under `resolveTransition`'s
// first-match-wins candidate order (deviation recorded in docs/v3/requests/U0.09.md).
import { ACTIVE_PIPELINE_STATES } from '@cohorte/protocol';
import type { GuardId } from '../../contract/ids.ts';
import type { TransitionDef, TransitionTable } from '../../contract/types.ts';
import { buildSkipRows, buildTailRows, stopRowMap } from './shared.ts';

const HEAD_ROWS: readonly TransitionDef[] = [
  // BRAINSTORM/SPEC are executable authoring phases; direct frozen-spec starts remain supported below.
  {
    id: 'T01',
    from: 'IDLE',
    to: 'BRAINSTORM',
    reason: 'start',
    actor: 'human',
    preconditions: ['input.is-idea', 'phase.available'] satisfies readonly GuardId[],
    effects: [],
  },
  {
    id: 'T02',
    from: 'BRAINSTORM',
    to: 'SPEC',
    reason: 'ready',
    actor: 'human',
    preconditions: ['brainstorm.output-valid'] satisfies readonly GuardId[],
    effects: [],
  },
  {
    id: 'T03',
    from: 'SPEC',
    to: 'PREFLIGHT',
    reason: 'ready',
    actor: 'human',
    preconditions: ['spec.schema-valid', 'spec.frozen'] satisfies readonly GuardId[],
    effects: ['record-spec-hash'],
  },
  {
    id: 'T04',
    from: 'IDLE',
    to: 'PREFLIGHT',
    reason: 'start',
    actor: 'either',
    preconditions: [
      'spec.schema-valid',
      'spec.frozen',
      'host.not-root',
      'host.outside-target',
      'config.trust-satisfied',
      'snapshot.captured',
      'runtime.pin-valid',
      'runtime.platform-supported',
      'auth.plan-satisfied',
      'billing.consented',
      'sandbox.meets-policy',
      'repo.base-resolved',
      'locks.project+zones-held',
    ] satisfies readonly GuardId[],
    effects: ['create-integration-branch'],
  },
  {
    id: 'T05',
    from: 'PREFLIGHT',
    to: 'BUILD',
    reason: 'ready',
    actor: 'system',
    preconditions: [
      'readiness.in',
      'contract.present-or-exempt',
      'surfaces.all-owned',
      'budget.available',
    ] satisfies readonly GuardId[],
    effects: [],
  },
  // T06: "readiness.not-ready OR surfaces.unowned" -> two candidate rows.
  {
    id: 'T06',
    from: 'PREFLIGHT',
    to: 'WAITING_APPROVAL',
    reason: 'needs-human',
    actor: 'system',
    preconditions: ['readiness.not-ready'] satisfies readonly GuardId[],
    effects: ['open-approval'],
  },
  {
    id: 'T06-surfaces',
    from: 'PREFLIGHT',
    to: 'WAITING_APPROVAL',
    reason: 'needs-human',
    actor: 'system',
    preconditions: ['surfaces.unowned'] satisfies readonly GuardId[],
    effects: ['open-approval'],
  },
  {
    id: 'T07',
    from: 'BUILD',
    to: 'TEST',
    reason: 'built',
    actor: 'system',
    preconditions: [
      'agents.all-completed',
      'outputs.schema-valid',
      'diff.within-ownership',
      'integration.merged',
      'tree.digest-recorded',
    ] satisfies readonly GuardId[],
    effects: [],
  },
  {
    id: 'T08',
    from: 'TEST',
    to: 'REVIEW',
    reason: 'tests-pass',
    actor: 'system',
    preconditions: ['checks.all-passed', 'checks.digest-equals-integration'] satisfies readonly GuardId[],
    effects: ['mint-review-ref'],
  },
  {
    id: 'T09',
    from: 'TEST',
    to: 'FIX',
    reason: 'tests-fail',
    actor: 'system',
    preconditions: ['checks.failed-non-environmental', 'loop.may-continue'] satisfies readonly GuardId[],
    effects: ['synthesize-check-findings'],
  },
  {
    id: 'T10',
    from: 'REVIEW',
    to: 'SHIP',
    reason: 'review-approved',
    actor: 'system',
    preconditions: [
      'review.nothing-to-fix',
      'review.no-unreviewed',
      'review.leftovers-parked-or-waived',
      'reviewref.digest-equals-integration',
    ] satisfies readonly GuardId[],
    effects: ['record-approved-digest'],
  },
  {
    id: 'T11',
    from: 'REVIEW',
    to: 'FIX',
    reason: 'review-findings',
    actor: 'system',
    preconditions: [
      'review.has-fix-items',
      'loop.may-continue',
      'review.no-contract-change',
    ] satisfies readonly GuardId[],
    effects: [],
  },
  // T12: "one of review.contract-change, review.leftovers-routed-ask, review.security-needs-investigation".
  {
    id: 'T12',
    from: 'REVIEW',
    to: 'WAITING_APPROVAL',
    reason: 'needs-human',
    actor: 'system',
    preconditions: ['review.contract-change'] satisfies readonly GuardId[],
    effects: ['open-approval'],
  },
  {
    id: 'T12-leftovers',
    from: 'REVIEW',
    to: 'WAITING_APPROVAL',
    reason: 'needs-human',
    actor: 'system',
    preconditions: ['review.leftovers-routed-ask'] satisfies readonly GuardId[],
    effects: ['open-approval'],
  },
  {
    id: 'T12-security',
    from: 'REVIEW',
    to: 'WAITING_APPROVAL',
    reason: 'needs-human',
    actor: 'system',
    preconditions: ['review.security-needs-investigation'] satisfies readonly GuardId[],
    effects: ['open-approval'],
  },
  {
    id: 'T13',
    from: 'FIX',
    to: 'TEST',
    reason: 'fixed',
    actor: 'system',
    preconditions: ['agents.all-completed', 'diff.within-ownership', 'integration.merged'] satisfies readonly GuardId[],
    effects: [],
  },
  {
    id: 'T14',
    from: 'SHIP',
    to: 'COMPLETED',
    reason: 'shipped',
    actor: 'system',
    preconditions: [
      'approval.ship-allowed',
      'tree.digest-equals-approved',
      'acceptance.no-open-human-items',
    ] satisfies readonly GuardId[],
    effects: ['release-locks', 'write-ship-report'],
  },
  {
    id: 'T15',
    from: 'SHIP',
    to: 'TEST',
    reason: 'stop-rule',
    actor: 'system',
    preconditions: ['tree.digest-differs-from-approved'] satisfies readonly GuardId[],
    effects: [],
  },
  {
    id: 'T16',
    from: 'TEST',
    to: 'FAILED',
    reason: 'stop-rule',
    actor: 'system',
    preconditions: ['checks.errored-environmental'] satisfies readonly GuardId[],
    effects: ['checkpoint-worktrees', 'checkpoint'],
  },
];

export const FEATURE_STOP_ROW_MAP = stopRowMap({ checkEnvironment: 'T16', reviewClean: 'T14' });

const SKIP_TARGETS = [
  { phase: 'PREFLIGHT', to: 'BUILD' },
  { phase: 'BUILD', to: 'TEST' },
  { phase: 'TEST', to: 'REVIEW' },
  { phase: 'REVIEW', to: 'SHIP' },
  { phase: 'FIX', to: 'TEST' },
  { phase: 'SHIP', to: 'COMPLETED' },
] as const;

export const FEATURE_V1 = {
  profile: 'feature',
  version: 1,
  initial: 'IDLE',
  phases: ACTIVE_PIPELINE_STATES,
  rows: [
    ...HEAD_ROWS,
    ...buildTailRows(),
    ...buildSkipRows('feature', ACTIVE_PIPELINE_STATES, HEAD_ROWS, SKIP_TARGETS),
  ],
} as const satisfies TransitionTable;
