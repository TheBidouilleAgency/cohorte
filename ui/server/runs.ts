// cohorte ui — runs a pipeline command (`/cohorte-build f1`) through `claude -p`, headless, and turns the
// stream into a short feed plus the decisions only a human can make.
//
// A run is one Cohorte command in one worktree. The human's part is the gates the CLI raises on its control
// channel — a permission ask (the project's gate answering `ask`, or Claude Code's own prompt) and
// AskUserQuestion (the interview commands) — plus, once a turn has ended, a reply in the same session.
// The company flow (flow.ts) starts runs of its own — the PO and lead conversations, the autopilot's stages —
// with a role in `meta`, a model, and for the business-facing ones a read-only tool set. Protocol, verified
// against Claude Code 2.1.326:
//
//   claude -p --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --verbose
//   stdin  ← {"type":"user","message":{"role":"user","content":[{"type":"text","text":"/cohorte-build f1"}]}}
//   stdout → system | assistant | user(tool_result) | control_request(can_use_tool) | result   (NDJSON)
//   stdin  ← {"type":"control_response","response":{"subtype":"success","request_id":…,
//              "response":{"behavior":"allow","updatedInput":…}}}      or {"behavior":"deny","message":…}
//
// Our stdin is also the CLI's EOF signal — and the permission channel: once it is closed, every later ask fails
// at the source with "Tool permission request failed: AbortError: Stream closed". So it is closed only once the
// turn's `result` is in, nothing is parked on a human, no background task the run launched is still out, and the
// stream has been quiet for a moment. A lead that dispatches subagents in the background (`Agent`, "Async agent
// launched successfully", or `Bash` with run_in_background) ends its turn at once; its subagents keep working and
// asking, and each completion wakes the lead for another turn with its own `result`. The CLI reports them as
//   {"type":"system","subtype":"task_started","task_id":…,"tool_use_id":…,"is_backgrounded":…}
//   {"type":"system","subtype":"task_notification","task_id":…,"tool_use_id":…,"status":"completed"|"failed"|"stopped"}
// A subagent's own messages carry `parent_tool_use_id` (the lead's Agent call): they are tagged `sub` and never
// parsed as the lead's words (its HANDOFF / REVIEW REPORT is not the lead's ticket or plan).

import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { spawn, type ChildProcess } from 'child_process';
import type { RunStore } from './history';
import type { DecisionAdvice, PendingItem, PendingQuestion, RunEvent, RunMeta, RunResult, RunStatus, RunView } from '../shared/api';

