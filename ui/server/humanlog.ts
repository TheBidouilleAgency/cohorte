// The person's decisions, as the paths that take them write them: an append-only log per project,
// <dataDir>/human/<projectId>.jsonl — one line per CP0/CP3/CP4/merge/abandon/answer typed at a terminal or clicked
// in cohorte ui, written by the process that took it, at the moment it took it.
//
// It is what the flow checks a feature record against when another process changed it (features.ts re-reads it):
// a record that moved past a person's checkpoint, or gained a decision "by the developer", with no line here for
// it, was edited outside cohorte — the flow then refuses to act on it (Flow.integrity). A file is forgeable by any
// program of the user that may write it (the gate denies agents the obvious ways, not interpreters): this raises
// the bar from "edit one JSON field" to "forge two files consistently", it is not a signature — see
// docs/design/cli-ui-parity.md, "The security boundary".

import fs from 'fs';
import path from 'path';
import { self } from './proc';

export type HumanKind = 'cp0-validate' | 'cp0-reject' | 'cp1-approve' | 'cp2-continue' | 'cp2-correct' | 'cp2-reframe' | 'cp3-approve' | 'cp3-correct'
  | 'merge' | 'cp4-accept' | 'cp4-not-quite' | 'abandon' | 'answer' | 'take-over' | 'ticket-move' | 'ticket-backlog';
export interface HumanEntry { at: string; feature: string; kind: HumanKind; by: 'ui' | 'cli'; pid: number; ref?: string }
const SAFE = /^[A-Za-z0-9._-]+$/;

export class HumanLog {
  constructor(private dir: string) {}
  private file(projectId: string): string | null { return SAFE.test(projectId) ? path.join(this.dir, `${projectId}.jsonl`) : null; }

  record(projectId: string, e: Omit<HumanEntry, 'at' | 'pid'>): void {
    const f = this.file(projectId);
    if (!f) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), pid: self.pid, ...e })}\n`);
    } catch { /* the record stays on the feature; the next process to read it will flag it */ }
  }

  entries(projectId: string, feature: string): HumanEntry[] {
    const f = this.file(projectId);
    if (!f) return [];
    try {
      return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as HumanEntry; } catch { return null; } })
        .filter((x): x is HumanEntry => !!x && x.feature === feature);
    } catch { return []; }
  }

  /** A `kind` decision on `feature` at or after `since` (ISO), or one naming `ref` (a decision id). */
  has(projectId: string, feature: string, kind: HumanKind | HumanKind[], { since, ref }: { since?: string | null; ref?: string } = {}): boolean {
    const kinds = Array.isArray(kind) ? kind : [kind];
    const floor = since ? new Date(since).getTime() - 2000 : 0;
    return this.entries(projectId, feature).some((e) => kinds.includes(e.kind) && (ref ? e.ref === ref : new Date(e.at).getTime() >= floor));
  }
}
