// DESIGN 4.2 (E2, E8), 4.3 (#18), spec 11.3 — `checkpoint.created` with a chain MAC anchor, `writeSnapshot` AFTER
// the events. Two SEPARATE `store.transact()` calls, not one: crash point #18
// (`checkpoint.after-events-before-snapshot`) can only land "events without the new snapshot" on disk if the events
// already committed in their own transaction before the crash — DESIGN 4.2's single `tx { … }` line for this step is
// a compressed depiction of the two.

import type { RunId } from '@cohorte/base';
import { canonicalJson, type JsonValue, sha256Hex } from '@cohorte/base';
import type { LeaseToken } from '@cohorte/persistence/contract';
import type { CheckpointCause, HostContext } from '../contract/types.ts';
import { crashpoint } from '../durability/crashpoints.ts';
import type { RunEngineDeps } from './deps.ts';

export interface WriteCheckpointArgs {
  deps: RunEngineDeps;
  runId: RunId;
  host: HostContext;
  lease: LeaseToken;
  cause: CheckpointCause;
}

/**
 * Reads the current run tree, seals it, hashes it, anchors a chain MAC over the run's chain tip AS IT STOOD before
 * this checkpoint, appends `checkpoint.created`, then — after the crash point — writes the `StoredSnapshot`.
 *
 * `RunTreeRows` is read through a round trip (`JSON.parse(JSON.stringify(…))`) before it is handed to
 * `canonicalJson`/`redactor.sealJson`: several of its members (`ErrorInfo`, embedded via `RunRecord.lastError` /
 * `StopRecord`) are `interface`s, and only an object TYPE gets the implicit string-index signature
 * `T extends JsonValue` needs (the same limitation `packages/core/src/events/index.ts` documents for `EventDraft`).
 * A JSON round trip re-states the same values as plain object-type literals — nothing renamed, nothing reshaped —
 * without the bespoke `DeepJson<T>` mapped type that file needed for a value sealed one field at a time; a whole
 * run tree is sealed here in one pass, so the round trip is the smaller mechanism for the same purpose.
 */
export async function writeCheckpoint({ deps, runId, host, lease, cause }: WriteCheckpointArgs): Promise<void> {
  const runState = await deps.store.readRunTree(runId);
  const plainState = JSON.parse(JSON.stringify(runState)) as JsonValue;
  const stateSha256 = sha256Hex(canonicalJson(plainState));
  const sealedState = deps.redactor.sealJson(plainState).value;

  let checkpointAtSequence = 0;
  await deps.store.transact({ runId }, lease, (tx) => {
    const before = tx.run();
    const atSequence = before.lastSequence;
    const chainHash = before.lastHash;
    const chainMac = deps.authenticator.anchor(runId, atSequence, chainHash, deps.projectKey);
    const [envelope] = deps.events.append(tx, [
      {
        type: 'checkpoint.created',
        payload: { atSequence, snapshotSha256: stateSha256, chainHash, chainMac, cause },
        summary: `checkpoint (${cause})`,
      },
    ]);
    checkpointAtSequence = envelope ? envelope.sequence : atSequence;
  });

  crashpoint('checkpoint.after-events-before-snapshot');

  await deps.store.transact({ runId }, lease, (tx) => {
    tx.writeSnapshot({
      runId,
      atSequence: checkpointAtSequence,
      schemaVersion: deps.schemaVersion,
      cohorteVersion: host.cohorteVersion,
      stateSha256,
      state: sealedState,
    });
  });
}
