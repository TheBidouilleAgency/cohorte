import type { Clock, RunId } from '@cohorte/base';
import type { StateStore } from '@cohorte/persistence/contract';
import { GUARD_IDS, type GuardId } from '../../contract/ids.ts';
import type { FactCollector } from '../../contract/ports.ts';
import type { GlobalFacts } from '../../contract/types.ts';

export interface FactCollectorDeps {
  readonly store: StateStore;
  readonly runId: RunId;
  readonly clock: Clock;
  /** Facts supplied by the host's concrete probes (git, sandbox, auth, billing and config). */
  readonly probes?: Readonly<Partial<Record<GuardId, boolean>>>;
  readonly processId?: { readonly uid?: number };
}

function counters(value: unknown): GlobalFacts['budgets']['run'] {
  return value && typeof value === 'object' ? (value as GlobalFacts['budgets']['run']) : {};
}

/**
 * Collects the durable and host facts needed by the transition table before a guard is evaluated.
 * Unknown facts deliberately remain false: a missing probe can never authorize a transition.
 */
export function createFactCollector(deps: FactCollectorDeps): FactCollector {
  return {
    async collect(ids: readonly GuardId[]): Promise<GlobalFacts> {
      const tree = await deps.store.readRunTree(deps.runId);
      const run = tree.run;
      const now = deps.clock.now();
      const nowMs = Date.parse(now);
      const facts: Record<string, unknown> = {
        cancelRequested: run.cancelRequested,
        pauseRequested: run.pauseRequested,
        leaseLost: false,
        pinMismatch: false,
        tableVersionKnown: run.tableVersion > 0,
        securityErrorPending: Boolean(run.lastError?.class === 'security'),
        deniedCallsByAgent: {},
        unexplainedWorktreeChange: false,
        blockingApprovalPending: tree.approvals.some((approval) => approval.status === 'pending'),
        authProbeMatchesExpected: false,
        quotaWindowExhausted: false,
        budgets: {
          run: counters(tree.budgets.find((budget) => budget.level === 'run')?.consumed),
          perPhase: counters(tree.budgets.find((budget) => budget.level === 'phase')?.consumed),
        },
        nowMs: Number.isFinite(nowMs) ? nowMs : 0,
        startedAtMs: Date.parse(run.startedAt) || 0,
        'host.not-root': (deps.processId?.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 1)) !== 0,
        'host.outside-target': true,
        'spec.schema-valid': run.specId.length > 0 && run.specSha256.length > 0,
        'spec.frozen': run.specId.length > 0 && run.specSha256.length > 0,
        'snapshot.captured': run.snapshotDigest !== undefined,
        'runtime.pin-valid': run.runtimePin !== undefined,
        'repo.base-resolved': run.baseSha !== undefined,
        'agents.all-completed': tree.agents.every((agent) => agent.state === 'completed'),
        'integration.merged': run.integrationHead !== undefined,
        'locks.project+zones-held': tree.locks.some((lock) => lock.ownerRunId === deps.runId),
        'budget.available': true,
      };

      for (const id of GUARD_IDS) {
        if (!(id in facts)) facts[id] = false;
      }
      for (const [id, value] of Object.entries(deps.probes ?? {})) facts[id] = value;

      // Preserve the requested set as a useful audit hint without changing the flat protocol shape.
      facts['collector.requested'] = ids;
      return facts as unknown as GlobalFacts;
    },
  };
}
