// Run history on disk: <globalDir>/cohorte-ui/runs/<projectId>/<runId>.json — so a finished (or interrupted) command
// survives a restart of `cohorte ui` and can still be replied to (its sessionId is kept). Bounded per project and
// pruned oldest first; events are trimmed. Writes are atomic (tmp + rename) and debounced.

import fs from 'fs';
import path from 'path';
import type { Run } from './runs';

const KEEP_PER_PROJECT = 120; // the company flow keeps its conversations here too
const KEEP_EVENTS = 400;
const SAFE = /^[A-Za-z0-9._-]+$/;

export class RunStore {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private dir: string) {}

  private fileOf(run: Pick<Run, 'projectId' | 'id'>): string | null {
    return SAFE.test(run.projectId) && SAFE.test(run.id) ? path.join(this.dir, run.projectId, `${run.id}.json`) : null;
  }

  /** Coalesces bursts of events into one write per run. `now` writes immediately (end of a turn, shutdown). */
  schedule(run: Run, now = false): void {
    const f = this.fileOf(run);
    if (!f) return;
    clearTimeout(this.timers.get(f));
    if (now) { this.timers.delete(f); this.write(run, f); return; }
    const t = setTimeout(() => { this.timers.delete(f); this.write(run, f); }, 400);
    t.unref();
    this.timers.set(f, t);
  }

  flush(runs: Iterable<Run>): void { for (const r of runs) this.schedule(r, true); }

  private write(run: Run, f: string): void {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const cut = Math.max(0, run.events.length - KEEP_EVENTS);
      const body = { v: 1, id: run.id, projectId: run.projectId, cwd: run.cwd, command: run.command, permissionMode: run.permissionMode, status: run.status,
        startedAt: run.startedAt, endedAt: run.endedAt, result: run.result, sessionId: run.sessionId, dropped: run.dropped + cut, events: run.events.slice(cut),
        meta: run.meta, model: run.model, disallowedTools: run.disallowedTools, seen: run.seen, tickets: run.tickets, strictMcp: run.strictMcp, mcpConfig: run.mcpConfig };
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, f);
      this.prune(path.dirname(f));
    } catch { /* history is a convenience: never take a run down with it */ }
  }

  private prune(projectDir: string): void {
    try {
      const rows = fs.readdirSync(projectDir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: fs.statSync(path.join(projectDir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const old of rows.slice(KEEP_PER_PROJECT)) fs.rmSync(path.join(projectDir, old.n), { force: true });
    } catch { /* ignore */ }
  }

  /** Every stored run as a finished Run. A run that was still `running` when the process died is `stopped`. */
  loadAll(): Run[] {
    const out: Run[] = [];
    let projects: string[] = [];
    try { projects = fs.readdirSync(this.dir); } catch { return out; }
    for (const p of projects) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(this.dir, p)).filter((n) => n.endsWith('.json')); } catch { continue; }
      for (const n of names) {
        try {
          const v = JSON.parse(fs.readFileSync(path.join(this.dir, p, n), 'utf8'));
          if (v.v !== 1 || !SAFE.test(v.id) || v.projectId !== p) continue;
          const interrupted = v.status === 'running';
          out.push({ id: v.id, projectId: v.projectId, cwd: v.cwd, command: v.command, permissionMode: v.permissionMode, status: interrupted ? 'stopped' : v.status,
            startedAt: v.startedAt, endedAt: v.endedAt || (interrupted ? new Date().toISOString() : null), events: Array.isArray(v.events) ? v.events : [], dropped: v.dropped || 0,
            pending: new Map(), result: v.result || null, sessionId: v.sessionId || null, child: null, closeTimer: null, stopping: false,
            meta: v.meta && typeof v.meta === 'object' && typeof v.meta.role === 'string' ? v.meta : { role: 'command' }, model: typeof v.model === 'string' ? v.model : null,
            disallowedTools: Array.isArray(v.disallowedTools) ? v.disallowedTools.filter((t: unknown) => typeof t === 'string') : [],
            seen: typeof v.seen === 'number' ? v.seen : 0, tickets: v.tickets && typeof v.tickets === 'object' ? v.tickets : {},
            strictMcp: v.strictMcp === true, mcpConfig: typeof v.mcpConfig === 'string' ? v.mcpConfig : null });
        } catch { /* a corrupt file is skipped */ }
      }
    }
    return out;
  }
}
