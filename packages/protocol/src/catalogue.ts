// DESIGN 2.3.2 / 2.3.3 — the EVENTS table IS the catalogue of Cohorte Protocol 1.0: one declaration per event type
// (payload schema + durability). No `effect.*` type (effect-journal rows are not events), no engine identifier.
// Changing the durability of a row, removing a row or adding a required field is a MAJOR.
import { bindCatalogue } from './compile.ts';
import type { DurableTypeOf, EnvelopeOf, EventTable, PayloadOf } from './envelope.ts';
import { AGENT_EVENTS } from './events/agent.ts';
import { GIT_EVENTS } from './events/git.ts';
import { GOVERNANCE_EVENTS } from './events/governance.ts';
import { RUN_EVENTS } from './events/run.ts';
import { STREAM_EVENTS } from './events/stream.ts';
import { TOOL_EVENTS } from './events/tool.ts';

export const EVENTS = {
  ...RUN_EVENTS,
  ...AGENT_EVENTS,
  ...TOOL_EVENTS,
  ...GOVERNANCE_EVENTS,
  ...GIT_EVENTS,
  ...STREAM_EVENTS,
} as const satisfies EventTable;

export type EventType = keyof typeof EVENTS;
export type Payload<T extends EventType> = PayloadOf<typeof EVENTS, T>;
export type Envelope<T extends EventType = EventType> = EnvelopeOf<typeof EVENTS, T>;
/** The only types a reducer may consume (C5): `evolve` takes `Envelope<DurableEventType>`. */
export type DurableEventType = DurableTypeOf<typeof EVENTS>;
export type EphemeralEventType = Exclude<EventType, DurableEventType>;

export const EVENT_TYPES = Object.keys(EVENTS) as readonly EventType[];
export const DURABLE_EVENT_TYPES = EVENT_TYPES.filter(
  (type) => EVENTS[type].durability === 'durable',
) as readonly DurableEventType[];

export const isEventType = (type: string): type is EventType => Object.hasOwn(EVENTS, type);
export const isDurableEventType = (type: string): type is DurableEventType =>
  isEventType(type) && EVENTS[type].durability === 'durable';

/**
 * `compileStrict(type)`, `compileStrictEnvelope(type)` and `toOpenJsonSchema()` with the exact signatures of
 * DESIGN 2.3.2, bound to EVENTS. The functions of the same names in compile.ts are generic over a table.
 */
export const catalogue = bindCatalogue(EVENTS);
