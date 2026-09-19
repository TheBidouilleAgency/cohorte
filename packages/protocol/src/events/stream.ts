// DESIGN 2.3.3 — the two synthetic, ephemeral lines of a stream. Kept apart from the other families because
// `snapshot` embeds a document, and documents.ts itself reads two payloads of this directory.
import { Type } from 'typebox';
import { RunSnapshotDocument } from '../documents.ts';
import { count, ephemeral } from './declare.ts';

export const HEARTBEAT_INTERVAL_MS = 15_000;

export const STREAM_EVENTS = {
  /** synthetic first line of every stream: a late client gets this, then the durable events after `lastSequence` */
  snapshot: ephemeral(Type.Object({ document: RunSnapshotDocument, lastSequence: count() })),
  /** every 15 s on `--follow` */
  heartbeat: ephemeral(Type.Object({ hostAlive: Type.Boolean(), lastSequence: count() })),
} as const;
