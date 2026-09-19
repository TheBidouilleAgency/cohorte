// DESIGN 4.3 #19 (`command.external.after-accepted`) — a host that dies between the accept transaction of a
// `pause`/`cancel` and the transaction that commits PAUSED/CANCELLED leaves its durable flag set and the causing
// command `claimed` but unfinished. "Resume does: finish the cancellation idempotently, then `command.completed`."
//
// `StateStore` exposes no "claimed commands" reader (`pendingCommands` returns `status: 'pending'` only, and
// `RunTreeRows` carries no commands), so the engine finds that command the way the journal recorded it: the run's own
// `command.accepted` events, filtered to the external command types, checked against the command row's current
// status. Bounded by the run's journal length, and only ever read when a durable flag is actually set.

import type { CommandId, RunId } from '@cohorte/base';
import type { CommandRecord, StateStore } from '@cohorte/persistence/contract';
import type { StopReason } from '@cohorte/protocol';

/** The command types this engine applies in TWO transactions (DESIGN 4.2 E1: "commands with external effects — cancel,
 * shutdown — use two tx"), each guarded by its own durable flag on the run row. `shutdown` is not one of them here:
 * it is not part of DESIGN 2.5.1's command x state matrix and this skeleton rejects it (docs/v3/requests/U1.09.md R8). */
export const EXTERNAL_COMMAND_TYPES = ['pause', 'cancel'] as const;
export type ExternalCommandType = (typeof EXTERNAL_COMMAND_TYPES)[number];

const EXTERNAL_SET: ReadonlySet<string> = new Set(EXTERNAL_COMMAND_TYPES);

/** The durable `RunRecord` flag an accepted external command sets before its effects run (DESIGN 4.6). */
export const FLAG_OF_EXTERNAL_COMMAND = {
  pause: 'pauseRequested',
  cancel: 'cancelRequested',
} as const satisfies Readonly<Record<ExternalCommandType, 'pauseRequested' | 'cancelRequested'>>;

/** The stop `checkGlobalStops` raises from each flag (DESIGN 2.5.3: "cancel requested -> cancelled | pause requested
 * -> paused"), i.e. which external command a human-actor stop row was caused by. */
export const STOP_OF_EXTERNAL_COMMAND = {
  pause: 'paused',
  cancel: 'cancelled',
} as const satisfies Readonly<Record<ExternalCommandType, StopReason>>;

export function isExternalCommandType(type: string): type is ExternalCommandType {
  return EXTERNAL_SET.has(type);
}

const EVENT_PAGE = 200;

/** Every `pause`/`cancel` of this run whose command row is still `claimed` — i.e. accepted, its durable flag written,
 * and never finished. Oldest first. */
export async function findClaimedExternalCommands(store: StateStore, runId: RunId): Promise<CommandRecord[]> {
  const candidates: CommandId[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = await store.readEvents(runId, {
      afterSequence,
      limit: EVENT_PAGE,
      types: ['command.accepted'],
    });
    const last = page.at(-1);
    if (!last) break;
    for (const envelope of page) {
      const payload = envelope.payload as { commandId?: CommandId; type?: string };
      if (payload.commandId && payload.type && isExternalCommandType(payload.type)) candidates.push(payload.commandId);
    }
    afterSequence = last.sequence;
    if (page.length < EVENT_PAGE) break;
  }

  const claimed: CommandRecord[] = [];
  for (const commandId of candidates) {
    const row = await store.getCommand(commandId);
    if (row?.status === 'claimed') claimed.push(row);
  }
  return claimed;
}

/** The claimed external command that caused `stop`, if any — what lets a stop row whose `TransitionDef.actor` is
 * `human` (T20 `pause`, T27 `cancel`) fire with the actor and `commandId` of the command that really asked for it,
 * instead of being refused as "the engine firing a human row on its own". */
export async function findCommandCausingStop(
  store: StateStore,
  runId: RunId,
  stop: StopReason,
): Promise<CommandRecord | undefined> {
  const claimed = await findClaimedExternalCommands(store, runId);
  return claimed.find((row) => {
    const type = row.envelope.type;
    return isExternalCommandType(type) && STOP_OF_EXTERNAL_COMMAND[type] === stop;
  });
}
