// Run history on disk: <globalDir>/cohorte-ui/runs/<projectId>/<runId>.json — so a finished (or interrupted) command
// survives a restart of `cohorte ui` and can still be replied to (its sessionId is kept). Bounded per project and
// pruned oldest first; events are trimmed. Writes are atomic (tmp + rename) and debounced.
//
// `cohorte ui` and the flow verbs of the CLI (`cohorte checkpoint`, `cohorte autopilot`) share these files: each run
// records the pid of the process that drives it, a run still `running` in a live process stays `running` for the
// others, and a file another process rewrote since this one last saw it is read again (refresh).
//
// What a run parked on a person (a question, a permission ask) is written with it, so the other process sees it
// (the page's inbox, `cohorte autopilot --follow`); its answer cannot reach the run's stdin from there, so it is
// dropped as a file under <runs>/<projectId>/answers/ that the driving process picks up (takeAnswers).

import fs from 'fs';
import path from 'path';
import type { Pending, Run } from './runs';

const KEEP_PER_PROJECT = 120; // the company flow keeps its conversations here too
const KEEP_EVENTS = 400;
const SAFE = /^[A-Za-z0-9._-]+$/;

/** Whether a process is alive on this machine (EPERM: alive, someone else's). */
export const alive = (pid: unknown): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
const stamp = (file: string): string | null => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return null; } };

