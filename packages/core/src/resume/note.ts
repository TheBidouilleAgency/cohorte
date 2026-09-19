// DESIGN 4.4 step 10 / ADR-0025 item 6 — the reconciliation-note CONTENT: five situations, built AFTER steps 7-8 so
// it describes the POST-recovery tree, never an instruction to re-issue (a fact, stated once, for the approved case:
// "was approved and has been executed", never "please re-issue it").
//
// DEVIATION (docs/v3/requests/U1.10.md, item D5): `Continuation.note` (`@cohorte/runtime-contract`) is a `TaskInput`
// — a CAS file reference (`{path, sha256, bytes}`), not inline text. Materialising the text this module builds into
// that reference needs `RunFiles`/`BlobStore`, neither of which is in `ResumeDeps` (they belong to the run-files
// area, a different unit). This module's public surface is therefore the note's PLAIN TEXT (and the structured
// items it was built from, for `ResumeReport`); whoever spawns the continuation (`AgentSupervisor`, a later wave)
// writes it to the CAS and wraps it as a `TaskInput`.
import type { AgentId, ApprovalId, EffectId, ToolCallId } from '@cohorte/base';
import type { EffectKind, ReplayClass } from '@cohorte/persistence/contract';
import type { ArtifactRef } from '@cohorte/protocol';

export type NoteItem =
  | { situation: 'not-executed'; toolCallId: ToolCallId; tool: string }
  | { situation: 'completed'; toolCallId: ToolCallId; tool: string; resultSummary: string }
  | {
      situation: 'compensated';
      effectId: EffectId;
      checkpointSha: string;
      patch: ArtifactRef;
    }
  | { situation: 'in-doubt'; effectId: EffectId; kind: EffectKind; replayClass: ReplayClass }
  | {
      situation: 'approved';
      approvalId: ApprovalId;
      toolCallId: ToolCallId;
      tool: string;
      outcome: 'executed' | 'binding-changed' | 'denied-by-gate';
      resultSummary?: string;
    };

export interface ReconciliationNoteInput {
  agentId: AgentId;
  fromIncarnation: number;
  items: readonly NoteItem[];
}

function lineFor(item: NoteItem): string {
  switch (item.situation) {
    case 'not-executed':
      return `- your call "${item.tool}" (${item.toolCallId}) was requested but never ran: the host restarted before a decision was made. It was not executed.`;
    case 'completed':
      return `- your call "${item.tool}" (${item.toolCallId}) completed before the restart; its result is kept: ${item.resultSummary}`;
    case 'compensated':
      return `- uncommitted work in progress since checkpoint ${item.checkpointSha} was discarded (the workspace state after the restart could not be explained); it was saved as artifact ${item.patch.artifactId} before discarding, in case you need to inspect it.`;
    case 'in-doubt':
      return `- an effect of kind "${item.kind}" (${item.effectId}, replay class ${item.replayClass}) was started but its outcome is unknown after the restart. Do not assume it ran; do not assume it did not run. It will not be re-issued automatically.`;
    case 'approved': {
      if (item.outcome === 'executed') {
        return `- your call "${item.tool}" (${item.toolCallId}), approved while you were gone, was approved and has been executed; result: ${item.resultSummary ?? '(no result recorded)'}.`;
      }
      if (item.outcome === 'binding-changed') {
        return `- your call "${item.tool}" (${item.toolCallId}) was approved but NOT executed: the workspace changed since you asked. Request it again if you still need it.`;
      }
      return `- your call "${item.tool}" (${item.toolCallId}) was denied: the approval no longer applies.`;
    }
    default: {
      const _exhaustive: never = item;
      throw new TypeError(`buildReconciliationNote: unhandled situation ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Builds the note's plain text (D5). Never phrased as an instruction to re-issue anything: every line states a
 * fact about what the post-recovery tree already contains. */
export function buildReconciliationNoteText(input: ReconciliationNoteInput): string {
  const header = `[cohorte] recovery note (incarnation ${input.fromIncarnation + 1}, continuing the same attempt)\n\nThe host restarted while you were running. Here is what changed:`;
  if (input.items.length === 0) return `${header}\n- nothing of yours was in flight; continue where you left off.`;
  return [header, ...input.items.map(lineFor)].join('\n');
}
