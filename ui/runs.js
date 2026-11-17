'use strict';
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

const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');

const MAX_EVENTS = 3000;
const QUIET_AFTER_RESULT_MS = 2000;
const MODES = ['default', 'acceptEdits', 'plan']; // never bypassPermissions: the gate's asks would turn into denials
const DENY_MESSAGE = 'cohorte ui: the user denied this tool call.';

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? `${s.slice(0, n)}…` : s; };

function summarize(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Bash') return clip(i.command, 400);
  if (name === 'Task' || name === 'Agent') return clip(`${i.subagent_type || 'agent'} — ${i.description || ''}`, 200);
  if (i.file_path) return clip(i.file_path, 300);
  if (i.path) return clip(i.path, 300);
  if (i.pattern) return clip(i.pattern, 200);
  try { return clip(JSON.stringify(i), 300); } catch { return ''; }
}

class Runs {
  constructor({ bin } = {}) { this.runs = new Map(); this.bin = bin || process.env.COHORTE_CLAUDE_BIN || 'claude'; }

  // opts: { projectId, cwd, command (e.g. "/cohorte-build f1"), permissionMode }
  start(opts) {
    const mode = MODES.includes(opts.permissionMode) ? opts.permissionMode : 'default';
    const run = {
      id: crypto.randomBytes(4).toString('hex'), projectId: opts.projectId, cwd: opts.cwd, command: opts.command,
      permissionMode: mode, status: 'running', startedAt: new Date().toISOString(), endedAt: null,
      events: [], dropped: 0, pending: new Map(), result: null, sessionId: null, child: null, closeTimer: null, stopping: false,
    };
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--verbose'];
    if (mode !== 'default') args.push('--permission-mode', mode);
    const child = spawn(this.bin, args, { cwd: opts.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    run.child = child;
    child.stdin.on('error', () => { /* the child went away first */ });
    child.on('error', (e) => { this.#push(run, { kind: 'system', text: `could not start ${this.bin}: ${e.message}` }); this.#end(run, 'failed'); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#line(run, line));
    child.stderr.on('data', (d) => this.#push(run, { kind: 'stderr', text: clip(String(d).trim(), 1000) }));
    child.on('close', (code) => {
      clearTimeout(run.closeTimer);
      if (run.status === 'running') this.#end(run, run.stopping ? 'stopped' : run.result && !run.result.ok ? 'failed' : code === 0 ? 'done' : 'failed');
      run.exitCode = code;
    });
    this.runs.set(run.id, run);
    this.#write(run, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: opts.command }] } });
    return run;
  }

  #write(run, obj) { try { if (run.child.stdin.writable) run.child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* closed */ } }

  #push(run, ev) {
    run.events.push({ t: Date.now(), ...ev });
    if (run.events.length > MAX_EVENTS) { const cut = run.events.length - MAX_EVENTS; run.events.splice(0, cut); run.dropped += cut; }
  }

  #end(run, status) { run.status = status; run.endedAt = new Date().toISOString(); run.pending.clear(); }

  #line(run, line) {
    if (!line.trim()) return;
    let v;
    try { v = JSON.parse(line); } catch { this.#push(run, { kind: 'stderr', text: clip(line, 500) }); return; }
    clearTimeout(run.closeTimer);
    if (v.session_id && !run.sessionId) run.sessionId = v.session_id;

    if (v.type === 'assistant' && v.message && Array.isArray(v.message.content)) {
      for (const b of v.message.content) {
        if (b.type === 'text' && b.text && b.text.trim()) this.#push(run, { kind: 'text', text: clip(b.text, 8000) });
        else if (b.type === 'tool_use') this.#push(run, { kind: 'tool', id: b.id, name: b.name, summary: summarize(b.name, b.input) });
      }
    } else if (v.type === 'user' && v.message && Array.isArray(v.message.content)) {
      for (const b of v.message.content) {
        if (b.type !== 'tool_result') continue;
        const text = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : b.content;
        this.#push(run, { kind: 'tool_result', id: b.tool_use_id, error: b.is_error === true, text: clip(text, 1500) });
      }
    } else if (v.type === 'control_request') {
      this.#control(run, v);
    } else if (v.type === 'result') {
      run.result = { ok: !v.is_error && v.subtype !== 'error_during_execution', text: clip(v.result, 4000), costUsd: v.total_cost_usd ?? null,
        durationMs: v.duration_ms ?? null, turns: v.num_turns ?? null };
      this.#push(run, { kind: 'result', ...run.result });
    }
    this.#maybeClose(run);
  }

  #control(run, v) {
    const req = v.request || {};
    if (req.subtype !== 'can_use_tool') {
      this.#write(run, { type: 'control_response', response: { subtype: 'error', request_id: v.request_id, error: 'unsupported control request' } });
      return;
    }
    const input = req.input && typeof req.input === 'object' ? req.input : {};
    const base = { requestId: v.request_id, tool: req.tool_name };
    if (req.tool_name === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions.length) {
      const questions = input.questions.map((q) => ({ question: String(q.question || ''), header: String(q.header || ''), multiSelect: q.multiSelect === true,
        options: (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: String(o.label || ''), description: String(o.description || '') })) }));
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
    const ask = { ...base, kind: 'permission', input, summary: summarize(req.tool_name, input), reason, via };
    run.pending.set(v.request_id, ask);
    this.#push(run, { kind: 'approval', requestId: v.request_id, tool: req.tool_name, summary: ask.summary, reason, via });
  }

  // behavior: 'allow' | 'deny'. For a question, `answers` maps each question text to the chosen label(s).
  respond(run, requestId, behavior, answers) {
    const p = run.pending.get(requestId);
    if (!p) return false;
    let response;
    if (behavior === 'allow') {
      const updated = { ...p.input };
      if (p.kind === 'question') {
        const out = {};
        for (const q of p.questions) {
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

  #maybeClose(run) {
    if (run.status !== 'running' || !run.result || run.pending.size) return;
    run.closeTimer = setTimeout(() => {
      if (run.status === 'running' && !run.pending.size) { try { run.child.stdin.end(); } catch { /* closed */ } }
    }, QUIET_AFTER_RESULT_MS);
  }

  stop(run) {
    if (run.status !== 'running') return false;
    run.stopping = true;
    try { run.child.stdin.end(); } catch { /* closed */ }
    try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-run.child.pid, 'SIGTERM'); } catch { /* gone */ }
    const t = setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-run.child.pid, 'SIGKILL'); } catch { /* gone */ } }, 4000);
    t.unref();
    return true;
  }

  stopAll() { for (const r of this.runs.values()) this.stop(r); }
  get(id) { return this.runs.get(id) || null; }
  forProject(projectId) { return [...this.runs.values()].filter((r) => r.projectId === projectId); }
  find(projectId, cwd) { return [...this.runs.values()].find((r) => r.projectId === projectId && r.cwd === cwd && r.status === 'running') || null; }

  view(run, since) {
    const out = { id: run.id, command: run.command, cwd: run.cwd, permissionMode: run.permissionMode, status: run.status, startedAt: run.startedAt,
      endedAt: run.endedAt, result: run.result, sessionId: run.sessionId,
      pending: [...run.pending.values()].map((p) => ({ requestId: p.requestId, kind: p.kind, tool: p.tool, summary: p.summary, reason: p.reason, via: p.via, questions: p.questions })) };
    if (since !== undefined) {
      out.events = run.events.slice(Math.max(0, since - run.dropped));
      out.cursor = run.dropped + run.events.length;
    }
    return out;
  }
}

module.exports = { Runs, MODES };
