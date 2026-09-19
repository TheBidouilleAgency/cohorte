// The command inbox write (D5), shared verbatim by `StateStore.enqueueCommand` (its own `BEGIN IMMEDIATE`) and
// `StoreTx.enqueueCommand` (the caller's already-open transaction) — same row, same three outcomes, one place.
import type { Clock } from '@cohorte/base';
import { sha256Hex } from '@cohorte/base';
import { type CommandEnvelope, canonicalCommandBody } from '@cohorte/protocol';
import type { CommandRecord, SqlDriver } from '../contract.ts';
import { getRow, insertRow, type Row } from './marshal.ts';

export type EnqueueStatus = 'enqueued' | 'duplicate' | 'id-reuse-conflict';

export function enqueueCommandRow(
  driver: SqlDriver,
  cmd: CommandEnvelope,
  clock: Clock,
): { status: EnqueueStatus; record: CommandRecord } {
  const bodySha256 = sha256Hex(canonicalCommandBody(cmd));
  const existing = getRow(driver, 'commands', ['command_id'], [cmd.commandId]) as CommandRecord | undefined;
  if (existing) {
    return { status: existing.bodySha256 === bodySha256 ? 'duplicate' : 'id-reuse-conflict', record: existing };
  }
  const now = clock.now();
  const record: CommandRecord = {
    commandId: cmd.commandId,
    ...(cmd.runId === undefined ? {} : { runId: cmd.runId }),
    type: cmd.type,
    bodySha256,
    envelope: cmd,
    ...(cmd.auth ? { authScheme: cmd.auth.scheme, authValue: cmd.auth.value } : {}),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  insertRow(driver, 'commands', record as unknown as Row);
  return { status: 'enqueued', record };
}
