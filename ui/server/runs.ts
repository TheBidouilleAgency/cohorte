// cohorte ui — runs a pipeline command (`/cohorte-build f1`) through `claude -p`, headless, and turns the
// stream into a short feed plus the decisions only a human can make.
//
// This is NOT a chat: there is no free-form message box. A run is one command in one worktree, and the
// human's part is limited to the gates the CLI raises on its control channel — a permission ask (the
// project's gate answering `ask`, or Claude Code's own prompt) and AskUserQuestion (the interview
// commands). Protocol, verified against Claude Code 2.1.326:
//
//   claude -p --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --verbose
//   stdin  ← {"type":"user","message":{"role":"user","content":[{"type":"text","text":"/cohorte-build f1"}]}}
//   stdout → system | assistant | user(tool_result) | control_request(can_use_tool) | result   (NDJSON)
//   stdin  ← {"type":"control_response","response":{"subtype":"success","request_id":…,
//              "response":{"behavior":"allow","updatedInput":…}}}      or {"behavior":"deny","message":…}
//
// Our stdin is also the CLI's EOF signal. It is closed only once the turn's `result` is in, nothing is
// parked on a human, and the stream has been quiet for a moment (a background subagent's asks would
// otherwise be thrown away at the source with "Stream closed").

import crypto from 'crypto';
import readline from 'readline';
import { spawn, type ChildProcess } from 'child_process';
import type { RunStore } from './history';
import type { PendingItem, PendingQuestion, RunEvent, RunResult, RunStatus, RunView } from '../shared/api';

const MAX_EVENTS = 3000;
const QUIET_AFTER_RESULT_MS = 2000;
export const MODES = ['default', 'acceptEdits', 'plan']; // never bypassPermissions: the gate's asks would turn into denials
const DENY_MESSAGE = 'cohorte ui: the user denied this tool call.';

const clip = (v: unknown, n: number): string => { const s = String(v == null ? '' : v); return s.length > n ? `${s.slice(0, n)}…` : s; };

function summarize(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  if (name === 'Bash') return clip(i.command, 400);
  if (name === 'Task' || name === 'Agent') return clip(`${i.subagent_type || 'agent'} — ${i.description || ''}`, 200);
  if (i.file_path) return clip(i.file_path, 300);
  if (i.path) return clip(i.path, 300);
  if (i.pattern) return clip(i.pattern, 200);
  try { return clip(JSON.stringify(i), 300); } catch { return ''; }
}

type EventInput = RunEvent extends infer E ? (E extends { t: number } ? Omit<E, 't'> : never) : never;
interface Pending { requestId: string; kind: 'permission' | 'question'; tool: string; input: Record<string, any>; questions?: PendingQuestion[]; summary?: string; reason?: string; via?: string }
export interface Run {
  id: string; projectId: string; cwd: string; command: string; permissionMode: string; status: RunStatus; startedAt: string; endedAt: string | null;
  events: RunEvent[]; dropped: number; pending: Map<string, Pending>; result: RunResult | null; sessionId: string | null;
  child: ChildProcess | null; closeTimer: NodeJS.Timeout | null; stopping: boolean; exitCode?: number | null;
}
export interface RunStartOpts { projectId: string; cwd: string; command: string; permissionMode?: unknown }

export class Runs {
  runs = new Map<string, Run>();
  bin: string;
  onChange: (run: Run) => void = () => {};
  store: RunStore | null;
  constructor({ bin, store }: { bin?: string; store?: RunStore } = {}) {
    this.bin = bin || process.env.COHORTE_CLAUDE_BIN || 'claude';
    this.store = store || null;
    for (const r of this.store?.loadAll() || []) this.runs.set(r.id, r);
  }

  // opts: { projectId, cwd, command (e.g. "/cohorte-build f1"), permissionMode }
  start(opts: RunStartOpts): Run {
    const mode = typeof opts.permissionMode === 'string' && MODES.includes(opts.permissionMode) ? opts.permissionMode : 'default';
    const run: Run = {
      id: crypto.randomBytes(4).toString('hex'), projectId: opts.projectId, cwd: opts.cwd, command: opts.command,
      permissionMode: mode, status: 'running', startedAt: new Date().toISOString(), endedAt: null,
      events: [], dropped: 0, pending: new Map(), result: null, sessionId: null, child: null, closeTimer: null, stopping: false,
    };
    this.#spawn(run, null);
    this.runs.set(run.id, run);
    this.#write(run, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: opts.command }] } });
    return run;
  }

