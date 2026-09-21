// DESIGN 2.5.1 — complete, fail-closed guard registry for the versioned transition tables.
// External work is performed by FactCollector before this registry is called. An absent fact is never permission.
import { GUARD_IDS, type GuardId } from '../../contract/ids.ts';
import type { GlobalFacts, Guard, GuardContext } from '../../contract/types.ts';

export { createFactCollector, type FactCollectorDeps } from './facts.ts';

type FactBag = Record<string, unknown>;
const factsOf = (ctx: GuardContext): FactBag => ctx.facts as unknown as FactBag;

function fact(ctx: GuardContext, id: GuardId): boolean | undefined {
  const value = factsOf(ctx)[id];
  return typeof value === 'boolean' ? value : undefined;
}

function outcome(id: GuardId, ok: boolean, detail?: string) {
  return { id, ok, ...(detail === undefined ? {} : { detail }) };
}

function factGuard(id: GuardId): Guard {
  return (ctx) => {
    const value = fact(ctx, id);
    return outcome(id, value === true, value === true ? undefined : `fact ${id} is absent or false`);
  };
}

function derived(id: GuardId, predicate: (ctx: GuardContext) => boolean, detail: string): Guard {
  return (ctx) => {
    const ok = predicate(ctx);
    return outcome(id, ok, ok ? undefined : detail);
  };
}

const hasSpec = (ctx: GuardContext): boolean => ctx.run.run.specId.length > 0 && ctx.run.run.specSha256.length > 0;

/** Guards with a local, deterministic derivation. All other guards consume a boolean fact and fail closed. */
const DERIVED: Partial<Record<GuardId, Guard>> = {
  'input.is-idea': factGuard('input.is-idea'),
  'phase.available': () => outcome('phase.available', true),
  'brainstorm.output-valid': factGuard('brainstorm.output-valid'),
  'spec.schema-valid': derived('spec.schema-valid', hasSpec, 'run has no valid spec identity'),
  'spec.frozen': derived('spec.frozen', hasSpec, 'run has no frozen spec identity'),
  'snapshot.captured': derived(
    'snapshot.captured',
    (ctx) => ctx.run.run.snapshotDigest !== undefined || fact(ctx, 'snapshot.captured') === true,
    'run snapshot has not been captured',
  ),
  'runtime.pin-valid': derived(
    'runtime.pin-valid',
    (ctx) => ctx.run.run.runtimePin !== undefined || fact(ctx, 'runtime.pin-valid') === true,
    'runtime pin is not available',
  ),
  'repo.base-resolved': derived(
    'repo.base-resolved',
    (ctx) => ctx.run.run.baseSha !== undefined || fact(ctx, 'repo.base-resolved') === true,
    'repository base is not resolved',
  ),
  'surfaces.all-owned': derived(
    'surfaces.all-owned',
    (ctx) => fact(ctx, 'surfaces.all-owned') === true || ctx.run.worktrees.every((item) => item.slot.length > 0),
    'one or more surfaces are not owned',
  ),
  'budget.available': derived(
    'budget.available',
    (ctx) => fact(ctx, 'budget.available') !== false,
    'budget is unavailable or exhausted',
  ),
  'agents.all-completed': derived(
    'agents.all-completed',
    (ctx) => ctx.run.agents.every((agent) => agent.state === 'completed'),
    'one or more agents are not completed',
  ),
  'integration.merged': derived(
    'integration.merged',
    (ctx) => ctx.run.run.integrationHead !== undefined || fact(ctx, 'integration.merged') === true,
    'integration tree is not merged',
  ),
  'approval.pending-blocking': (ctx) =>
    outcome('approval.pending-blocking', ctx.facts.blockingApprovalPending, 'no blocking approval is pending'),
  'approval.none-pending-blocking': (ctx) =>
    outcome('approval.none-pending-blocking', !ctx.facts.blockingApprovalPending, 'a blocking approval is pending'),
  'host.not-root': factGuard('host.not-root'),
  'host.outside-target': factGuard('host.outside-target'),
  'config.trust-satisfied': factGuard('config.trust-satisfied'),
  'runtime.platform-supported': factGuard('runtime.platform-supported'),
  'auth.plan-satisfied': factGuard('auth.plan-satisfied'),
  'billing.consented': factGuard('billing.consented'),
  'sandbox.meets-policy': factGuard('sandbox.meets-policy'),
  'locks.project+zones-held': factGuard('locks.project+zones-held'),
  'readiness.in': factGuard('readiness.in'),
  'contract.present-or-exempt': factGuard('contract.present-or-exempt'),
  'readiness.not-ready': factGuard('readiness.not-ready'),
  'surfaces.unowned': factGuard('surfaces.unowned'),
  'outputs.schema-valid': factGuard('outputs.schema-valid'),
  'diff.within-ownership': factGuard('diff.within-ownership'),
  'tree.digest-recorded': factGuard('tree.digest-recorded'),
  'checks.all-passed': factGuard('checks.all-passed'),
  'checks.digest-equals-integration': factGuard('checks.digest-equals-integration'),
  'checks.failed-non-environmental': factGuard('checks.failed-non-environmental'),
  'loop.may-continue': factGuard('loop.may-continue'),
  'review.nothing-to-fix': factGuard('review.nothing-to-fix'),
  'review.no-unreviewed': factGuard('review.no-unreviewed'),
  'review.leftovers-parked-or-waived': factGuard('review.leftovers-parked-or-waived'),
  'reviewref.digest-equals-integration': factGuard('reviewref.digest-equals-integration'),
  'review.has-fix-items': factGuard('review.has-fix-items'),
  'review.no-contract-change': factGuard('review.no-contract-change'),
  'review.contract-change': factGuard('review.contract-change'),
  'review.leftovers-routed-ask': factGuard('review.leftovers-routed-ask'),
  'review.security-needs-investigation': factGuard('review.security-needs-investigation'),
  'approval.ship-allowed': factGuard('approval.ship-allowed'),
  'tree.digest-equals-approved': factGuard('tree.digest-equals-approved'),
  'acceptance.no-open-human-items': factGuard('acceptance.no-open-human-items'),
  'tree.digest-differs-from-approved': factGuard('tree.digest-differs-from-approved'),
  'checks.errored-environmental': factGuard('checks.errored-environmental'),
  'resume.locks-rebuilt': factGuard('resume.locks-rebuilt'),
  'resume.git-verified': factGuard('resume.git-verified'),
  'retry.target-legal': factGuard('retry.target-legal'),
  'resume.acknowledged': factGuard('resume.acknowledged'),
  'policy.skip-allows': factGuard('policy.skip-allows'),
  'skip.justified': factGuard('skip.justified'),
  'reviewtarget.resolved-to-sha': factGuard('reviewtarget.resolved-to-sha'),
};

export const phaseAvailable = DERIVED['phase.available'] as Guard;
const completeGuards: Readonly<Record<GuardId, Guard>> = Object.freeze(
  Object.fromEntries(GUARD_IDS.map((id) => [id, DERIVED[id] ?? factGuard(id)])) as Record<GuardId, Guard>,
);

export const V3_0_GUARDS: Readonly<Record<GuardId, Guard>> = completeGuards;

export function createPipelineGuards(deps: {
  factCollector: { collect(ids: readonly GuardId[]): Promise<GlobalFacts> };
}) {
  return {
    get: (id: GuardId) => completeGuards[id],
    ids: () => GUARD_IDS,
    collectFacts: (ids: readonly GuardId[]) => deps.factCollector.collect(ids),
  };
}