const MAX_EVENTS = 3000;
const QUIET_AFTER_RESULT_MS = 2000;
/** Total silence after which input is closed even with background tasks still out — a run never hangs forever. */
const STALL_MS = 30 * 60_000;
/** The lead's own text is parsed for fenced blocks (a vision's eleven tickets run past 30k): never clipped short. */
const MAX_TEXT = 200_000;
const SUB_TEXT = 8000;
/** A tool_result that means the tool's work goes on in the background, past the tool call. */
const BACKGROUNDED = /Async agent launched successfully|running in background with ID|moved to the background/;
const ASYNC_AGENT = /Async agent launched successfully/;
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
export interface Pending {
  requestId: string; kind: 'permission' | 'question'; tool: string; input: Record<string, any>; questions?: PendingQuestion[]; summary?: string; reason?: string; via?: string;
  deciding?: boolean; advice?: DecisionAdvice;
}
export interface Run {
  id: string; projectId: string; cwd: string; command: string; permissionMode: string; status: RunStatus; startedAt: string; endedAt: string | null;
  events: RunEvent[]; dropped: number; pending: Map<string, Pending>; result: RunResult | null; sessionId: string | null;
  child: ChildProcess | null; closeTimer: NodeJS.Timeout | null; stopping: boolean; exitCode?: number | null;
  /** Company-flow runs only: what the run is for, the model it runs on, the tools it may not use. */
  meta: RunMeta; model: string | null; disallowedTools: string[];
  /** Tool rules allowed without asking (`Bash(npm:*)`) — the scaffold of a new project runs its stack's package managers. */
  allowedTools: string[];
  /** Extra folders the session may read and edit without asking (`--add-dir`): the pipeline core, for the set-up. */
  addDirs: string[];
  /** Company-flow runs load only the project's own MCP servers (its .mcp.json, or none) — not every server of the user's. */
  strictMcp: boolean; mcpConfig: string | null;
  /** Appended to Claude Code's system prompt (`--append-system-prompt`), on every turn of the run. */
  systemNote: string | null;
  /** The flow's bookkeeping, persisted with the run: how far its events were processed, the draft tickets it created. */
  seen: number; tickets: Record<string, string>;
  /** Tasks (subagents, shells) this process launched and has not seen finish, by task id: the tool call that launched it,
   *  whether it outlives that call, and whether it is an agent — only agents hold the input open (they are what asks). */
  tasks: Map<string, { tool: string | null; bg: boolean; agent: boolean }>;
  /** A lead-level task finished after the last `result`: the CLI wakes the lead for another turn — keep input open for it. */
  awaitingTurn: boolean;
}
export interface RunStartOpts {
  projectId: string; cwd: string; command: string; permissionMode?: unknown;
  /** The text sent as the first turn. Defaults to `command` (a slash command); the flow sends the expanded command body instead, so its model applies. */
  prompt?: string; model?: string | null; disallowedTools?: string[]; allowedTools?: string[]; addDirs?: string[]; meta?: RunMeta; strictMcp?: boolean; mcpConfig?: string | null; systemNote?: string | null;
  /** Shown in the feed as what the person said (a conversation's first message), when the prompt itself is not. */
  echo?: string;
}
/** A permission rule: a tool name, optionally with a specifier — `Bash(npm:*)`, `Bash(docker compose:*)`. No comma (the list separator). */
export const ALLOWED_RULE = /^[A-Za-z][\w]{0,40}(\([^(),\r\n]{1,400}\))?$/;
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,80}$/;
export interface RunHooks {
  /** A turn ended (the process closed): done, failed or stopped. */
  onEnd?: (run: Run) => void;
  /** A question was parked. Return true to keep it away from the human while you work on it (deciding). */
  onQuestion?: (run: Run, p: Pending) => boolean;
  /** A parked item was answered — by the human over HTTP or by the flow. */
  onAnswered?: (run: Run, p: Pending, behavior: 'allow' | 'deny', answers: Record<string, string>, by: 'human' | 'decider') => void;
}

