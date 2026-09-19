// DESIGN 2.5.4 — agent lifecycle (spec 6), verbatim: the state machine and reincarnation, the ONLY way to reach
// `spawning` without going through `failed -> retrying|escalated`.
import { CohorteError, errorOf } from '@cohorte/base';
import type { AgentRecord } from '@cohorte/persistence/contract';
import type { AgentState } from '@cohorte/protocol';

export const AGENT_TRANSITIONS = {
  /** planned = context manifest built + grants computed + slot acquired */
  declared: ['planned', 'cancelled'],
  planned: ['spawning', 'cancelled'],
  /** effect agent.spawn, key = `${runId}:${agentId}:${incarnation}`; -> spawning = the host died mid-spawn (crash point #9): reincarnation */
  spawning: ['running', 'failed', 'cancelled', 'spawning'],
  /** -> spawning = REINCARNATION (below) */
  running: ['waiting', 'paused', 'completed', 'failed', 'cancelled', 'spawning'],
  /** blocked on approval / quota / a serialized peer */
  waiting: ['running', 'paused', 'failed', 'cancelled', 'spawning'],
  paused: ['running', 'cancelled', 'spawning'],
  /** only if error.retryable && attempt < maxAttempts */
  failed: ['retrying', 'escalated', 'cancelled'],
  /** attempt+1, incarnation+1, SAME context hash: the SpawnRequest minus {incarnation} is byte-identical (FakeLedger assertion) */
  retrying: ['spawning', 'cancelled'],
  escalated: ['spawning', 'cancelled'],
  completed: [],
  cancelled: [],
} as const satisfies Record<AgentState, readonly AgentState[]>;

/** the four edges spawning|running|waiting|paused -> spawning are legal REINCARNATION sources */
const REINCARNATE_SOURCES = ['spawning', 'running', 'waiting', 'paused'] as const satisfies readonly AgentState[];

/**
 * The four edges `spawning|running|waiting|paused -> spawning` are REINCARNATIONS: the runtime session is gone but
 * the WORK did not fail. They carry a cause and are the ONLY way to reach `spawning` without going through
 * `failed -> retrying|escalated`.
 */
export type ReincarnateCause =
  /** host died or was restarted: 4.4 step 10 */
  | 'recovery'
  /** approval wait exceeded parkAfterMinutes, or quota/auth suspension: 4.5 */
  | 'park'
  /** paused longer than host.pauseKeepAliveMinutes: 4.6 */
  | 'pause-expiry';

/**
 * `attempt` counts retries of the work; `incarnation` counts runtime sessions. Rule, stated once: `attempt` is
 * incremented by exactly two edges — `failed -> retrying` and `failed -> escalated` — and by nothing else. A
 * recovery after a host death, a parked approval and an expired pause are reincarnations of the same attempt: they
 * do not consume `maxAttempts`, they count against `maxIncarnations` (default 5).
 *
 * Throws (DESIGN 2.5.4) on a terminal state — a `completed` agent is never re-spawned by `resume` — and on any other
 * state that is not one of the four legal reincarnation sources; throws `budget/incarnations` when reincarnating
 * would exceed `maxIncarnations`, which is the `failed{budget/incarnations}` the supervisor records for the agent.
 * A caller that only try/catches therefore never re-spawns an exhausted agent.
 */
export function reincarnate(agent: AgentRecord, cause: ReincarnateCause): AgentRecord {
  if (!(REINCARNATE_SOURCES as readonly string[]).includes(agent.state)) {
    throw new TypeError(
      `reincarnate: agent ${agent.agentId} is ${agent.state}, not one of ${REINCARNATE_SOURCES.join(', ')}`,
    );
  }
  const nextIncarnation = agent.incarnation + 1;
  if (nextIncarnation > agent.maxIncarnations) {
    throw new CohorteError(
      errorOf(
        'budget/incarnations',
        `agent ${agent.agentId} would reincarnate past its limit of ${agent.maxIncarnations} incarnations (cause: ${cause})`,
      ),
    );
  }
  return { ...agent, state: 'spawning', incarnation: nextIncarnation };
}
