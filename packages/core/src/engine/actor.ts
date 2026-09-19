// DESIGN 2.6.7 — actor normalisation: `kind: 'human'` is kept ONLY for `transport: 'cli'`, never upgraded. V3.0 has
// exactly one transport (`ACTOR_TRANSPORTS = ['cli']`, open on the wire), so this only ever fires for a forged or
// future-transport envelope claiming humanity over a channel that cannot prove it.
import type { Actor } from '@cohorte/protocol';

/** Downgrades `human` claimed over a non-`cli` transport to `client`; every other actor passes through unchanged. */
export function normalizeActor(actor: Actor): Actor {
  if (actor.kind === 'human' && actor.transport !== 'cli') return { ...actor, kind: 'client' };
  return actor;
}

/** The actor a SPONTANEOUS (non-command) transition records: `system`, never `human` (deliverable: "the engine never
 * emits a transition with actor human without a causing commandId"). `id` names the engine itself. */
export function systemActor(hostId: string): Actor {
  return { kind: 'system', id: hostId, transport: 'cli' };
}
