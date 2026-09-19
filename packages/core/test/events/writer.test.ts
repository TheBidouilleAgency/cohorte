// U1.08 deliverable: `createEventWriter` (DESIGN 2.5, 2.3.2, 2.3.6). Tests first (PLAN §3 rule 9).
import type { JsonValue, Redaction, Redactor, RunId } from '@cohorte/base';
import type { DurableEnvelope, EphemeralSpool, StateStore } from '@cohorte/persistence/contract';
import { compareOrder, SUMMARY_MAX_LENGTH } from '@cohorte/protocol';
import { FixedClock, fakeRedactor, SeqIds } from '@cohorte/testkit';
import { makeSpool, makeStore } from '@cohorte/testkit/store-factory';
import { describe, expect, test } from 'vitest';
import type { EphemeralInput, EventDraftInput } from '../../src/contract/types.ts';
import { createEventWriter, EventDraftInvalid, type EventsDeps } from '../../src/events/index.ts';
import { asRunId, seedActiveRun } from '../durability/support.ts';

async function setup() {
  const store: StateStore = await makeStore();
  const clock = new FixedClock();
  const ids = new SeqIds();
  const spool = makeSpool();
  const redactor = fakeRedactor();
  const deps: EventsDeps = { redactor, clock, ids, spool };
  const writer = createEventWriter(deps);
  const runId: RunId = asRunId('writer');
  const lease = await seedActiveRun(store, runId);
  return { store, clock, ids, spool, redactor, writer, runId, lease };
}

/** A redactor that blows up on any value whose JSON contains `needle` (`null`: on every value). */
function redactorExplodingOn(needle: string | null): Redactor {
  return {
    registerSecret() {
      throw new Error('not used in this test');
    },
    sealText(text) {
      return { text: text as never, redactions: [] };
    },
    sealJson(value) {
      if (needle === null || JSON.stringify(value).includes(needle)) throw new Error('simulated redactor failure');
      return { value: value as never, redactions: [] };
    },
  };
}

const checkStarted = (summary: string, payload: JsonValue): EventDraftInput => ({
  type: 'check.started',
  summary,
  payload,
});

