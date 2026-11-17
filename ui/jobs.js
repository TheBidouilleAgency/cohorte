'use strict';
// cohorte ui — child processes the dashboard starts (dev servers, worktree scripts).
//
// A job is one command in one folder, in its own process group so that stopping it stops the whole
// tree (a dev server spawns children). Output is kept in a bounded ring buffer that clients poll with a
// cursor. Nothing here accepts a command from a client: callers pass commands that came from the
// project's own profile or from fixed git invocations, after the project's gate had its say.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_LINES = 2000;
const MAX_LINE = 4000;
const KILL_GRACE_MS = 4000;

function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, signal);
  } catch { /* already gone */ }
}

function probeOnce(target, cwd) {
  return new Promise((resolve) => {
    if (/^https?:\/\//i.test(target)) {
      const lib = target.startsWith('https') ? https : http;
      const req = lib.get(target, { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 400); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } else {
      const c = spawn(target, { shell: true, cwd, stdio: 'ignore' });
      const t = setTimeout(() => c.kill(), 5000);
      c.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
      c.on('error', () => { clearTimeout(t); resolve(false); });
    }
  });
}

class Jobs {
  constructor() { this.jobs = new Map(); }

  // opts: { projectId, kind, label, cwd, command (shell string) | file+args, ready, readyTimeoutMs, tag, env }
  start(opts) {
    const id = crypto.randomBytes(4).toString('hex');
    const job = {
      id, projectId: opts.projectId, kind: opts.kind, label: opts.label, cwd: opts.cwd, tag: opts.tag || null,
      command: opts.command || [opts.file, ...(opts.args || [])].join(' '),
      status: 'starting', pid: null, startedAt: new Date().toISOString(), endedAt: null, exitCode: null,
      lines: [], dropped: 0, stopping: false, child: null,
    };
    const push = (chunk) => {
      for (const raw of String(chunk).split(/\r?\n/)) {
        if (raw === '') continue;
        job.lines.push(raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}…` : raw);
      }
      if (job.lines.length > MAX_LINES) { const cut = job.lines.length - MAX_LINES; job.lines.splice(0, cut); job.dropped += cut; }
    };
    const child = opts.command
      ? spawn(opts.command, { shell: true, cwd: opts.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) } })
      : spawn(opts.file, opts.args || [], { cwd: opts.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) } });
    job.child = child;
    job.pid = child.pid || null;
    job.status = 'running';
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => { push(`[cohorte ui] could not start: ${e.message}`); job.status = 'failed'; job.endedAt = new Date().toISOString(); });
    child.on('close', (code, signal) => {
      job.exitCode = code;
      job.endedAt = new Date().toISOString();
      job.status = job.stopping ? 'stopped' : code === 0 ? 'done' : 'failed';
      if (signal && !job.stopping) push(`[cohorte ui] killed by ${signal}`);
      clearTimeout(job.readyTimer);
    });
    if (opts.ready) this.#waitReady(job, opts.ready, opts.readyTimeoutMs || 90000);
    this.jobs.set(id, job);
    return job;
  }

  async #waitReady(job, target, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (job.status === 'running' && Date.now() < until) {
      if (await probeOnce(target, job.cwd)) { if (job.status === 'running') job.status = 'ready'; return; }
      await new Promise((r) => { job.readyTimer = setTimeout(r, 1000); });
    }
    if (job.status === 'running') job.lines.push(`[cohorte ui] not ready after ${Math.round(timeoutMs / 1000)}s (still running) — probe: ${target}`);
  }

  isLive(job) { return job.status === 'running' || job.status === 'ready' || job.status === 'starting'; }

  find(projectId, kind, tag) {
    return [...this.jobs.values()].reverse().find((j) => j.projectId === projectId && j.kind === kind && j.tag === tag && this.isLive(j)) || null;
  }

  get(id) { return this.jobs.get(id) || null; }

  forProject(projectId) { return [...this.jobs.values()].filter((j) => j.projectId === projectId); }

  stop(job) {
    if (!this.isLive(job)) return false;
    job.stopping = true;
    killTree(job.child, 'SIGTERM');
    const t = setTimeout(() => killTree(job.child, 'SIGKILL'), KILL_GRACE_MS);
    t.unref();
    return true;
  }

  stopAll() {
    for (const j of this.jobs.values()) if (this.isLive(j)) { j.stopping = true; killTree(j.child, 'SIGTERM'); }
  }

  view(job, since) {
    const out = { id: job.id, kind: job.kind, label: job.label, cwd: job.cwd, tag: job.tag, command: job.command, status: job.status,
      pid: job.pid, startedAt: job.startedAt, endedAt: job.endedAt, exitCode: job.exitCode };
    if (since !== undefined) {
      const total = job.dropped + job.lines.length;
      const from = Math.max(0, since - job.dropped);
      out.lines = job.lines.slice(from);
      out.cursor = total;
    }
    return out;
  }
}

module.exports = { Jobs };
