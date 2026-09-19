// DESIGN 4.2 / factories.ts's `Projection.evolve` — the PURE fold `RunState x DurableEnvelope -> RunState`, total
// over `DurableEventType` (a `switch`, so every case narrows `envelope.payload` to its own row of the catalogue).
//
// DEVIATION (docs/v3/requests/U0.09.md): DESIGN 2.4 / ADR-0002 says stores are "dumb" and core writes projections
// EXPLICITLY, in the SAME transaction as the events that justify them ("no store contains a reducer") — so this
// fold is not how the live engine keeps `RunTreeRows` during a normal run; it is the SECONDARY reconstruction used
// for verification / resume audits (and by `createProjection`'s `Projection.evolve`, `core/contract/factories.ts`,
// which this module's `evolve` is shaped to match exactly: `(state, event) => RunState`, one event at a time).
// Several event payloads do not, by design, carry every field their matching RECORD needs (`ApprovalRecord`'s
// `idempotencyKey`/`grantKey`, `LockRecord`'s `ownerHostId`/`ownerPid`/`leaseExpiresAt`, none of them on the wire —
// the store computes them at write time). Folding those is therefore an EXPLICIT no-op here rather than a
// best-guess reconstruction that would silently diverge from the store's own projection; every other case updates
// the same fields the store's own explicit writes would.
//
// TWO FIELDS ARE DELIBERATELY NOT RECONSTRUCTED: `run.version` and `run.lastHash`. Both are store-assigned per
// TRANSACTION (`RunRecord`: "store-assigned by `appendEvents`, like `lastHash` and `version`: a `putRun` / `patchRun`
// never moves them"), and `appendEvents` bumps `version` ONCE per CALL whatever the batch size — while DESIGN 4.2's
// E5 and E8 transactions routinely append several events at once (`run.state.changed` + `phase.started`;
// `phase.completed` + `checkpoint.created`). A per-EVENT fold cannot see a transaction boundary (`envelope.sub` is 0
// for every durable event, protocol/envelope.ts), so advancing `version` here would make the reconstruction of any
// multi-event transaction PERMANENTLY unequal to the stored record. They are therefore excluded from any
// reconstruction comparison. `lastSequence` IS per-event and gapless, and `updatedAt` is the one clock field the
// stream carries, so both are advanced.

import type { AgentRecord, PhaseRecord, WorktreeRecord } from '@cohorte/persistence/contract';
import type { DurableEventType, Envelope } from '@cohorte/protocol';
import type { RunState } from '../contract/types.ts';

type DurableEnvelope = Envelope<DurableEventType>;

const NODE_STATUS_BY_OUTCOME = {
  passed: 'completed',
  failed: 'failed',
  'needs-human': 'waiting-approval',
  skipped: 'skipped',
} as const;

function currentPhaseRunId(state: RunState): PhaseRecord['phaseRunId'] | undefined {
  return state.phases.at(-1)?.phaseRunId;
}

function upsertPhase(
  state: RunState,
  phaseRunId: PhaseRecord['phaseRunId'],
  patch: (existing: PhaseRecord | undefined) => PhaseRecord,
): RunState {
  const index = state.phases.findIndex((phase) => phase.phaseRunId === phaseRunId);
  const next = patch(index === -1 ? undefined : state.phases[index]);
  const phases = index === -1 ? [...state.phases, next] : state.phases.with(index, next);
  return { ...state, phases };
}

function upsertAgent(
  state: RunState,
  agentId: AgentRecord['agentId'],
  patch: (existing: AgentRecord) => AgentRecord,
): RunState {
  const index = state.agents.findIndex((agent) => agent.agentId === agentId);
  const existing = index === -1 ? undefined : state.agents[index];
  if (!existing) return state; // declared elsewhere or out of order: nothing to patch (defensive, see file header)
  return { ...state, agents: state.agents.with(index, patch(existing)) };
}

function upsertWorktree(
  state: RunState,
  slot: string,
  patch: (existing: WorktreeRecord | undefined) => WorktreeRecord,
): RunState {
  const index = state.worktrees.findIndex((worktree) => worktree.slot === slot);
  const next = patch(index === -1 ? undefined : state.worktrees[index]);
  const worktrees = index === -1 ? [...state.worktrees, next] : state.worktrees.with(index, next);
  return { ...state, worktrees };
}

/** `assertNever` doubles as the compile-time totality proof: adding a `DurableEventType` without a case here is a
 * type error at this call, not a silently-skipped runtime branch. */
function assertNever(value: never): never {
  throw new TypeError(`evolve: unhandled durable event type ${JSON.stringify(value)}`);
}