describe('createEventWriter.append', () => {
  test('strict-validates the payload: an unknown key is rejected', async () => {
    const { store, writer, runId, lease } = await setup();
    await expect(
      store.transact({ runId }, lease, (tx) =>
        writer.append(tx, [
          {
            type: 'check.started',
            summary: 'check started',
            // `payload` is `JsonValue`-typed (no compile-time excess-property check); `extra` is rejected at
            // RUNTIME by `compileStrict`'s closed schema, which is what this test asserts.
            payload: { name: 'lint', argv: ['pnpm', 'lint'], slot: 'main', extra: true },
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(EventDraftInvalid);
  });

  test('a redactor exception replaces the event and drops the raw payload', async () => {
    const { store, clock, ids, spool, runId, lease } = await setup();
    const secretPayload = { name: 'lint', argv: ['pnpm', 'lint', 'BOOM'], slot: 'main' };
    const writer = createEventWriter({ redactor: redactorExplodingOn('BOOM'), clock, ids, spool });

    const [event] = await store.transact({ runId }, lease, (tx) =>
      writer.append(tx, [checkStarted('check started', secretPayload)]),
    );

    expect(event).toBeDefined();
    expect(event?.type).toBe('runtime.warning');
    expect(event?.severity).toBe('error');
    const payload = event?.payload as { code: string; message: string };
    expect(payload.code).toBe('security/redaction-failed');
    expect(JSON.stringify(payload)).not.toContain('BOOM');
  });

  test('the trigger in the SUMMARY: the substitute reuses nothing of the draft, so the transaction still commits', async () => {
    const { store, clock, ids, spool, runId, lease } = await setup();
    // DESIGN 2.3.6's `summary` is the agent-controlled human-facing string, so a secret can land THERE rather than
    // in the payload. A substitute that reuses the original summary hits the same content, throws again, and the
    // exception escapes `append()` — rolling back the caller's whole transaction (inside `EffectJournal.run` that is
    // tx A: no intent row, no effect) instead of degrading to `security/redaction-failed`.
    const writer = createEventWriter({ redactor: redactorExplodingOn('SECRET'), clock, ids, spool });

    const [event] = await store.transact({ runId }, lease, (tx) =>
      writer.append(tx, [
        checkStarted('token SECRET leaked into the summary', { name: 'lint', argv: ['pnpm', 'lint'], slot: 'main' }),
      ]),
    );

    expect(event?.type).toBe('runtime.warning');
    expect(event?.severity).toBe('error');
    expect((event?.payload as { code: string } | undefined)?.code).toBe('security/redaction-failed');
    for (const fragment of ['SECRET', 'token', 'leaked']) expect(event?.summary).not.toContain(fragment);
    // And the transaction committed: the event is in the store, not lost with everything else the caller wrote.
    expect((await store.getRun(runId))?.lastSequence).toBe(1);
  });

  test('a redactor that fails on the substitute too drops that event, it never rolls the caller back', async () => {
    const { store, clock, ids, spool, runId, lease } = await setup();
    // Beyond substitution: nothing can be sealed, so nothing can be persisted for this draft. Dropping the single
    // event keeps the enclosing transaction — and the effect rows it carries — alive; throwing would destroy them.
    const writer = createEventWriter({ redactor: redactorExplodingOn(null), clock, ids, spool });

    const appended = await store.transact({ runId }, lease, (tx) =>
      writer.append(tx, [checkStarted('check started', { name: 'lint', argv: ['pnpm', 'lint'], slot: 'main' })]),
    );

    expect(appended).toEqual([]);
    expect((await store.getRun(runId))?.lastSequence).toBe(0);
  });

  test('the summary is capped at 200 characters, on a codepoint boundary', async () => {
    const { store, writer, runId, lease } = await setup();
    const [long] = await store.transact({ runId }, lease, (tx) =>
      writer.append(tx, [
        {
          type: 'check.started',
          summary: 'y'.repeat(500),
          payload: { name: 'lint', argv: ['pnpm', 'lint'], slot: 'main' },
        },
      ]),
    );
    expect(long?.summary).toHaveLength(SUMMARY_MAX_LENGTH);

    // 199 'y' + U+1F600: a naive `slice(0, 200)` keeps the astral character's HIGH surrogate alone, which the
    // envelope's own pattern does not reject — it would persist a broken string in a human-facing field.
    const [astral] = await store.transact({ runId }, lease, (tx) =>
      writer.append(tx, [
        {
          type: 'check.started',
          summary: `${'y'.repeat(SUMMARY_MAX_LENGTH - 1)}\u{1f600}`,
          payload: { name: 'lint', argv: ['pnpm', 'lint'], slot: 'main' },
        },
      ]),
    );
    const summary = astral?.summary ?? '';
    expect(summary).toHaveLength(SUMMARY_MAX_LENGTH - 1);
    expect([...summary].every((character) => character === 'y')).toBe(true);
    const lastUnit = summary.charCodeAt(summary.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdfff).toBe(false); // no lone surrogate survived the cap
  });

  test('the summary is sanitised before validation: no control character survives', async () => {
    const { store, writer, runId, lease } = await setup();
    const [event] = await store.transact({ runId }, lease, (tx) =>
      writer.append(tx, [
        {
          type: 'check.started',
          summary: 'progress \x1b[2K\nnext line',
          payload: { name: 'lint', argv: ['pnpm', 'lint'], slot: 'main' },
        },
      ]),
    );
    // Biome disallows a control-character literal inside a regex (even escaped), so the C0/C1 check below
    // mirrors `isControlCodepoint` (packages/core/src/events/index.ts) directly instead of a pattern.
    const hasControlCharacter = [...(event?.summary ?? '')].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    });
    expect(hasControlCharacter).toBe(false);
    expect(event?.summary).toContain('�');
  });

  test('type level: appendEvents refuses an unsealed draft', async () => {
    const { store, runId, lease } = await setup();
    await store.transact({ runId }, lease, (tx) => {
      const unsealed = {
        protocolVersion: '1.0' as const,
        eventId: 'evt_00000000000000000000000000000001',
        timestamp: '2026-01-01T00:00:00.000Z',
        runId,
        type: 'check.started' as const,
        source: 'cohorte' as const,
        summary: 'x',
        severity: 'info' as const,
        payload: { name: 'lint', argv: [], slot: 'main' },
        redactions: [] as Redaction[],
      };
      // @ts-expect-error — StoreTx.appendEvents only accepts SealedEventDraft[]; a plain EventDraft is not Sealed<T>
      tx.appendEvents([unsealed]);
    });
  });
});

const messageCompleted = (messageId: string): EventDraftInput => ({
  type: 'agent.message.completed',
  summary: `${messageId} done`,
  payload: { messageId, role: 'assistant', preview: 'hello', textSha256: 'a'.repeat(64), bytes: 5 },
});

const delta = (messageId: string, contentIndex: number): EphemeralInput => ({
  type: 'agent.message.delta',
  payload: { messageId, channel: 'text', contentIndex, delta: 'hi' },
});

interface SpooledLine {
  sequence: number;
  sub: number;
  type: string;
}

async function spooled(spool: EphemeralSpool, runId: RunId): Promise<SpooledLine[]> {
  const lines: SpooledLine[] = [];
  for await (const line of spool.tail(runId, { sequence: 0, sub: 0 }, AbortSignal.timeout(50))) {
    lines.push(JSON.parse(line));
  }
  return lines;
}

const orderOf = (e: DurableEnvelope | undefined) => ({ sequence: e?.sequence ?? -1, sub: e?.sub ?? -1 });

describe('createEventWriter.ephemeral', () => {
  test('ephemerals emitted after a committed batch sort after it, in (sequence, sub) order', async () => {
    const { store, spool, writer, runId, lease } = await setup();

    const [completed] = await store.transact({ runId }, lease, (tx) => writer.append(tx, [messageCompleted('msg-1')]));
    expect(completed?.sequence).toBeGreaterThan(0);
    expect(completed?.sub).toBe(0);

    writer.ephemeral(runId, delta('msg-2', 0));
    writer.ephemeral(runId, delta('msg-2', 1));

    const lines = await spooled(spool, runId);
    expect(lines).toHaveLength(2);
    // Total order: the durable completion of message 1 sorts strictly before both deltas of message 2, and the
    // deltas themselves keep their emission order.
    for (const line of lines) {
      expect(line.type).toBe('agent.message.delta');
      expect(compareOrder(orderOf(completed), line)).toBeLessThan(0);
    }
    expect(
      compareOrder(lines[0] as { sequence: number; sub: number }, lines[1] as { sequence: number; sub: number }),
    ).toBeLessThan(0);
  });

  // KNOWN GAP, pinned on purpose — request R6 / the G1 lead decision. DESIGN 2.3.2's ordering rule covers the case
  // where message 1's durable drafts are STILL PENDING in the producer's <= 50 ms batch (DESIGN 4.2 E7) when the
  // deltas of message 2 are produced: they must be enqueued behind that batch and stamped only after it commits.
  // The frozen `EventWriter` port cannot express it (`append` is called inside the transaction, `StoreTx` has no
  // commit hook), so the deltas are stamped BEFORE the completion instead. The assertion below states TODAY's order
  // positively, which is the only spelling that goes red for the right reason: `test.fails` would have accepted any
  // throw in this body (a slow `spooled()` timeout included) as "still failing", i.e. stayed green while covering
  // nothing. Nobody can close R6 and leave this file claiming coverage it does not have.
  test('R6: under batching the order DESIGN 2.3.2 wants is not reachable behind the frozen port', async () => {
    const { store, spool, writer, runId, lease } = await setup();

    // The producer is still assembling message 1's batch: nothing has reached `append()` yet.
    writer.ephemeral(runId, delta('msg-2', 0));
    writer.ephemeral(runId, delta('msg-2', 1));

    const [completed] = await store.transact({ runId }, lease, (tx) => writer.append(tx, [messageCompleted('msg-1')]));

    const lines = await spooled(spool, runId);
    expect(lines).toHaveLength(2);
    // DESIGN 2.3.2 wants `toBeLessThan(0)` here (the completion of message 1 before the deltas of message 2). This
    // goes RED the moment the batch seam of R6 lands — which is exactly when it must be rewritten to the rule.
    for (const line of lines) expect(compareOrder(orderOf(completed), line)).toBeGreaterThan(0);
  });

  test('a rolled-back transaction never leaves the cursor above the store (2.3.2: the last COMMITTED sequence)', async () => {
    const { store, spool, writer, runId, lease } = await setup();

    // Two durable events appended and then rolled back: `runs.last_sequence` never moves.
    await expect(
      store.transact({ runId }, lease, (tx) => {
        writer.append(tx, [messageCompleted('msg-1'), messageCompleted('msg-2')]);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await store.getRun(runId))?.lastSequence).toBe(0);

    // The next COMMITTED durable event legitimately takes sequence 1, not 3.
    const [first] = await store.transact({ runId }, lease, (tx) => writer.append(tx, [messageCompleted('msg-1')]));
    expect(first?.sequence).toBe(1);

    writer.ephemeral(runId, delta('msg-2', 0));
    const [line] = await spooled(spool, runId);
    if (!line) throw new Error('no ephemeral spooled');
    expect(compareOrder(orderOf(first), line)).toBeLessThan(0);

    // And the ephemeral did not claim a place ABOVE a durable event that has not happened yet: the next one takes
    // sequence 2 and still sorts after it. With the cursor left at the rolled-back high-water mark of 2, the
    // ephemeral would have been stamped (2, 1) — after an event emitted later.
    const [second] = await store.transact({ runId }, lease, (tx) => writer.append(tx, [messageCompleted('msg-3')]));
    expect(second?.sequence).toBe(2);
    expect(compareOrder(line, orderOf(second))).toBeLessThan(0);
  });

  // Gate G1, docs/v3/requests/U1.08.md R9: `EphemeralInput` was widened with `source` and `severity` so that a
  // message's deltas and its durable `agent.message.completed` can be attributed to the SAME producer, and so that
  // `severity: 'progress'` — which DESIGN 2.3.2 lists for exactly these events — is reachable at all.
  test('source and severity are forwarded, and default to cohorte/info when the producer names neither', async () => {
    const { spool, writer, runId } = await setup();
    writer.ephemeral(runId, { ...delta('msg-1', 0), source: 'runtime', severity: 'progress' });
    writer.ephemeral(runId, delta('msg-1', 1));

    const lines = (await spooled(spool, runId)).map((line) => line as unknown as { source: string; severity: string });
    expect(lines.map((line) => [line.source, line.severity])).toEqual([
      ['runtime', 'progress'],
      ['cohorte', 'info'],
    ]);
  });

  test('an unknown payload key is dropped silently (ephemeral loss is acceptable)', async () => {
    const { spool, writer, runId } = await setup();
    writer.ephemeral(runId, {
      type: 'agent.message.delta',
      // Deliberately malformed to exercise the drop path: `payload` is `JsonValue`-typed (no compile-time
      // excess-property check), `extra` is rejected at RUNTIME by `compileStrict`'s closed schema.
      payload: { messageId: 'x', channel: 'text', contentIndex: 0, delta: 'y', extra: true },
    });
    const lines: unknown[] = [];
    for await (const line of spool.tail(runId, { sequence: 0, sub: 0 }, AbortSignal.timeout(20))) lines.push(line);
    expect(lines).toHaveLength(0);
  });
});