export class Runs {
  runs = new Map<string, Run>();
  /** Runs this process spawned a turn of: the only ones it writes back to the store (another process owns the rest). */
  #owned = new Set<string>();
  bin: string;
  onChange: (run: Run) => void = () => {};
  store: RunStore | null;
  hooks: RunHooks = {};
  quietMs: number;
  stallMs: number;
  constructor({ bin, store, quietMs, stallMs }: { bin?: string; store?: RunStore; quietMs?: number; stallMs?: number } = {}) {
    this.bin = bin || process.env.COHORTE_CLAUDE_BIN || 'claude';
    this.quietMs = quietMs ?? QUIET_AFTER_RESULT_MS;
    this.stallMs = stallMs ?? STALL_MS;
    this.store = store || null;
    for (const r of this.store?.loadAll() || []) this.runs.set(r.id, r);
    if (this.store) { const t = setInterval(() => this.#collect(), 300); t.unref(); }
  }

  // opts: { projectId, cwd, command (e.g. "/cohorte-build f1"), permissionMode }
  start(opts: RunStartOpts): Run {
    const mode = typeof opts.permissionMode === 'string' && MODES.includes(opts.permissionMode) ? opts.permissionMode : 'default';
    const model = typeof opts.model === 'string' && MODEL.test(opts.model) ? opts.model : null;
    const run: Run = {
      id: crypto.randomBytes(4).toString('hex'), projectId: opts.projectId, cwd: opts.cwd, command: opts.command,
      permissionMode: mode, status: 'running', startedAt: new Date().toISOString(), endedAt: null,
      events: [], dropped: 0, pending: new Map(), result: null, sessionId: null, child: null, closeTimer: null, stopping: false,
      meta: opts.meta || { role: 'command' }, model, disallowedTools: (opts.disallowedTools || []).filter((t) => /^[A-Za-z][\w:-]{0,60}$/.test(t)),
      allowedTools: (opts.allowedTools || []).filter((t) => ALLOWED_RULE.test(t)),
      addDirs: (opts.addDirs || []).filter((d) => typeof d === 'string' && path.isAbsolute(d)),
      seen: 0, tickets: {}, tasks: new Map(), awaitingTurn: false, strictMcp: opts.strictMcp === true, mcpConfig: typeof opts.mcpConfig === 'string' ? opts.mcpConfig : null,
      systemNote: typeof opts.systemNote === 'string' && opts.systemNote ? opts.systemNote.slice(0, 4000) : null,
    };
    this.#spawn(run, null);
    this.runs.set(run.id, run);
    if (opts.echo) this.#push(run, { kind: 'reply', text: clip(opts.echo, 8000) });
    this.#write(run, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: opts.prompt || opts.command }] } });
    return run;
  }

  // One `claude -p` process for the run's next turn. A reply resumes the same session in a new process.
  #spawn(run: Run, resumeId: string | null): void {
    const args: string[] = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--verbose'];
    if (run.permissionMode !== 'default') args.push('--permission-mode', run.permissionMode);
    if (run.model) args.push('--model', run.model);
    if (run.disallowedTools.length) args.push('--disallowedTools', run.disallowedTools.join(','));
    if (run.allowedTools.length) args.push('--allowedTools', run.allowedTools.join(','));
    for (const d of run.addDirs) args.push('--add-dir', d);
    if (run.strictMcp) args.push('--strict-mcp-config');
    if (run.systemNote) args.push('--append-system-prompt', run.systemNote);
    if (run.mcpConfig) args.push('--mcp-config', run.mcpConfig);
    if (resumeId) args.push('--resume', resumeId);
    run.tasks.clear(); run.awaitingTurn = false; // a new process: the old one's background tasks went with it
    this.#owned.add(run.id);
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

  #end(run: Run, status: RunStatus): void {
    run.status = status; run.endedAt = new Date().toISOString(); run.pending.clear(); this.onChange(run); this.store?.schedule(run, true);
    try { this.hooks.onEnd?.(run); } catch { /* the flow never takes a run down */ }
  }

  /** The flow updates a parked item (deciding → advice) without answering it. */
  annotate(run: Run, requestId: string, patch: Partial<Pick<Pending, 'deciding' | 'advice'>>): void {
    const p = run.pending.get(requestId);
    if (!p) return;
    Object.assign(p, patch);
    this.onChange(run);
    this.store?.schedule(run, true); // the other process (the page, a terminal) sees it is now a person's to answer
  }

  /** Answers another process left on disk for the runs this one drives (the page answering a terminal's run, or the reverse). */
  #collect(): void {
    if (!this.store) return;
    for (const r of this.runs.values()) {
      if (!this.#mine(r) || !r.pending.size) continue;
      for (const a of this.store.takeAnswers(r)) this.respond(r, a.requestId, a.behavior, a.answers, 'human');
    }
  }

  #line(run: Run, line: string): void {
    if (!line.trim()) return;
    let v: any;
    try { v = JSON.parse(line); } catch { this.#push(run, { kind: 'stderr', text: clip(line, 500) }); return; }
    if (run.closeTimer) clearTimeout(run.closeTimer);
    if (v.session_id && !run.sessionId) run.sessionId = v.session_id;
    // Set on a subagent's messages (the lead's Agent call id); null on the lead's own.
    const sub = typeof v.parent_tool_use_id === 'string' && v.parent_tool_use_id ? { sub: true as const } : {};

    if (v.type === 'assistant' && v.message && Array.isArray(v.message.content)) {
      for (const b of v.message.content as any[]) {
        if (b.type === 'text' && b.text && b.text.trim()) this.#push(run, { kind: 'text', text: clip(b.text, sub.sub ? SUB_TEXT : MAX_TEXT), ...sub });
        else if (b.type === 'tool_use') this.#push(run, { kind: 'tool', id: b.id, name: b.name, summary: summarize(b.name, b.input), ...sub });
      }
    } else if (v.type === 'user' && v.message && Array.isArray(v.message.content)) {
      for (const b of v.message.content) {
        if (b.type !== 'tool_result') continue;
        const text = Array.isArray(b.content) ? b.content.map((c: any) => c.text || '').join('\n') : String(b.content ?? '');
        if (BACKGROUNDED.test(text)) this.#backgrounded(run, b.tool_use_id, ASYNC_AGENT.test(text));
        else this.#settled(run, null, b.tool_use_id, true); // a task that ran in the foreground ended with its tool call
        this.#push(run, { kind: 'tool_result', id: b.tool_use_id, error: b.is_error === true, text: clip(text, 1500), ...sub });
      }
    } else if (v.type === 'system' && v.subtype === 'task_started' && typeof v.task_id === 'string') {
      const tool = typeof v.tool_use_id === 'string' ? v.tool_use_id : null;
      let bg = v.is_backgrounded === true;
      for (const [k, t] of run.tasks) if (k.startsWith('tool:') && t.tool === tool) { bg = true; run.tasks.delete(k); } // the tool_result came first
      // `local_agent`, `remote_agent`… hold the run; a shell (`local_bash`) does not. No task_type at all: assume an agent.
      const agent = typeof v.subagent_type === 'string' || typeof v.task_type !== 'string' || /agent/i.test(v.task_type);
      run.tasks.set(v.task_id, { tool, bg, agent });
    } else if (v.type === 'system' && v.subtype === 'task_notification') {
      const tool = typeof v.tool_use_id === 'string' && v.tool_use_id ? v.tool_use_id : null;
      let had = this.#settled(run, typeof v.task_id === 'string' ? v.task_id : null, tool, false);
      // A completion that names no tool call cannot be matched to a placeholder: it settles the oldest one, so N
      // launches and N completions always balance and a placeholder never pins the run until the stall timeout.
      if (!had && !tool) for (const k of run.tasks.keys()) if (k.startsWith('tool:')) { run.tasks.delete(k); had = true; break; }
      // The notification is queued to whoever launched the task: the lead's own wakes it for another turn, which
      // may take a while to show (the model thinks first). A subagent's own (owned_by_subagent) wakes the subagent.
      if (had && v.owned_by_subagent !== true && v.ambient !== true) run.awaitingTurn = true;
    } else if (v.type === 'control_request') {
      this.#control(run, v);
    } else if (v.type === 'result') {
      run.result = { ok: !v.is_error && v.subtype !== 'error_during_execution', text: clip(v.result, 4000), costUsd: v.total_cost_usd ?? null,
        durationMs: v.duration_ms ?? null, turns: v.num_turns ?? null };
      run.awaitingTurn = false;
      this.#push(run, { kind: 'result', ...run.result });
      this.store?.schedule(run, true);
    }
    this.#maybeClose(run);
  }

  /** A tool call returned while its work goes on (an async agent, a background shell): tracked until its task_notification. */
  #backgrounded(run: Run, tool: string, agent: boolean): void {
    let known = false;
    for (const t of run.tasks.values()) if (t.tool === tool) { t.bg = true; known = true; }
    // No task_started seen for it (an older CLI): a placeholder, for an agent only — a shell never holds the run.
    if (!known && agent) run.tasks.set(`tool:${tool}`, { tool, bg: true, agent: true });
  }