export function evolve(state: RunState, envelope: DurableEnvelope): RunState {
  // Every durable event advances the run's own bookkeeping, whatever else it does (DESIGN: the projection is
  // rebuilt "transaction by transaction" from the stream).
  const base: RunState = {
    ...state,
    run: { ...state.run, lastSequence: envelope.sequence, updatedAt: envelope.timestamp },
  };

  switch (envelope.type) {
    case 'pipeline.started': {
      const { payload } = envelope;
      return {
        ...base,
        run: {
          ...base.run,
          tableVersion: payload.tableVersion,
          specId: payload.spec.id,
          specSha256: payload.spec.sha256,
          snapshotDigest: payload.snapshotDigest,
          plan: payload.plan,
          baseBranch: payload.base.branch,
          baseSha: payload.base.sha,
          integrationBranch: payload.integrationBranch,
          cohorteVersion: payload.cohorteVersion,
          hostId: payload.hostId,
        },
      };
    }
    case 'run.state.changed': {
      const { payload } = envelope;
      // exactOptionalPropertyTypes: `resumeTo`/`stop` are optional keys, so an absent payload value CLEARS the
      // key (never assigns it `undefined`) — a resume back into an active state must drop the stale suspend info.
      const run: typeof base.run = { ...base.run, state: payload.to };
      if (payload.resumeTo !== undefined) run.resumeTo = payload.resumeTo;
      else delete run.resumeTo;
      if (payload.stop !== undefined) run.stop = payload.stop;
      else delete run.stop;
      return { ...base, run };
    }
    case 'run.paused':
      return { ...base, run: { ...base.run, pauseRequested: false } };
    case 'run.resumed':
      return base;
    case 'run.cancelled':
      return { ...base, run: { ...base.run, cancelRequested: false } };
    case 'run.host.attached': {
      const { payload } = envelope;
      return { ...base, run: { ...base.run, hostId: payload.hostId, hostPid: payload.pid } };
    }
    case 'run.host.detached': {
      const run: typeof base.run = { ...base.run };
      delete run.hostId;
      delete run.hostPid;
      delete run.hostStartToken;
      return { ...base, run };
    }
    case 'phase.started': {
      const { payload } = envelope;
      return upsertPhase(base, payload.phase.phaseRunId, () => ({
        runId: base.run.runId,
        phaseRunId: payload.phase.phaseRunId,
        state: payload.phase.state,
        iteration: payload.phase.iteration,
        status: 'running',
        checks: [],
        startedAt: envelope.timestamp,
      }));
    }
    case 'phase.completed': {
      const { payload } = envelope;
      return upsertPhase(base, payload.phase.phaseRunId, (existing) => {
        const record: PhaseRecord = {
          runId: base.run.runId,
          phaseRunId: payload.phase.phaseRunId,
          state: payload.phase.state,
          iteration: payload.phase.iteration,
          status: NODE_STATUS_BY_OUTCOME[payload.outcome],
          outcome: payload.outcome,
          checks: payload.checks,
          endedAt: envelope.timestamp,
        };
        if (existing?.startedAt !== undefined) record.startedAt = existing.startedAt;
        return record;
      });
    }
    case 'agent.declared': {
      const { payload } = envelope;
      const phaseRunId = currentPhaseRunId(base);
      if (!phaseRunId) return base; // no phase open yet: nothing this record can be attached to (see file header)
      const record: AgentRecord = {
        runId: base.run.runId,
        agentId: payload.agent.agentId,
        phaseRunId,
        role: payload.agent.role,
        label: payload.agent.role,
        state: 'declared',
        attempt: payload.agent.attempt,
        incarnation: payload.agent.incarnation,
        maxAttempts: 1,
        maxIncarnations: 5,
        model: payload.requestedModel,
        usage: {},
        createdAt: envelope.timestamp,
        updatedAt: envelope.timestamp,
      };
      if (payload.agent.surface !== undefined) record.surface = payload.agent.surface;
      return { ...base, agents: [...base.agents, record] };
    }
    case 'agent.spawned': {
      const { payload } = envelope;
      return upsertAgent(base, payload.agent.agentId, (agent) => {
        const next: AgentRecord = { ...agent, authMode: payload.authMode, updatedAt: envelope.timestamp };
        if (payload.worktree?.slot !== undefined) next.slot = payload.worktree.slot;
        if (payload.runtimeRef !== undefined) next.runtimeRef = payload.runtimeRef;
        return next;
      });
    }
    case 'agent.started':
      return base;
    case 'agent.state.changed': {
      const { payload } = envelope;
      return upsertAgent(base, payload.agent.agentId, (agent) => ({
        ...agent,
        state: payload.to,
        updatedAt: envelope.timestamp,
      }));
    }
    case 'agent.completed': {
      const { payload } = envelope;
      return upsertAgent(base, payload.agent.agentId, (agent) => ({
        ...agent,
        state: 'completed',
        summary: payload.summary,
        usage: payload.usage,
        updatedAt: envelope.timestamp,
      }));
    }
    case 'agent.failed': {
      const { payload } = envelope;
      return upsertAgent(base, payload.agent.agentId, (agent) => ({
        ...agent,
        lastError: payload.error,
        updatedAt: envelope.timestamp,
      }));
    }
    case 'agent.turn.completed':
    case 'agent.message.completed':
    case 'agent.message.accepted':
    case 'runtime.warning':
    case 'model.requested':
    case 'model.responded':
    case 'context.built':
    case 'escalation.applied':
      return base;
    case 'budget.updated': {
      const { payload } = envelope;
      const index = base.budgets.findIndex(
        (budget) => budget.level === payload.scope.level && budget.scopeId === payload.scope.id,
      );
      const record = {
        runId: base.run.runId,
        level: payload.scope.level,
        scopeId: payload.scope.id,
        consumed: payload.consumed,
        limit: payload.limit,
        updatedAt: envelope.timestamp,
      };
      const budgets = index === -1 ? [...base.budgets, record] : base.budgets.with(index, record);
      return { ...base, budgets };
    }
    case 'budget.exceeded':
    case 'quota.updated':
    case 'auth.required':
    case 'retry.scheduled':
    case 'command.accepted':
    case 'command.completed':
    case 'command.rejected':
    case 'tool.requested':
    case 'tool.denied':
    case 'tool.rejected':
    case 'tool.started':
    case 'tool.completed':
    case 'file.read':
    case 'file.written':
    case 'file.changed':
    case 'review.started':
    case 'review.finding':
    case 'review.completed':
    case 'review.approved':
    case 'approval.requested':
    case 'approval.resolved':
    case 'check.started':
    case 'check.completed':
    case 'checkpoint.created':
    case 'git.merge.completed':
    case 'git.merge.conflicted':
    case 'repo.change.detected':
    case 'lock.acquired':
    case 'lock.released':
    case 'lock.stolen':
      return base;
    case 'git.worktree.created': {
      const { payload } = envelope;
      return upsertWorktree(base, payload.slot, () => ({
        runId: base.run.runId,
        slot: payload.slot,
        path: payload.path,
        branch: payload.branch,
        baseSha: payload.baseSha,
        checkpointSha: payload.baseSha,
        state: 'intent',
      }));
    }
    case 'git.worktree.provisioned': {
      const { payload } = envelope;
      return upsertWorktree(base, payload.slot, (existing) =>
        existing
          ? { ...existing, lockfileSha256: payload.lockfileSha256, state: 'ready' }
          : {
              runId: base.run.runId,
              slot: payload.slot,
              path: '',
              baseSha: '',
              checkpointSha: '',
              lockfileSha256: payload.lockfileSha256,
              state: 'ready',
            },
      );
    }
    case 'git.worktree.quarantined': {
      const { payload } = envelope;
      return upsertWorktree(base, payload.slot, (existing) =>
        existing
          ? { ...existing, state: 'quarantined' }
          : {
              runId: base.run.runId,
              slot: payload.slot,
              path: '',
              baseSha: '',
              checkpointSha: '',
              state: 'quarantined',
            },
      );
    }
    case 'git.worktree.removed': {
      const { payload } = envelope;
      return upsertWorktree(base, payload.slot, (existing) =>
        existing
          ? { ...existing, state: 'removed' }
          : {
              runId: base.run.runId,
              slot: payload.slot,
              path: payload.path,
              baseSha: '',
              checkpointSha: '',
              state: 'removed',
            },
      );
    }
    case 'git.commit.created': {
      const { payload } = envelope;
      return upsertWorktree(base, payload.slot, (existing) =>
        existing
          ? { ...existing, checkpointSha: payload.sha, lastTreeDigest: payload.treeDigest }
          : {
              runId: base.run.runId,
              slot: payload.slot,
              path: '',
              branch: payload.branch,
              baseSha: payload.sha,
              checkpointSha: payload.sha,
              lastTreeDigest: payload.treeDigest,
              state: 'ready',
            },
      );
    }
    case 'pipeline.completed': {
      const { payload } = envelope;
      return { ...base, run: { ...base.run, stop: payload.stop, endedAt: envelope.timestamp } };
    }
    case 'pipeline.failed': {
      const { payload } = envelope;
      return {
        ...base,
        run: {
          ...base.run,
          state: payload.state,
          stop: payload.stop,
          lastError: payload.error,
          endedAt: envelope.timestamp,
        },
      };
    }
    case 'error':
      return { ...base, run: { ...base.run, lastError: envelope.payload.error } };
    default:
      return assertNever(envelope);
  }
}
