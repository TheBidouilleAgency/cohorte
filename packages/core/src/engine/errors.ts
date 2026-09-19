// Small shared helpers the engine's inbox and transition paths both need.
import { type ErrorInfo, errorOf, isErrorCode } from '@cohorte/base';

/**
 * Builds a catalogue `ErrorInfo` for `code` when it IS a catalogue code, else falls back to `conflict/unexpected`
 * and keeps the caller's own code/message in `details.matrixCode` / the message text.
 *
 * DEVIATION (docs/v3/requests/U1.09.md): `packages/core/src/pipeline/command-matrix.ts` (frozen, U0.09) names a few
 * finer-grained rejection codes — `conflict/use-retry`, `conflict/use-resume`, `conflict/use-resume-ack`,
 * `conflict/run-blocked` — that `@cohorte/base`'s `ERROR_CATALOGUE` (frozen, U0.02) does not carry. `errorOf` throws
 * on an uncatalogued code, so a command rejected on one of those cells would otherwise crash the engine instead of
 * rejecting the command. This falls back rather than widening a contract this unit does not own.
 */
export function errorInfoForCode(code: string, message: string): ErrorInfo {
  if (isErrorCode(code)) return errorOf(code, message);
  return errorOf('conflict/unexpected', message, { details: { matrixCode: code } });
}

/** Thrown inside a `store.transact` body to force a rollback when `recordTransition` answers `'duplicate'`: the
 * whole transaction (including any event this body already appended) is undone, and the caller treats it as the
 * no-op DESIGN 4.3 #5 requires ("recordTransition with the same key is a no-op"). Never escapes past its own catch. */
export class TransitionAlreadyRecorded extends Error {
  constructor(idempotencyKey: string) {
    super(`transition ${idempotencyKey} was already recorded`);
    this.name = 'TransitionAlreadyRecorded';
  }
}

/** Thrown inside a `store.transact` body when `StoreTx.claimCommand` answers `false` — another host claimed this
 * command first. Rolls the whole transaction back (nothing of this command's outcome is written) and is reported to
 * the caller as `'claim-lost'`. Never escapes past its own catch. */
export class CommandClaimLost extends Error {
  constructor(commandId: string) {
    super(`command ${commandId} was claimed by another host`);
    this.name = 'CommandClaimLost';
  }
}