  /** Forgets the tasks matching a finished task id or tool call. `foreground` spares the ones that outlive their call. */
  #settled(run: Run, taskId: string | null, tool: string | null, foreground: boolean): boolean {
    let had = false;
    for (const [k, t] of run.tasks) {
      if ((taskId && k === taskId) || (tool && t.tool === tool && !(foreground && t.bg))) { run.tasks.delete(k); had = true; }
    }
    return had;
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
      const p: Pending = { ...base, kind: 'question', input, questions };
      run.pending.set(v.request_id, p);
      let held = false;
      try { held = this.hooks.onQuestion?.(run, p) === true; } catch { held = false; }
      if (held) p.deciding = true;
      this.#push(run, { kind: 'question', ...base, questions });
      this.store?.schedule(run, true);
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
    this.store?.schedule(run, true);
  }

  // behavior: 'allow' | 'deny'. For a question, `answers` maps each question text to the chosen label(s).
  respond(run: Run, requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string | string[]>, by: 'human' | 'decider' = 'human'): boolean {
    const p = run.pending.get(requestId);
    if (!p) return false;
    if (!this.#mine(run)) { // another process drives it: the answer goes to it through the store
      if (!this.store?.answer(run, requestId, behavior, answers)) return false;
      run.pending.delete(requestId);
      this.onChange(run);
      return true;
    }
    let response: Record<string, unknown>;
    let given: Record<string, string> = {};
    if (behavior === 'allow') {
      const updated: Record<string, unknown> = { ...p.input };
      if (p.kind === 'question') {
        const out: Record<string, string> = {};
        for (const q of p.questions || []) {
          const a = answers && answers[q.question];
          out[q.question] = Array.isArray(a) ? a.join(', ') : typeof a === 'string' ? a : '';
        }
        updated.answers = out;
        given = out;
      }
      response = { behavior: 'allow', updatedInput: updated };
    } else {
      response = { behavior: 'deny', message: p.kind === 'question' ? 'The user declined to answer.' : DENY_MESSAGE };
    }
    run.pending.delete(requestId);
    this.#write(run, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.#push(run, { kind: 'resolved', requestId, decision: behavior });
    try { this.hooks.onAnswered?.(run, p, behavior, given, by); } catch { /* never fails an answer */ }
    this.#maybeClose(run);
    return true;
  }

  // Every line re-arms the timer, so both delays count silence. With a background agent still out the short one
  // would cut its permission channel: the long one only guards against a CLI that never reports the end. A
  // background shell does not count — a dev server never ends while the process lives, and a shell asks nothing.
  #maybeClose(run: Run): void {
    if (run.closeTimer) { clearTimeout(run.closeTimer); run.closeTimer = null; }
    if (run.status !== 'running' || !run.result || run.pending.size) return;
    const agents = [...run.tasks.values()].filter((t) => t.agent).length;
    const busy = agents > 0 || run.awaitingTurn;
    run.closeTimer = setTimeout(() => {
      run.closeTimer = null;
      if (run.status !== 'running' || run.pending.size) return;
      if (busy) this.#push(run, { kind: 'system', text: `no output for ${this.stallMs >= 60_000 ? `${Math.round(this.stallMs / 60_000)} min` : `${this.stallMs} ms`} with ${agents} background agent(s) still out — closing the run's input` });
      try { run.child?.stdin?.end(); } catch { /* closed */ }
    }, busy ? this.stallMs : this.quietMs);
  }

  stop(run: Run): boolean {
    if (run.status !== 'running' || !run.child) return false; // no child: another process drives it
    run.stopping = true;
    try { run.child?.stdin?.end(); } catch { /* closed */ }
    const pid = run.child?.pid;
    if (!pid) return true;
    try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
    const t = setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 4000);
    t.unref();
    return true;
  }

  flush(): void { this.store?.flush([...this.runs.values()].filter((r) => this.#owned.has(r.id))); }
  stopAll(): void { for (const r of this.runs.values()) this.stop(r); }
  /**
   * A run by id. Another process (the UI, or a flow verb in a terminal) may have started it, resumed it or ended it
   * since this one loaded the store: what is not running HERE is re-read when its file changed.
   */
  get(id: string): Run | null {
    const r = this.runs.get(id);
    if (!r) {
      const s = this.store?.find(id);
      if (s) this.runs.set(s.id, s);
      return s || null;
    }
    if (!this.#mine(r)) { const s = this.store?.refresh(r); if (s) this.#adopt(r, s); }
    return r;
  }
  forProject(projectId: string): Run[] {
    for (const id of this.store?.ids(projectId) || []) this.get(id);
    return [...this.runs.values()].filter((r) => r.projectId === projectId);
  }
  /** A run this process is driving right now (its child is ours): never re-read from disk. */
  #mine(r: Run): boolean { return r.status === 'running' && !!r.child; }
  /** Another process's write of a run, taken into the object this process holds (references stay valid). */
  #adopt(r: Run, s: Run): void {
    const { child: _c, closeTimer: _t, pending: _p, tasks: _k, ...persisted } = s;
    Object.assign(r, persisted, { child: null, stopping: false });
    this.#owned.delete(r.id);
    r.pending.clear(); r.tasks.clear();
    for (const [k, v] of s.pending) r.pending.set(k, v);
  }
  find(projectId: string, cwd: string): Run | null { return [...this.runs.values()].find((r) => r.projectId === projectId && r.cwd === cwd && r.status === 'running') || null; }

  view(run: Run, since?: number): RunView {
    const out: RunView = { id: run.id, command: run.command, cwd: run.cwd, permissionMode: run.permissionMode, status: run.status, startedAt: run.startedAt,
      endedAt: run.endedAt, result: run.result, sessionId: run.sessionId, meta: run.meta, model: run.model,
      pending: [...run.pending.values()].map((p): PendingItem => ({ requestId: p.requestId, kind: p.kind, tool: p.tool, summary: p.summary, reason: p.reason, via: p.via, questions: p.questions,
        deciding: p.deciding || undefined, advice: p.advice })) };
    if (since !== undefined) {
      out.events = run.events.slice(Math.max(0, since - run.dropped));
      out.cursor = run.dropped + run.events.length;
    }
    return out;
  }
}

