// @cohorte/core/events — DESIGN 2.5 (EventWriter), 2.3.2 (envelope, ordering under batching), 2.3.6 (summary
// sanitisation). PLAN U1.08. Wave-0 seam (PLAN U0.08) replaced: this file is now the implementation.
//
// `EventsDeps` is the FROZEN contract of `contract/factories.ts`, re-exported below — never a second interface of the
// same name (a composition root typed against the `@cohorte/core` barrel could not then build this writer). It gained
// `spool` in U0.08's fix round 1: the deliverable requires ephemerals to reach the spool port (DESIGN 2.3.2), so the
// frozen type was WIDENED where it lives rather than shadowed here.
import type { Clock, IdSource, JsonValue, Redactor } from '@cohorte/base';
import type { DurableEnvelope, EventDraft, SealedEventDraft, StoreTx } from '@cohorte/persistence/contract';
import {
  catalogue,
  type DurableEventType,
  type EventType,
  isDurableEventType,
  PROTOCOL_VERSION,
  SUMMARY_MAX_LENGTH,
} from '@cohorte/protocol';
import type { EventsDeps } from '../contract/factories.ts';
import type { EventWriter } from '../contract/internal.ts';
import type { EphemeralInput, EventDraftInput } from '../contract/types.ts';

export type { EventsDeps };

/** Codepoint at most 0x1F (C0) or between 0x7F and 0x9F inclusive (C1, DEL included). Built from numbers only: no
 * escape sequence in this file's source, so no tool in the chain can mistake one for the character it denotes. */
function isControlCodepoint(code: number): boolean {
  const c0 = code <= 31;
  const c1 = code >= 127 && code <= 159;
  return c0 || c1;
}

const REPLACEMENT_CHARACTER = String.fromCodePoint(65533); // U+FFFD

/**
 * Every C0/C1 control character replaced by U+FFFD before validation (DESIGN 2.3.6), then capped to
 * SUMMARY_MAX_LENGTH. The cap lands on a CODEPOINT boundary: iterating the string yields whole characters, so an
 * astral character (a surrogate PAIR) is either kept entire or dropped entire — `slice(0, 200)` would leave a lone
 * surrogate in a persisted, human-facing field, which the envelope's `pattern` does not reject. Counting UTF-16 code
 * units keeps `maxLength: 200` true for both a code-unit reader and a codepoint reader (Ajv counts codepoints), since
 * every character costs at least one unit.
 */
function sanitizeSummary(raw: string): string {
  let scrubbed = '';
  for (const character of raw) {
    const kept = isControlCodepoint(character.codePointAt(0) ?? 0) ? REPLACEMENT_CHARACTER : character;
    if (scrubbed.length + kept.length > SUMMARY_MAX_LENGTH) break;
    scrubbed += kept;
  }
  return scrubbed;
}

/** A caller (core code building an EventDraftInput) broke its own contract: not a run outcome, so not a CohorteError. */
export class EventDraftInvalid extends TypeError {
  constructor(type: string, detail: string) {
    super(`EventWriter: invalid payload for "${type}": ${detail}`);
    this.name = 'EventDraftInvalid';
  }
}

type Severity = 'info' | 'success' | 'warning' | 'error' | 'progress';
type Source = 'cohorte' | 'runtime' | 'client' | 'human';

interface CommonFields {
  source: Source;
  phase?: EventDraftInput['phase'];
  agent?: EventDraftInput['agent'];
  causationId?: string;
  summary: string;
  severity: Severity;
}

function validatedPayload(type: EventType, payload: JsonValue): JsonValue {
  const result = catalogue.compileStrict(type)(payload);
  if (!result.ok) {
    const detail = result.error
      .map((issue) => `${issue.path || '(root)'} ${issue.keyword}: ${issue.message}`)
      .join('; ');
    throw new EventDraftInvalid(type, detail);
  }
  return result.value as JsonValue;
}

