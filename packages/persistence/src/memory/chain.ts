// The hash chain of the event journal (DESIGN 2.4, ADR-0022), as pure functions over `EventRecord`s: every store
// hashes and verifies with these, so a journal written by one verifies in another.
import { timingSafeEqual } from 'node:crypto';
import { canonicalJson, computeAnchorMac, type JsonValue, type RunId, sha256Hex } from '@cohorte/base';
import type { DurableEnvelope, EventDraft, EventRecord, VerifyChainResult } from '../contract.ts';

/** hash = sha256(prev_hash || '\n' || envelope); the first event chains from the empty string. */
export const chainHash = (prevHash: string, envelope: string): string => sha256Hex(`${prevHash}\n${envelope}`);

/** The row of one sealed draft at `sequence`: the store-assigned fields are part of the hashed envelope. */
export function toEventRecord(draft: EventDraft, sequence: number, prevHash: string): EventRecord {
  const envelope = canonicalJson({ ...draft, sequence, sub: 0, durability: 'durable' } as unknown as JsonValue);
  return {
    runId: draft.runId,
    sequence,
    eventId: draft.eventId,
    type: draft.type,
    timestamp: draft.timestamp,
    source: draft.source,
    ...(draft.phase ? { phaseRunId: draft.phase.phaseRunId } : {}),
    ...(draft.agent ? { agentId: draft.agent.agentId } : {}),
    ...(draft.causationId === undefined ? {} : { causationId: draft.causationId }),
    severity: draft.severity,
    summary: draft.summary,
    envelope,
    prevHash,
    hash: chainHash(prevHash, envelope),
  };
}

export const envelopeOf = (record: EventRecord): DurableEnvelope => JSON.parse(record.envelope) as DurableEnvelope;

const sameMac = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
};

/**
 * Walks a run's rows in storage order. `tail` is what the run row claims (`last_sequence`, `last_hash`): a journal
 * cut short at the end is a gap too. Anchors (`checkpoint.created`) are checked only when the key is given.
 */
export function verifyEventRecords(
  id: RunId,
  records: readonly EventRecord[],
  key?: Uint8Array,
  tail?: { lastSequence: number; lastHash: string },
): VerifyChainResult {
  const hashes = new Map<number, string>([[0, '']]);
  let expected = 1;
  let prevHash = '';
  let anchors = 0;
  for (const record of records) {
    if (record.sequence < expected) return { ok: false, firstBadSequence: record.sequence, reason: 'duplicate' };
    if (record.sequence > expected) return { ok: false, firstBadSequence: expected, reason: 'gap' };
    const bad = { ok: false, firstBadSequence: record.sequence, reason: 'hash-mismatch' } as const;
    if (record.prevHash !== prevHash || record.hash !== chainHash(prevHash, record.envelope)) return bad;
    let envelope: DurableEnvelope;
    try {
      envelope = envelopeOf(record);
    } catch {
      return bad;
    }
    if (envelope.sequence !== record.sequence || envelope.runId !== id) return bad;
    if (key && envelope.type === 'checkpoint.created') {
      const badAnchor = { ok: false, firstBadSequence: record.sequence, reason: 'anchor-mac' } as const;
      // The stored envelope is untrusted bytes (ADR-0022: the adversary has write access to the DB and recomputes the
      // chain), so the anchor fields are checked before they reach the MAC: a stripped or retyped payload is an
      // unverifiable anchor, which is a RESULT, never a thrown RangeError/TypeError in a security-critical read.
      const { atSequence, chainHash: anchored, chainMac } = envelope.payload;
      if (
        typeof atSequence !== 'number' ||
        !Number.isSafeInteger(atSequence) ||
        atSequence < 0 ||
        typeof anchored !== 'string' ||
        typeof chainMac !== 'string'
      ) {
        return badAnchor;
      }
      const known = hashes.get(atSequence);
      if (known !== anchored || !sameMac(chainMac, computeAnchorMac(key, id, atSequence, anchored))) return badAnchor;
      anchors += 1;
    }
    hashes.set(record.sequence, record.hash);
    prevHash = record.hash;
    expected += 1;
  }
  // The claimed tail must be the walked tail EXACTLY. A journal shorter than the run row claims is the truncation an
  // adversary leaves behind; a journal LONGER than it claims (an appended, correctly re-chained row) is the cheaper
  // attack of the same threat model (ADR-0022), and both are a gap at the first sequence the two sides disagree on.
  if (tail && tail.lastSequence !== expected - 1) {
    return { ok: false, firstBadSequence: Math.min(tail.lastSequence, expected - 1) + 1, reason: 'gap' };
  }
  if (tail && tail.lastHash !== prevHash) {
    return { ok: false, firstBadSequence: Math.max(1, expected - 1), reason: 'hash-mismatch' };
  }
  return { ok: true, events: records.length, anchors };
}
