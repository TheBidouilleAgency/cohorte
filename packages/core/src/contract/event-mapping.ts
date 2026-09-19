// DESIGN 2.3.3 "the one mapper, as a table" — the `RuntimeEvent -> protocol Envelope` mapping, frozen as DATA in
// Wave 0 so the mapper written in Wave 3 (`U3.03`, `core/src/agents/supervisor/map.ts`) discovers nothing: both
// unions (`RuntimeEventType`, protocol `EventType`) are frozen at G0, and so is this table with them.
import type { EventType } from '@cohorte/protocol';
import type { RuntimeEventType } from '@cohorte/runtime-contract';

/** A protocol event type, or one of the two documented special cases: `'host-emitted'` (`tool.call.requested`:
 * `tool.requested` is emitted by `CohorteToolHost` stage 0 itself, not by this mapper — the mapper only asserts the
 * runtime event exists) and `'not-forwarded'` (`tool.call.delivered`: folded into `tool.completed.waitedMs` and the
 * runtime snapshot, DESIGN 2.3.3). */
export type MappingTarget = EventType | 'host-emitted' | 'not-forwarded';

/**
 * The target(s) a `RuntimeEvent` of this source type maps to. One row of DESIGN 2.3.3 has TWO targets and is written
 * as a tuple rather than dropped: `agent.exited` becomes **`agent.completed` or `agent.failed`**, "decided by the
 * supervisor from `AgentExit` + the accepted result" (DESIGN 2.5.4). Naming only the first would have left the
 * mapper of Wave 3 (`U3.03`) to discover the second branch, which is exactly what freezing this table prevents; the
 * table says WHICH targets are legal, the supervisor still decides which one a given exit takes. Read a row through
 * {@link targetsOf} to get a uniform list.
 *
 * `agent.paused` / `agent.resumed` both target `agent.state.changed` (the mapper fills `from`/`to`/`reason` from the
 * runtime event and the supervisor's own bookkeeping).
 */
export const RUNTIME_EVENT_TARGETS = {
  'agent.spawned': 'agent.spawned',
  'agent.started': 'agent.started',
  'agent.turn.started': 'agent.turn.started',
  'agent.turn.completed': 'agent.turn.completed',
  'agent.message.started': 'agent.message.started',
  'agent.message.delta': 'agent.message.delta',
  'agent.message.completed': 'agent.message.completed',
  'agent.message.accepted': 'agent.message.accepted',
  'model.requested': 'model.requested',
  'model.responded': 'model.responded',
  'tool.call.requested': 'host-emitted',
  'tool.call.rejected': 'tool.rejected',
  'tool.call.progress': 'tool.progress',
  'tool.call.delivered': 'not-forwarded',
  'agent.paused': 'agent.state.changed',
  'agent.resumed': 'agent.state.changed',
  'agent.exited': ['agent.completed', 'agent.failed'],
  'runtime.warning': 'runtime.warning',
} as const satisfies Record<RuntimeEventType, MappingTarget | readonly [MappingTarget, ...MappingTarget[]]>;

type Flatten<T> = T extends readonly (infer Element)[] ? Element : T;
export type RuntimeEventTarget = Flatten<(typeof RUNTIME_EVENT_TARGETS)[keyof typeof RUNTIME_EVENT_TARGETS]>;

/** Every legal target of one source type, single-valued rows included — what a mapper iterates over. */
export function targetsOf(type: RuntimeEventType): readonly RuntimeEventTarget[] {
  const target: MappingTarget | readonly MappingTarget[] = RUNTIME_EVENT_TARGETS[type];
  return (typeof target === 'string' ? [target] : target) as readonly RuntimeEventTarget[];
}

/** The two rows whose target is not a real protocol event type: no durability to compare there. */
export const SPECIAL_MAPPING_TARGETS = ['host-emitted', 'not-forwarded'] as const;