function commonFieldsOf(input: {
  source?: Source;
  phase?: EventDraftInput['phase'];
  agent?: EventDraftInput['agent'];
  causationId?: string;
  summary: string;
  severity?: Severity;
}): CommonFields {
  return {
    source: input.source ?? 'cohorte',
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    summary: sanitizeSummary(input.summary),
    severity: input.severity ?? 'info',
  };
}

/**
 * A redaction failure REPLACES the event with `runtime.warning{code:'security/redaction-failed'}` and drops the raw
 * payload (DESIGN 2.6.5). `runtime.warning` is the closest catalogue row to the prose "error{...}" placeholder — no
 * event named plainly `error` exists in the catalogue (deviation, recorded in docs/v3/requests/U1.08.md).
 */
const REDACTION_FAILED_TYPE: DurableEventType = 'runtime.warning';

/**
 * The substitute's summary is a CONSTANT, and it is the whole point: it shares nothing with the draft that just blew
 * the redactor up. `summary` is the agent-controlled human-facing string of DESIGN 2.3.6, so the secret that made
 * `seal` throw can perfectly well be in there rather than in the payload; a substitute carrying the original summary
 * would hit the same content, throw again, and let the exception escape `append()` — aborting the caller's whole
 * transaction (inside `EffectJournal.run`, tx A: no intent row, no effect) instead of degrading to
 * `security/redaction-failed`. `causationId` is free-form as well and is dropped for the same reason.
 */
const REDACTION_FAILED_SUMMARY = 'an event was replaced: its redaction failed and its payload was dropped';

/** Builds a plain `Record<string, JsonValue>` by mutation: sidesteps the friction between an interface's optional
 * properties and JsonValue's index signature that a spread/literal of `CommonFields` runs into under
 * exactOptionalPropertyTypes (an absent key never becomes a present key holding `undefined`). */
function envelopeFields(
  base: { protocolVersion: string; eventId: string; timestamp: string; runId: string; type: string },
  common: CommonFields,
  payload: JsonValue,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {
    protocolVersion: base.protocolVersion,
    eventId: base.eventId,
    timestamp: base.timestamp,
    runId: base.runId,
    type: base.type,
    source: common.source,
    summary: common.summary,
    severity: common.severity,
    payload,
  };
  if (common.phase !== undefined) out.phase = common.phase;
  if (common.agent !== undefined) out.agent = common.agent;
  if (common.causationId !== undefined) out.causationId = common.causationId;
  return out;
}

/**
 * `EventDraft` restated so every property structurally satisfies `JsonValue`. TypeScript only grants an object
 * TYPE (not an `interface`) the implicit string index signature that `T extends JsonValue` needs, and DESIGN
 * keeps `ErrorInfo` (nested in several event payloads, e.g. `agent.failed`) an `interface` on purpose — it is
 * self-referential and a derived type would re-expand at every use site (packages/base/src/errors.ts). A
 * homomorphic mapped type re-states the same shape as fresh object-type literals, which DOES get the index
 * signature, without touching a single field name or value — `DeepJson<T>` is mutually assignable to `T`.
 */
type DeepJson<T> = T extends readonly (infer U)[]
  ? DeepJson<U>[]
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends object
      ? { [K in keyof T]: DeepJson<T[K]> }
      : T;

/** {@link EventDraft}, JsonValue-shaped (see {@link DeepJson}): the type `sealJson` is called with below, so its
 * return type is genuinely `Sealed<EventDraft>` (== `SealedEventDraft`) — never asserted (check-layers rule f:
 * only the redactor, packages/security/src/redact/seal.ts, mints `Sealed<T>`). */
type EventDraftJson = DeepJson<EventDraft>;
type EventDraftPreRedactionsJson = Omit<EventDraftJson, 'redactions'>;

/** Seals a durable draft. Two passes: `sealJson` cannot report the redactions it just made back INTO the very
 * value it sealed, so a first pass finds them and a second seals a draft that already carries that (idempotent —
 * nothing new to redact in metadata about redactions) list, so the persisted `redactions` field is accurate
 * (DESIGN 2.3.2). Neither pass ever casts `as Sealed…`: the non-`Sealed` casts below only retype the still-plain
 * envelope as its own (unsealed) JsonValue-shaped mirror, which is what lets `sealJson`'s own generic parameter —
 * not an assertion on its result — mint the precise `SealedEventDraft` this function returns. */
