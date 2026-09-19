// The adversary of ADR-0022: someone with write access to the storage who REWRITES an event and recomputes the chain
// so that the hashes still line up. `verifyChain` is what is supposed to catch that, so it must answer — with a
// result — for any bytes it finds, including a `checkpoint.created` whose anchor fields are gone or retyped.
import {
  canonicalJson,
  computeAnchorMac,
  type IsoInstant,
  type JsonValue,
  type RunId,
  type Sha256,
} from '@cohorte/base';
import type { EventDraft, EventRecord } from '@cohorte/persistence/contract';
import { chainHash, toEventRecord, verifyEventRecords } from '@cohorte/persistence/memory';
import { describe, expect, test } from 'vitest';

const ID = 'run_anchor-guard' as RunId;
const KEY = new Uint8Array(32).fill(7);
const T0 = '2026-01-01T00:00:00.000Z' as IsoInstant;
const SHA_A = 'a'.repeat(64) as Sha256;

const started: EventDraft = {
  protocolVersion: '1.0',
  eventId: 'evt_a' as EventDraft['eventId'],
  timestamp: T0,
  runId: ID,
  type: 'check.started',
  source: 'cohorte',
  summary: 'check a started',
  severity: 'info',
  payload: { name: 'a', argv: ['pnpm', 'test'], slot: 'main' },
  redactions: [],
};

const anchorOver = (atSequence: number, hash: string): EventDraft => ({
  protocolVersion: '1.0',
  eventId: 'evt_cp1' as EventDraft['eventId'],
  timestamp: T0,
  runId: ID,
  type: 'checkpoint.created',
  source: 'cohorte',
  summary: `checkpoint at ${atSequence}`,
  severity: 'info',
  payload: {
    atSequence,
    snapshotSha256: SHA_A,
    chainHash: hash,
    chainMac: computeAnchorMac(KEY, ID, atSequence, hash),
    cause: 'interval',
  },
  redactions: [],
});

/** A well-formed two-event journal: one event, then an anchor over it. */
function journal(): EventRecord[] {
  const first = toEventRecord(started, 1, '');
  return [first, toEventRecord(anchorOver(1, first.hash), 2, first.hash)];
}

/** Rewrites the anchor's payload and RE-CHAINS, the way an attacker with write access would. */
function tamperedAnchor(payload: Record<string, unknown>): EventRecord[] {
  const rows = journal();
  const [first, anchor] = rows;
  if (!first || !anchor) throw new Error('journal()');
  const envelope = JSON.parse(anchor.envelope) as Record<string, unknown>;
  const rewritten = canonicalJson({ ...envelope, payload } as unknown as JsonValue);
  return [first, { ...anchor, envelope: rewritten, hash: chainHash(first.hash, rewritten) }];
}

describe('verifyEventRecords: a malformed anchor is a RESULT, never a throw', () => {
  test('the untouched journal verifies, anchor included', () => {
    expect(verifyEventRecords(ID, journal(), KEY)).toEqual({ ok: true, events: 2, anchors: 1 });
  });

  test.for([
    ['an empty payload', {}],
    ['no chainMac', { atSequence: 1, chainHash: 'f'.repeat(64) }],
    ['no chainHash', { atSequence: 1, chainMac: 'f'.repeat(64) }],
    ['atSequence as a string', { atSequence: '1', chainHash: 'f'.repeat(64), chainMac: 'f'.repeat(64) }],
    ['a fractional atSequence', { atSequence: 1.5, chainHash: 'f'.repeat(64), chainMac: 'f'.repeat(64) }],
    ['a negative atSequence', { atSequence: -1, chainHash: 'f'.repeat(64), chainMac: 'f'.repeat(64) }],
  ] as const)('%s: { ok: false, reason: anchor-mac }', ([, payload]) => {
    expect(verifyEventRecords(ID, tamperedAnchor({ ...payload }), KEY)).toEqual({
      ok: false,
      firstBadSequence: 2,
      reason: 'anchor-mac',
    });
  });

  test('without the key a malformed anchor is not even read', () => {
    expect(verifyEventRecords(ID, tamperedAnchor({}))).toEqual({ ok: true, events: 2, anchors: 0 });
  });
});

describe('verifyEventRecords: the claimed tail and the walked journal must agree in BOTH directions', () => {
  test('the journal that matches its run row verifies', () => {
    const rows = journal();
    const last = rows[1];
    if (!last) throw new Error('journal()');
    expect(verifyEventRecords(ID, rows, undefined, { lastSequence: 2, lastHash: last.hash })).toEqual({
      ok: true,
      events: 2,
      anchors: 0,
    });
  });

  test('a journal SHORTER than the run row claims is a gap at the first missing sequence', () => {
    const rows = journal();
    const first = rows[0];
    if (!first) throw new Error('journal()');
    expect(verifyEventRecords(ID, [first], undefined, { lastSequence: 2, lastHash: first.hash })).toEqual({
      ok: false,
      firstBadSequence: 2,
      reason: 'gap',
    });
  });

  test('a journal LONGER than the run row claims is a gap too: an appended, re-chained row', () => {
    // ADR-0022's adversary: append a forged event, re-chain it, and leave `runs.last_sequence` alone. The walk itself
    // is clean, so only the disagreement with the claimed tail can detect it.
    const rows = journal();
    const first = rows[0];
    if (!first) throw new Error('journal()');
    expect(verifyEventRecords(ID, rows, undefined, { lastSequence: 1, lastHash: first.hash })).toEqual({
      ok: false,
      firstBadSequence: 2,
      reason: 'gap',
    });
  });

  test('the right length with the wrong tail hash is a hash mismatch, not a gap', () => {
    expect(verifyEventRecords(ID, journal(), undefined, { lastSequence: 2, lastHash: 'f'.repeat(64) })).toEqual({
      ok: false,
      firstBadSequence: 2,
      reason: 'hash-mismatch',
    });
  });
});