export class RunStore {
  private timers = new Map<string, NodeJS.Timeout>();
  /** mtime:size of each file when this process last wrote or read it. */
  private stamps = new Map<string, string | null>();
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
        pid: process.pid, meta: run.meta, model: run.model, disallowedTools: run.disallowedTools, allowedTools: run.allowedTools, addDirs: run.addDirs, seen: run.seen, tickets: run.tickets, strictMcp: run.strictMcp, mcpConfig: run.mcpConfig, systemNote: run.systemNote,
        pending: [...run.pending.values()].map(({ input: _i, ...x }) => x) };
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, f);
      this.stamps.set(f, stamp(f));
      this.prune(path.dirname(f));
    } catch { /* history is a convenience: never take a run down with it */ }
  }

  private prune(projectDir: string): void {
    try {
      const rows = fs.readdirSync(projectDir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: fs.statSync(path.join(projectDir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const old of rows.slice(KEEP_PER_PROJECT)) fs.rmSync(path.join(projectDir, old.n), { force: true });
    } catch { /* ignore */ }
  }

  /** Every stored run. A run that was still `running` when its process died is `stopped`; one a live process drives stays `running`. */
  loadAll(): Run[] {
    const out: Run[] = [];
    let projects: string[] = [];
    try { projects = fs.readdirSync(this.dir); } catch { return out; }
    for (const p of projects) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(this.dir, p)).filter((n) => n.endsWith('.json')); } catch { continue; }
      for (const n of names) { const r = this.read(path.join(this.dir, p, n), p); if (r) out.push(r); }
    }
    return out;
  }

  private answersDir(projectId: string): string { return path.join(this.dir, projectId, 'answers'); }

  /** Another process answers a run it does not drive: the answer waits on disk for the driving process. */
  answer(run: Pick<Run, 'projectId' | 'id'>, requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string | string[]>): boolean {
    if (!SAFE.test(run.projectId) || !SAFE.test(run.id) || !SAFE.test(requestId)) return false;
    try {
      const dir = this.answersDir(run.projectId);
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `${run.id}.${requestId}.json`);
      fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify({ requestId, behavior, answers: answers || {}, at: new Date().toISOString() }));
      fs.renameSync(`${f}.${process.pid}.tmp`, f);
      return true;
    } catch { return false; }
  }

  /** The answers other processes left for `run` (consumed). */
  takeAnswers(run: Pick<Run, 'projectId' | 'id'>): { requestId: string; behavior: 'allow' | 'deny'; answers: Record<string, string | string[]> }[] {
    const out: { requestId: string; behavior: 'allow' | 'deny'; answers: Record<string, string | string[]> }[] = [];
    if (!SAFE.test(run.projectId)) return out;
    const dir = this.answersDir(run.projectId);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.startsWith(`${run.id}.`) && n.endsWith('.json')); } catch { return out; }
    for (const n of names) {
      const f = path.join(dir, n);
      try {
        const v = JSON.parse(fs.readFileSync(f, 'utf8'));
        fs.rmSync(f, { force: true });
        if (typeof v.requestId === 'string' && (v.behavior === 'allow' || v.behavior === 'deny')) out.push({ requestId: v.requestId, behavior: v.behavior, answers: v.answers && typeof v.answers === 'object' ? v.answers : {} });
      } catch { /* half-written: next time */ }
    }
    return out;
  }

  /** The run ids stored for a project. */
  ids(projectId: string): string[] {
    if (!SAFE.test(projectId)) return [];
    try { return fs.readdirSync(path.join(this.dir, projectId)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { return []; }
  }

  /** One run by id, from disk — a run another process started after this one loaded the store. */
  find(id: string): Run | null {
    if (!SAFE.test(id)) return null;
    let projects: string[] = [];
    try { projects = fs.readdirSync(this.dir); } catch { return null; }
    for (const p of projects) { const f = path.join(this.dir, p, `${id}.json`); if (fs.existsSync(f)) return this.read(f, p); }
    return null;
  }

  /** The stored state of `run` when another process rewrote its file since this one last saw it; null otherwise. */
  refresh(run: Pick<Run, 'projectId' | 'id'>): Run | null {
    const f = this.fileOf(run);
    if (!f) return null;
    const st = stamp(f);
    if (st === null || st === this.stamps.get(f)) return null;
    return this.read(f, run.projectId);
  }

  private read(file: string, p: string): Run | null {
    try {
      const st = stamp(file);
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (v.v !== 1 || !SAFE.test(v.id) || v.projectId !== p) return null;
      this.stamps.set(file, st);
      const interrupted = v.status === 'running' && (v.pid === process.pid || !alive(v.pid));
      // what a live process parked on a person: visible (and answerable through answer()) from here
      const pending = new Map<string, Pending>();
      if (!interrupted && v.status === 'running' && Array.isArray(v.pending)) {
        for (const x of v.pending) if (x && typeof x.requestId === 'string' && (x.kind === 'question' || x.kind === 'permission')) pending.set(x.requestId, { ...x, input: {} });
      }
      return { id: v.id, projectId: v.projectId, cwd: v.cwd, command: v.command, permissionMode: v.permissionMode, status: interrupted ? 'stopped' : v.status,
        startedAt: v.startedAt, endedAt: v.endedAt || (interrupted ? new Date().toISOString() : null), events: Array.isArray(v.events) ? v.events : [], dropped: v.dropped || 0,
        pending, result: v.result || null, sessionId: v.sessionId || null, child: null, closeTimer: null, stopping: false,
        meta: v.meta && typeof v.meta === 'object' && typeof v.meta.role === 'string' ? v.meta : { role: 'command' }, model: typeof v.model === 'string' ? v.model : null,
        disallowedTools: Array.isArray(v.disallowedTools) ? v.disallowedTools.filter((t: unknown) => typeof t === 'string') : [],
        allowedTools: Array.isArray(v.allowedTools) ? v.allowedTools.filter((t: unknown) => typeof t === 'string') : [],
        addDirs: Array.isArray(v.addDirs) ? v.addDirs.filter((t: unknown) => typeof t === 'string') : [],
        seen: typeof v.seen === 'number' ? v.seen : 0, tickets: v.tickets && typeof v.tickets === 'object' ? v.tickets : {}, tasks: new Map(), awaitingTurn: false,
        strictMcp: v.strictMcp === true, mcpConfig: typeof v.mcpConfig === 'string' ? v.mcpConfig : null,
        systemNote: typeof v.systemNote === 'string' ? v.systemNote : null };
    } catch { return null; /* a corrupt file is skipped */ }
  }
}