function sealDraft(
  redactor: Redactor,
  ids: IdSource,
  clock: Clock,
  runId: string,
  type: DurableEventType,
  payload: JsonValue,
  common: CommonFields,
): SealedEventDraft {
  const fields = envelopeFields(
    { protocolVersion: PROTOCOL_VERSION, eventId: ids.next<'EventId'>('evt'), timestamp: clock.now(), runId, type },
    common,
    payload,
  ) as unknown as EventDraftPreRedactionsJson;
  const first = redactor.sealJson(fields);
  const withRedactions = { ...first.value, redactions: first.redactions } as unknown as EventDraftJson;
  return redactor.sealJson(withRedactions).value;
}

export function createEventWriter(deps: EventsDeps): EventWriter {
  /** Per run: the last known durable sequence and the next `sub` to hand an ephemeral event at that sequence. */
  const ephemeralCursor = new Map<string, { sequence: number; sub: number }>();
  /** The transactions this writer has already read `runs.last_sequence` from (see `append`). */
  const observedTx = new WeakSet<StoreTx>();

  function cursorFor(runId: string): { sequence: number; sub: number } {
    let cursor = ephemeralCursor.get(runId);
    if (!cursor) {
      cursor = { sequence: 0, sub: 0 };
      ephemeralCursor.set(runId, cursor);
    }
    return cursor;
  }

  /** `undefined` = this draft could not be sealed at all (see the inner catch): it is dropped, never thrown. */
  function sealedDraftOf(runId: string, input: EventDraftInput): SealedEventDraft | undefined {
    if (!isDurableEventType(input.type)) {
      throw new EventDraftInvalid(input.type, 'not a durable event type (use ephemeral() for an ephemeral one)');
    }
    const type = input.type;
    // Validation is a caller bug: it is never turned into a substitute event, only a redaction failure is.
    const payload = validatedPayload(type, input.payload);
    const common = commonFieldsOf(input);
    try {
      return sealDraft(deps.redactor, deps.ids, deps.clock, runId, type, payload, common);
    } catch {
      const substitutePayload: Record<string, JsonValue> = {
        code: 'security/redaction-failed',
        message: 'the redactor failed on this event; its payload was dropped (DESIGN 2.6.5)',
      };
      // `agent` is a host-minted id, not agent-controlled text: it says WHOSE event was replaced and is the one
      // field of the original worth keeping (see REDACTION_FAILED_SUMMARY for what is deliberately not kept).
      if (common.agent !== undefined) substitutePayload.agent = common.agent;
      const substituteCommon: CommonFields = {
        source: common.source,
        ...(common.phase === undefined ? {} : { phase: common.phase }),
        ...(common.agent === undefined ? {} : { agent: common.agent }),
        summary: REDACTION_FAILED_SUMMARY,
        severity: 'error',
      };
      try {
        return sealDraft(
          deps.redactor,
          deps.ids,
          deps.clock,
          runId,
          REDACTION_FAILED_TYPE,
          substitutePayload,
          substituteCommon,
        );
      } catch {
        // A redactor that fails on a constant summary and a payload of two literal strings is broken beyond
        // substitution: nothing can be sealed, so nothing can be persisted for this draft (I7 — an unsealed value
        // never reaches the store). Dropping this ONE event keeps the caller's transaction, and the effect rows it
        // carries, alive; letting the exception out would roll all of it back.
        return undefined;
      }
    }
  }

  return {
    append(tx: StoreTx, drafts: EventDraftInput[]): DurableEnvelope[] {
      const run = tx.run();
      const runId = run.runId;
      const cursor = cursorFor(runId);

      // COMMITTED evidence, read once per transaction: at the first `append()` into `tx`, `runs.last_sequence` is
      // what the store has actually committed (a rolled-back transaction leaves it untouched — DESIGN 2.4's
      // "WAL all-or-nothing"). The envelopes `appendEvents` hands back below are NOT that: they belong to a
      // transaction that has not committed yet, and DESIGN 2.3.2 defines an ephemeral's `sequence` as "the sequence
      // of the last COMMITTED durable event when it is stamped". So the cursor is RECONCILED here against the store
      // before it is advanced optimistically: after a rollback it drops back to the sequence the store really holds,
      // instead of staying above it for ever and stamping ephemerals against a sequence that never existed.
      // Closing the remaining window (an ephemeral stamped BETWEEN the rollback and the next transaction) needs a
      // commit signal the frozen `EventWriter`/`StoreTx` ports do not carry: request R6.
      if (!observedTx.has(tx)) {
        observedTx.add(tx);
        if (run.lastSequence !== cursor.sequence) {
          cursor.sequence = run.lastSequence;
          cursor.sub = 0;
        }
      }

      const sealed: SealedEventDraft[] = [];
      for (const draft of drafts) {
        const one = sealedDraftOf(runId, draft);
        if (one !== undefined) sealed.push(one);
      }
      const appended = tx.appendEvents(sealed);
      for (const envelope of appended) {
        if (envelope.sequence > cursor.sequence) {
          cursor.sequence = envelope.sequence;
          cursor.sub = 0;
        }
      }
      return appended;
    },

    /**
     * KNOWN GAP, request R6 / the G1 lead decision: DESIGN 2.3.2's ordering rule wants an ephemeral "stamped at
     * emission from the writer's queue, not at production — enqueued behind every pending durable draft of the same
     * agent". The frozen `EventWriter` port cannot express that: its only durable entry, `append(tx, drafts)`, is
     * called synchronously INSIDE a store transaction, so the writer never learns that the producer is still
     * assembling a batch (DESIGN 4.2 E7's <= 50 ms window), and `StoreTx` has no commit hook to tell it when one
     * landed. Holding every ephemeral until the next `append()` would trade the ordering violation for a stalled
     * token stream (nothing durable is appended while a model is streaming). So this stamps at production, against
     * the last sequence the store is known to have committed, and `packages/core/test/events/writer.test.ts` pins
     * BOTH what holds and what does not.
     */
    ephemeral(runId, input: EphemeralInput): void {
      const cursor = cursorFor(runId);
      const at = { sequence: cursor.sequence, sub: cursor.sub + 1 };
      let line: string;
      try {
        const payload = validatedPayload(input.type, input.payload);
        // `source` / `severity` are forwarded since gate G1 (docs/v3/requests/U1.08.md R9); `commonFieldsOf` still
        // supplies the `'cohorte'` / `'info'` defaults when the producer names neither.
        const common = commonFieldsOf({
          summary: '',
          phase: input.phase,
          agent: input.agent,
          ...(input.source === undefined ? {} : { source: input.source }),
          ...(input.severity === undefined ? {} : { severity: input.severity }),
        });
        const fields = envelopeFields(
          {
            protocolVersion: PROTOCOL_VERSION,
            eventId: deps.ids.next<'EventId'>('evt'),
            timestamp: deps.clock.now(),
            runId,
            type: input.type,
          },
          common,
          payload,
        );
        fields.sequence = at.sequence;
        fields.sub = at.sub;
        fields.durability = 'ephemeral';
        const first = deps.redactor.sealJson({ ...fields, redactions: [] });
        const withRedactions: Record<string, JsonValue> = { ...first.value, redactions: first.redactions };
        line = JSON.stringify(deps.redactor.sealJson(withRedactions).value);
      } catch {
        // Ephemeral loss is acceptable by definition (DESIGN 2.3.2): a bad draft or a redaction failure drops the
        // single ephemeral event rather than the caller's whole turn.
        return;
      }
      cursor.sub = at.sub;
      deps.spool.append(runId, line);
    },
  };
}