  // One `claude -p` process for the run's next turn. A reply resumes the same session in a new process.
  #spawn(run: Run, resumeId: string | null): void {
    const args: string[] = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--verbose'];
    if (run.permissionMode !== 'default') args.push('--permission-mode', run.permissionMode);
    if (resumeId) args.push('--resume', resumeId);
    const child = spawn(this.bin, args, { cwd: run.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    run.child = child;
    child.stdin?.on('error', () => { /* the child went away first */ });
    child.on('error', (e: Error) => { this.#push(run, { kind: 'system', text: `could not start ${this.bin}: ${e.message}` }); if (run.child === child) this.#end(run, 'failed'); });
    readline.createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line: string) => { if (run.child === child) this.#line(run, line); });
    child.stderr?.on('data', (d: Buffer) => this.#push(run, { kind: 'stderr', text: clip(String(d).trim(), 1000) }));
    child.on('close', (code: number | null) => {
      if (run.child !== child) return;
      if (run.closeTimer) clearTimeout(run.closeTimer);
      if (run.status === 'running') this.#end(run, run.stopping ? 'stopped' : run.result && !run.result.ok ? 'failed' : code === 0 ? 'done' : 'failed');
      run.exitCode = code;
    });
  }

  // Answers the command's free-text question (or steers it) in the SAME session. Only a Cohorte run
  // that has ended its turn: there is no free-standing conversation here.
  reply(run: Run, text: unknown): string | null {
    if (!/^\/cohorte-/.test(run.command)) return 'not a cohorte run';
    if (run.status === 'running') return 'the command is still running — answer its gates first, or wait for it to finish';
    if (!run.sessionId) return 'this run has no session to continue';
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return 'a reply of 1 to 4000 characters is required';
    run.status = 'running'; run.endedAt = null; run.result = null; run.stopping = false;
    this.#push(run, { kind: 'reply', text: text.trim() });
    this.#spawn(run, run.sessionId);
    this.#write(run, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: text.trim() }] } });
    return null;
  }

  #write(run: Run, obj: unknown): void { try { if (run.child?.stdin?.writable) run.child!.stdin!.write(`${JSON.stringify(obj)}\n`); } catch { /* closed */ } }

  #push(run: Run, ev: EventInput): void {
    run.events.push({ t: Date.now(), ...ev } as RunEvent);
    this.onChange(run);
    this.store?.schedule(run);
    if (run.events.length > MAX_EVENTS) { const cut = run.events.length - MAX_EVENTS; run.events.splice(0, cut); run.dropped += cut; }
  }

  #end(run: Run, status: RunStatus): void { run.status = status; run.endedAt = new Date().toISOString(); run.pending.clear(); this.onChange(run); this.store?.schedule(run, true); }

  #line(run: Run, line: string): void {
    if (!line.trim()) return;
    let v: any;
    try { v = JSON.parse(line); } catch { this.#push(run, { kind: 'stderr', text: clip(line, 500) }); return; }
    if (run.closeTimer) clearTimeout(run.closeTimer);
    if (v.session_id && !run.sessionId) run.sessionId = v.session_id;

    if (v.type === 'assistant' && v.message && Array.isArray(v.message.content)) {
      for (const b of v.message.content as any[]) {
        if (b.type === 'text' && b.text && b.text.trim()) this.#push(run, { kind: 'text', text: clip(b.text, 8000) });
        else if (b.type === 'tool_use') this.#push(run, { kind: 'tool', id: b.id, name: b.name, summary: summarize(b.name, b.input) });
      }
    } else if (v.type === 'user' && v.message && Array.isArray(v.message.content)) {
      for (const b of v.message.content) {
        if (b.type !== 'tool_result') continue;
        const text = Array.isArray(b.content) ? b.content.map((c: any) => c.text || '').join('\n') : b.content;
        this.#push(run, { kind: 'tool_result', id: b.tool_use_id, error: b.is_error === true, text: clip(text, 1500) });
      }
    } else if (v.type === 'control_request') {
      this.#control(run, v);
    } else if (v.type === 'result') {
      run.result = { ok: !v.is_error && v.subtype !== 'error_during_execution', text: clip(v.result, 4000), costUsd: v.total_cost_usd ?? null,
        durationMs: v.duration_ms ?? null, turns: v.num_turns ?? null };
      this.#push(run, { kind: 'result', ...run.result });
      this.store?.schedule(run, true);
    }
    this.#maybeClose(run);
  }

  #control(run: Run, v: any): void {
    const req = v.request || {};
    if (req.subtype !== 'can_use_tool') {
      this.#write(run, { type: 'control_response', response: { subtype: 'error', request_id: v.request_id, error: 'unsupported control request' } });
      return;
    }
    const input = req.input && typeof req.input === 'object' ? req.input : {};
    const base = { requestId: v.request_id as string, tool: req.tool_name as string };
    if (req.tool_name === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions.length) {
      const questions: PendingQuestion[] = input.questions.map((q: any) => ({ question: String(q.question || ''), header: String(q.header || ''), multiSelect: q.multiSelect === true,
        options: (Array.isArray(q.options) ? q.options : []).map((o: any) => ({ label: String(o.label || ''), description: String(o.description || '') })) }));
      run.pending.set(v.request_id, { ...base, kind: 'question', input, questions });
      this.#push(run, { kind: 'question', ...base, questions });
      return;
    }
    if (req.tool_name === 'AskUserQuestion') {
      this.#write(run, { type: 'control_response', response: { subtype: 'success', request_id: v.request_id, response: { behavior: 'deny', message: 'malformed AskUserQuestion input' } } });
      return;
    }
    const reason = typeof req.decision_reason === 'string' ? req.decision_reason.trim() : '';
    const via = typeof req.decision_reason_type === 'string' ? req.decision_reason_type : '';
    const ask: Pending = { ...base, kind: 'permission', input, summary: summarize(req.tool_name, input), reason, via };
    run.pending.set(v.request_id, ask);
    this.#push(run, { kind: 'approval', requestId: v.request_id, tool: req.tool_name, summary: ask.summary || '', reason, via });
  }

  // behavior: 'allow' | 'deny'. For a question, `answers` maps each question text to the chosen label(s).
  respond(run: Run, requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string | string[]>): boolean {
    const p = run.pending.get(requestId);
    if (!p) return false;
    let response: Record<string, unknown>;
    if (behavior === 'allow') {
      const updated: Record<string, unknown> = { ...p.input };
      if (p.kind === 'question') {
        const out: Record<string, string> = {};
        for (const q of p.questions || []) {
          const a = answers && answers[q.question];
          out[q.question] = Array.isArray(a) ? a.join(', ') : typeof a === 'string' ? a : '';
        }
        updated.answers = out;
      }
      response = { behavior: 'allow', updatedInput: updated };
    } else {
      response = { behavior: 'deny', message: p.kind === 'question' ? 'The user declined to answer.' : DENY_MESSAGE };
    }
    run.pending.delete(requestId);
    this.#write(run, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.#push(run, { kind: 'resolved', requestId, decision: behavior });
    return true;
  }

  #maybeClose(run: Run): void {
    if (run.status !== 'running' || !run.result || run.pending.size) return;
    run.closeTimer = setTimeout(() => {
      if (run.status === 'running' && !run.pending.size) { try { run.child?.stdin?.end(); } catch { /* closed */ } }
    }, QUIET_AFTER_RESULT_MS);
  }

  stop(run: Run): boolean {
    if (run.status !== 'running') return false;
    run.stopping = true;
    try { run.child?.stdin?.end(); } catch { /* closed */ }
    const pid = run.child?.pid;
    if (!pid) return true;
    try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
    const t = setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 4000);
    t.unref();
    return true;
  }

  flush(): void { this.store?.flush(this.runs.values()); }
  stopAll(): void { for (const r of this.runs.values()) this.stop(r); }
  get(id: string): Run | null { return this.runs.get(id) || null; }
  forProject(projectId: string): Run[] { return [...this.runs.values()].filter((r) => r.projectId === projectId); }
  find(projectId: string, cwd: string): Run | null { return [...this.runs.values()].find((r) => r.projectId === projectId && r.cwd === cwd && r.status === 'running') || null; }

  view(run: Run, since?: number): RunView {
    const out: RunView = { id: run.id, command: run.command, cwd: run.cwd, permissionMode: run.permissionMode, status: run.status, startedAt: run.startedAt,
      endedAt: run.endedAt, result: run.result, sessionId: run.sessionId,
      pending: [...run.pending.values()].map((p): PendingItem => ({ requestId: p.requestId, kind: p.kind, tool: p.tool, summary: p.summary, reason: p.reason, via: p.via, questions: p.questions })) };
    if (since !== undefined) {
      out.events = run.events.slice(Math.max(0, since - run.dropped));
      out.cursor = run.dropped + run.events.length;
    }
    return out;
  }
}

