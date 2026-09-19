// DESIGN 2.3.2 / ADR-0019 — one envelope for durable and ephemeral events; total order = (sequence, sub).
import { EventId, IsoInstant, Redaction, RunId } from '@cohorte/base';
import { type Static, type TSchema, Type } from 'typebox';
import { ClosedEnum } from './open-enum.ts';
import { AgentRef, PhaseRef } from './refs.ts';

export const PROTOCOL_VERSION = '1.0';

export const DURABILITIES = ['durable', 'ephemeral'] as const;
export const Durability = ClosedEnum(DURABILITIES);
export type Durability = Static<typeof Durability>;

export const EVENT_SOURCES = ['cohorte', 'runtime', 'client', 'human'] as const;
export const EVENT_SEVERITIES = ['info', 'success', 'warning', 'error', 'progress'] as const;

export const SUMMARY_MAX_LENGTH = 200;
/** No C0/C1 control character at all (no tab, no newline, no ESC): the shared presentation contract of every client (2.3.6). */
export const SUMMARY_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f]*$';

export const EnvelopeBase = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  eventId: EventId,
  /** durable: own gapless per-run sequence (1..n). ephemeral: sequence of the last COMMITTED durable event when it is STAMPED */
  sequence: Type.Integer({ minimum: 0 }),
  /** durable: 0. ephemeral: 1.. after that durable sequence */
  sub: Type.Integer({ minimum: 0 }),
  durability: Durability,
  timestamp: IsoInstant,
  runId: RunId,
  /** narrowed per event */
  type: Type.String({ minLength: 1 }),
  source: ClosedEnum(EVENT_SOURCES),
  phase: Type.Optional(PhaseRef),
  agent: Type.Optional(AgentRef),
  /** eventId or commandId that caused this event */
  causationId: Type.Optional(Type.String()),
  /** one line, sealed; EventWriter replaces control characters by U+FFFD BEFORE validation */
  summary: Type.String({ maxLength: SUMMARY_MAX_LENGTH, pattern: SUMMARY_PATTERN }),
  severity: ClosedEnum(EVENT_SEVERITIES),
  /** narrowed per event */
  payload: Type.Unknown(),
  redactions: Type.Array(Redaction),
});
export type EnvelopeBase = Static<typeof EnvelopeBase>;

/** One row of an events table: this pair IS the catalogue entry of a type (2.3.3). */
export interface EventDeclaration<P extends TSchema = TSchema> {
  readonly payload: P;
  readonly durability: Durability;
}
export type EventTable = Readonly<Record<string, EventDeclaration>>;

export type PayloadOf<E extends EventTable, T extends keyof E> = Static<E[T]['payload']>;

/** `Envelope<T>` of DESIGN 2.3.2, over any table: the catalogue binds it to EVENTS. Distributes over a union of types. */
export type EnvelopeOf<E extends EventTable, T extends keyof E & string = keyof E & string> = {
  [K in T]: Omit<EnvelopeBase, 'type' | 'payload' | 'durability'> & {
    type: K;
    durability: E[K]['durability'];
    payload: PayloadOf<E, K>;
  };
}[T];

/** The types of a table that are durable: the only ones a reducer may consume (C5). */
export type DurableTypeOf<E extends EventTable> = {
  [K in keyof E & string]: E[K]['durability'] extends 'durable' ? K : never;
}[keyof E & string];

/** Total order of a stream. */
export function compareOrder(
  a: { readonly sequence: number; readonly sub: number },
  b: { readonly sequence: number; readonly sub: number },
): number {
  return a.sequence - b.sequence || a.sub - b.sub;
}
