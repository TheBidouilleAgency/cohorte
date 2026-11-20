// cohorte ui — a local dashboard over every project registered in the registry.
//
// Security model (this origin will launch commands in a later release, so it is hardened now):
//   - listens on 127.0.0.1 only;
//   - every /api request needs the session token (Authorization: Bearer), a loopback Host (DNS
//     rebinding) and, when the browser sends one, an Origin equal to this server's own;
//   - state-changing requests must be application/json (a cross-site form cannot send that);
//   - reads address a project by the id of a REGISTERED project, never by a path;
//   - the page is served with a strict CSP and renders project content with textContent only.

import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { registry, doctor, report, repo, uiDir, type Project, type SpecScan } from './legacy';
import { Jobs } from './jobs';
import { Runs } from './runs';
import { RunStore } from './history';
import * as gitinfo from './gitinfo';
import * as ops from './ops';
import * as docker from './docker';
import { pipelineOf } from './pipeline';
import { parseReviewReport } from './findings';
import { Flow } from './flow';
import { FOUNDING_ROLES } from './founding';
import { DEFAULTS as SETTINGS_DEFAULTS } from './settings';
import { TrackerError, connectObsidian, isTicketId } from './tracker';
import type { NewProjectBody, ActivityItem, DiffListResponse, GitResponse, ProjectDetail, ProjectSummary, SpecDetail, StateResponse, StreamEvent } from '../shared/api';

const { state, scanSpecs } = doctor;
const pkgRoot = repo;
const PUBLIC = path.join(uiDir, 'dist-web');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const REPORT_KINDS = ['readiness', 'build', 'verdict', 'verify', 'loop'];
const SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const MAX_BODY = 16 * 1024;

// A small TTL cache keyed by string; concurrent callers share one in-flight computation.
function memo<T>(ttlMs: number) {
  const m = new Map<string, { at: number; value: Promise<T>; pending: boolean }>();
  const run = (key: string, fn: () => T | Promise<T>): Promise<T> => {
    const hit = m.get(key);
    if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.value;
    const value = Promise.resolve().then(fn);
    const entry = { at: Date.now(), value, pending: true };
    m.set(key, entry);
    value.then(() => { entry.pending = false; entry.at = Date.now(); }, () => m.delete(key));
    return value;
  };
  run.clear = (key: string): boolean => m.delete(key);
  return run;
}

function runMetrics(root: string, args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const script = path.join(pkgRoot, 'scripts', 'metrics', 'collect.mjs');
    const child = spawn(process.execPath, [script, root, '--json', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('metrics timed out')); }, 60000);
    child.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`metrics exited ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('metrics returned no JSON')); }
    });
  });
}

function readJson(p: string): unknown { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

export interface CreateOpts { globalDir: string; version: string; token?: string; storePath?: string }
export function create({ globalDir, version, token = crypto.randomBytes(24).toString('hex'), storePath }: CreateOpts) {
  const cacheDoctor = memo<Awaited<ReturnType<typeof state>>>(8000);
  const cacheMetrics = memo<unknown>(60000);
  const jobs = new Jobs();
  const runs = new Runs({ store: new RunStore(path.join(globalDir, 'cohorte-ui', 'runs')) });
  const cachePulls = memo<Awaited<ReturnType<typeof gitinfo.pullFor>>>(60000);
  let ghOk: Promise<boolean> | null = null;

  // --- live updates: change NOTICES (not payloads) pushed over one authenticated event stream, coalesced ---
  const subs = new Set<http.ServerResponse>();
  const queued = new Map<string, StreamEvent>();
  let flushTimer: NodeJS.Timeout | null = null;
  const notify = (e: StreamEvent): void => {
    if (!subs.size) return;
    queued.set(`${e.type}:${e.id}`, e);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = [...queued.values()]; queued.clear();
      const frame = `data: ${JSON.stringify(batch)}\n\n`;
      for (const r of subs) { try { r.write(frame); } catch { subs.delete(r); } }
    }, 120);
  };
  const flow = new Flow({ globalDir, runs, jobs, dataDir: path.join(globalDir, 'cohorte-ui'), changed: (projectId) => {
    const pr = registry.get(globalDir, projectId);
    if (pr) cacheDoctor.clear(pr.root); // a founding step may have just written PIPELINE.md
    notify({ type: 'flow', projectId, id: projectId, status: 'changed' });
  } });
  jobs.onChange = (j) => {
    notify({ type: 'job', projectId: j.projectId, id: j.id, status: j.status });
    try { flow.onJob(j); flow.onMergeJob(j); } catch { /* the flow never takes a job down */ }
  };
  runs.onChange = (r) => notify({ type: 'run', projectId: r.projectId, id: r.id, status: r.status, pending: [...r.pending.values()].filter((x) => !x.deciding).length });
  let origin: string | null = null; // set once listening

  const doctorOf = (root: string) => cacheDoctor(root, () => state({ projectRoot: root, globalDir, cliVersion: version, offline: true }));

  async function summary(p: Project): Promise<ProjectSummary> {
    const base = { id: p.id, root: p.root, name: path.basename(p.root), addedAt: p.addedAt };
    if (!fs.existsSync(p.root)) return { ...base, missing: true };
    try {
      const s = await doctorOf(p.root);
      const counts: Record<string, number> = {};
      for (const sp of s.specs) counts[sp.status || 'unknown'] = (counts[sp.status || 'unknown'] || 0) + 1;
      return { ...base, missing: false, founding: flow.founding.phaseOf(p.id), title: s.profile && s.profile.name || base.name,
        oneLiner: s.profile && s.profile.one_liner || '', summary: s.summary, specCounts: counts,
        specTotal: s.specs.length, core: s.versions && s.versions.core || null };
    } catch (e) {
      return { ...base, missing: false, founding: flow.founding.phaseOf(p.id), error: String((e as Error)?.message || e) };
    }
  }

  async function detail(p: Project): Promise<ProjectDetail> {
    const s = await doctorOf(p.root);
    const specs = (report.specRecords(p.root, scanSpecs) as ProjectDetail['specs']).map((sp) => ({ ...sp, pipeline: pipelineOf(p.root, sp) }));
    const wt = registry.worktrees(p.root);
    const dev = ops.devInfo(p.root);
    const scripts = ops.isolationScripts(p.root);
    const withDev = wt.map((w, i) => { const j = jobs.find(p.id, 'dev', w.path); return { ...w, main: i === 0, dev: j ? jobs.view(j) : null }; });
    return { id: p.id, root: p.root, name: path.basename(p.root), doctor: s as ProjectDetail['doctor'], specs, worktrees: withDev,
      dev: { command: dev.command, ready: dev.ready }, isolation: scripts,
      docker: (() => { const c = docker.composeFile(p.root); return c ? { file: c.rel } : null; })(),
      runs: runs.forProject(p.id).map((r) => runs.view(r)) };
  }

  function specDetail(p: Project, specId: string): SpecDetail | null {
    if (!SPEC_ID.test(specId)) return null;
    const spec = scanSpecs(p.root).find((s) => s.id === specId);
    if (!spec) return null;
    let body = '';
    try { body = fs.readFileSync(path.join(p.root, 'specs', path.basename(spec.file)), 'utf8'); } catch { /* listed, then removed */ }
    const reports: Record<string, unknown> = {};
    for (const k of REPORT_KINDS) reports[k] = readJson(path.join(p.root, 'specs', 'reports', `${specId}.${k}.json`));
    let raw = '';
    try { raw = fs.readFileSync(path.join(p.root, 'specs', 'reports', `${specId}.md`), 'utf8').slice(0, 200000); } catch { /* no review report yet */ }
    return { spec: spec as SpecScan as SpecDetail['spec'], body: body.slice(0, 200000), reports, pipeline: pipelineOf(p.root, spec), review: { ...parseReviewReport(raw), raw } };
  }

  // --- http plumbing -------------------------------------------------------
  const send = (res: http.ServerResponse, code: number, obj: unknown): void => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  const fail = (res: http.ServerResponse, code: number, message: string): void => send(res, code, { error: message });

  function hostOk(req: http.IncomingMessage): boolean {
    const h = String(req.headers.host || '');
    return /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(h);
  }
  function tokenOk(req: http.IncomingMessage): boolean {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      let n = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('invalid JSON')); } });
      req.on('error', reject);
    });
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method;
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    if (method === 'POST' || method === 'DELETE') {
      if (method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return fail(res, 415, 'application/json required');
    }

    if (parts[0] === 'state' && method === 'GET') {
      const list = registry.load(globalDir);
      const out: StateResponse = { version, projects: await Promise.all(list.map(summary)) };
      return send(res, 200, out);
    }
    if (parts[0] === 'stream' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      res.write(': cohorte ui\n\n');
      subs.add(res);
      const beat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 20000);
      beat.unref();
      req.on('close', () => { clearInterval(beat); subs.delete(res); });
      return;
    }
    if (parts[0] === 'activity' && method === 'GET') {
      const names = new Map(registry.load(globalDir).map((p) => [p.id, path.basename(p.root)] as const));
      const items: ActivityItem[] = [];
      for (const j of jobs.jobs.values()) if (jobs.isLive(j) && names.has(j.projectId)) items.push({ projectId: j.projectId, projectName: names.get(j.projectId) as string, kind: j.kind === 'dev' ? 'dev' : j.kind.startsWith('docker') ? 'docker' : 'job', id: j.id, label: j.label, status: j.status, pending: 0, startedAt: j.startedAt });
      for (const r of runs.runs.values()) if ((r.status === 'running' || r.pending.size) && names.has(r.projectId)) items.push({ projectId: r.projectId, projectName: names.get(r.projectId) as string, kind: 'run', id: r.id, label: r.command, status: r.status, pending: r.pending.size, startedAt: r.startedAt });
      return send(res, 200, { items });
    }
    if (parts[0] === 'inbox' && method === 'GET') return send(res, 200, { items: flow.inbox() });
    if (parts[0] === 'commands' && method === 'GET') return send(res, 200, { commands: ops.listCommands(globalDir) });
    if (parts[0] === 'discover' && method === 'GET') {
      return send(res, 200, { suggestions: registry.discover(globalDir, storePath) });
    }
    if (parts[0] === 'founding' && parts.length === 1 && method === 'POST') {
      let body: Record<string, any>;
      try { body = await readBody(req); } catch (e) { return fail(res, 400, (e as Error).message); }
      try {
        const r = await flow.founding.create(body as NewProjectBody);
        return send(res, 201, { project: await summary(r.project), founding: r.founding });
      } catch (e) {
        if (e instanceof ops.OpError) return send(res, e.code, { error: e.message });
        if (e instanceof registry.RegistryError) return fail(res, 400, e.message);
        throw e;
      }
    }
    if (parts[0] === 'projects' && parts.length === 1 && method === 'POST') {
      let body: Record<string, any>;
      try { body = await readBody(req); } catch (e) { return fail(res, 400, (e as Error).message); }
      try {
        const r = registry.add(globalDir, body.path);
        return send(res, r.created ? 201 : 200, { project: await summary(r.project), created: r.created });
      } catch (e) {
        if (e instanceof registry.RegistryError) return send(res, 400, { error: e.message, notCohorte: /has no PIPELINE\.md/.test(e.message) });
        throw e;
      }
    }
    if (parts[0] === 'projects' && parts[1]) {
      const p = registry.get(globalDir, parts[1]);
      if (!p) return fail(res, 404, 'unknown project');
      if (parts.length === 2 && method === 'DELETE') { registry.remove(globalDir, p.id); return send(res, 200, { removed: true }); }
      if (!fs.existsSync(p.root)) return fail(res, 410, `${p.root} no longer exists — remove it from the list`);
      if (parts.length === 2 && method === 'GET') return send(res, 200, await detail(p));
      if (parts[2] === 'jobs') {
        if (parts.length === 3 && method === 'GET') return send(res, 200, { jobs: jobs.forProject(p.id).map((j) => jobs.view(j)) });
        const job = parts[3] && jobs.get(parts[3]);
        if (!job || job.projectId !== p.id) return fail(res, 404, 'unknown job');
        if (parts[4] === 'logs' && method === 'GET') return send(res, 200, jobs.view(job, Math.max(0, parseInt(url.searchParams.get('since') ?? '', 10) || 0)));
        if (parts[4] === 'stop' && method === 'POST') return send(res, 200, { stopped: ops.stopJob(jobs, p, job.id) });
      }
      if (parts[2] === 'runs') {
        if (parts.length === 3 && method === 'GET') return send(res, 200, { runs: runs.forProject(p.id).map((r) => runs.view(r)) });
        if (parts.length === 3 && method === 'POST') {
          let body: Record<string, any>;
          try { body = await readBody(req); } catch (e) { return fail(res, 400, (e as Error).message); }
          try { return send(res, 202, { run: runs.view(ops.startRun(runs, p, globalDir, body), 0) }); } catch (e) {
            if (e instanceof ops.OpError) return send(res, e.code, { error: e.message, untrusted: e.untrusted || false, fix: e.fix });
            throw e;
          }
        }
        const run = parts[3] && runs.get(parts[3]);
        if (!run || run.projectId !== p.id) return fail(res, 404, 'unknown run');
        if (parts.length === 4 && method === 'GET') return send(res, 200, runs.view(run, Math.max(0, parseInt(url.searchParams.get('since') ?? '', 10) || 0)));
        if (parts[4] === 'stop' && method === 'POST') return send(res, 200, { stopped: runs.stop(run) });
        if (parts[4] === 'reply' && method === 'POST') {
          let body: Record<string, any>;
          try { body = await readBody(req); } catch (e) { return fail(res, 400, (e as Error).message); }
          if (FOUNDING_ROLES.includes(run.meta.role)) {
            try { flow.founding.reply(p.id, body.text); return send(res, 202, { run: runs.view(run, 0) }); } catch (e) { if (e instanceof ops.OpError) return fail(res, e.code, e.message); throw e; }
          }
          if (run.meta.role === 'lead' && run.meta.featureId) {
            try { flow.replyLead(p.id, run.meta.featureId, body.text); return send(res, 202, { run: runs.view(run, 0) }); } catch (e) { if (e instanceof ops.OpError) return fail(res, e.code, e.message); throw e; }
          }
          const err = runs.reply(run, body.text);
          return err ? fail(res, 409, err) : send(res, 202, { run: runs.view(run, 0) });
        }
        if (parts[4] === 'respond' && method === 'POST') {
          let body: Record<string, any>;
          try { body = await readBody(req); } catch (e) { return fail(res, 400, (e as Error).message); }
          if (body.behavior !== 'allow' && body.behavior !== 'deny') return fail(res, 400, 'behavior must be allow or deny');
          return runs.respond(run, String(body.requestId), body.behavior, body.answers) ? send(res, 200, { ok: true }) : fail(res, 404, 'no such pending request');
        }
      }
      // ---- company flow ----
      const flowCall = async (fn: () => unknown | Promise<unknown>, code = 200): Promise<void> => {
        try { return send(res, code, await fn()); } catch (e) {
          if (e instanceof ops.OpError) return send(res, e.code, { error: e.message, needsConfirmation: e.needsConfirmation || false, command: e.command, reason: e.reason, untrusted: e.untrusted || false, fix: e.fix });
          if (e instanceof TrackerError) return fail(res, 400, e.message);
          throw e;
        }
      };
      const bodyOf = async (): Promise<Record<string, any> | null> => { try { return await readBody(req); } catch (e) { fail(res, 400, (e as Error).message); return null; } };
      if (parts[2] === 'tickets') {
        if (parts.length === 3 && method === 'GET') return flowCall(() => { const tr = flow.tracker(p); return { tracker: tr.info, tickets: tr.list(), conversations: flow.conversations(p.id) }; });
        if (parts.length === 3 && method === 'POST') { const b = await bodyOf(); if (!b) return; return flowCall(() => ({ ticket: flow.createTicket(p.id, b) }), 201); }
        const tid = parts[3];
        if (!isTicketId(tid)) return fail(res, 404, 'unknown ticket');
        if (parts.length === 4 && method === 'GET') { const t = flow.tracker(p).get(tid); return t ? send(res, 200, { ticket: t }) : fail(res, 404, 'unknown ticket'); }
        if (method === 'POST' && parts[4] === 'decide') { const b = await bodyOf(); if (!b) return; return flowCall(() => ({ ticket: flow.decideTicket(p.id, tid, b.action) })); }
        if (method === 'POST' && parts[4] === 'acceptance') { const b = await bodyOf(); if (!b) return; return flowCall(() => { const r = flow.acceptance(p.id, tid, b); return { ticket: r.ticket, run: r.run ? runs.view(r.run, 0) : null }; }); }
        if (method === 'POST' && parts[4] === 'take') {
          const b = await bodyOf(); if (!b) return;
          if (b.skipDockerCheck !== true && !flow.features.get(p.id, tid)) {
            const pre = await docker.preflight(p.root);
            if (pre && !pre.ok) return send(res, 409, { error: pre.reason, dockerPreflight: pre });
          }
          return flowCall(() => { cacheDoctor.clear(p.root); return { feature: flow.take(p.id, tid, { confirmed: b.confirmed === true }) }; }, 202);
        }
      }
      if (parts[2] === 'founding') {
        if (parts.length === 3 && method === 'GET') return flowCall(() => flow.founding.view(p.id));
        if (parts[3] === 'reply' && method === 'POST') { const b = await bodyOf(); if (!b) return; return flowCall(() => flow.founding.reply(p.id, b.text), 202); }
        if (parts[3] === 'checkpoint' && method === 'POST') { const b = await bodyOf(); if (!b) return; return flowCall(async () => { const v = await flow.founding.checkpoint(p.id, b); cacheDoctor.clear(p.root); return v; }); }
      }
      if (parts[2] === 'remote' && parts.length === 3) {
        if (method === 'GET') return flowCall(() => flow.founding.remote(p.id));
        if (method === 'POST') { const b = await bodyOf(); if (!b) return; return flowCall(async () => ({ job: jobs.view(await flow.founding.connectRemote(p.id, b)) }), 202); }
      }
      if (parts[2] === 'po' && parts.length === 3 && method === 'POST') { const b = await bodyOf(); if (!b) return; return flowCall(() => ({ run: runs.view(flow.startPO(p.id, b), 0) }), 202); }
      if (parts[2] === 'features') {
        if (parts.length === 3 && method === 'GET') return send(res, 200, { features: flow.features.list(p.id) });
        const fid = parts[3];
        if (!isTicketId(fid)) return fail(res, 404, 'unknown feature');
        if (parts.length === 4 && method === 'GET') return flowCall(() => flow.detail(p.id, fid));
        if (method === 'POST' && parts[4] === 'checkpoint') { const b = await bodyOf(); if (!b) return; return flowCall(() => ({ feature: flow.checkpoint(p.id, fid, b) })); }
        if (method === 'POST' && parts[4] === 'lead') { const b = await bodyOf(); if (!b) return; return flowCall(() => { flow.replyLead(p.id, fid, b.text); return { ok: true }; }, 202); }
        if (method === 'POST' && parts[4] === 'merge') return flowCall(() => ({ job: jobs.view(flow.merge(p.id, fid)) }), 202);
        if (method === 'POST' && parts[4] === 'decisions' && parts[5] && parts[6] === 'contest') { const b = await bodyOf(); if (!b) return; return flowCall(() => ({ feature: flow.contest(p.id, fid, parts[5], b.note) })); }
      }
      if (parts[2] === 'settings' && parts.length === 3) {
        const view = () => {
          const pm = path.join(p.root, 'PRODUCT.md');
          let updated: string | null = null;
          try { updated = fs.statSync(pm).mtime.toISOString(); } catch { updated = null; }
          return { settings: flow.settings.get(p.id), defaults: SETTINGS_DEFAULTS, tracker: flow.tracker(p).info, productMap: { exists: updated !== null, updated } };
        };
        if (method === 'GET') return send(res, 200, view());
        if (method === 'POST') { const b = await bodyOf(); if (!b) return; flow.settings.set(p.id, b); return send(res, 200, view()); }
      }
      if (parts[2] === 'tracker' && parts.length === 3 && method === 'POST') { const b = await bodyOf(); if (!b) return; return flowCall(() => ({ ...connectObsidian(globalDir, p.root, b), tracker: flow.tracker(p).info })); }
      if (parts[2] === 'product-map' && parts.length === 3 && method === 'POST') return flowCall(() => ({ run: runs.view(flow.startProductMap(p.id), 0) }), 202);
      if (parts[2] === 'learning' && parts.length === 3 && method === 'GET') return send(res, 200, flow.learning(p.id));

      if (parts[2] === 'docker' && parts.length === 3) {
        if (method === 'GET') return send(res, 200, await docker.status(p.root));
        if (method === 'POST') {
          let body: Record<string, any>;
          try { body = await readBody(req); } catch (e) { return fail(res, 400, (e as Error).message); }
          try { return send(res, 202, { job: jobs.view(await docker.act(jobs, p, { action: body.action, service: body.service, confirmed: body.confirmed === true })) }); } catch (e) {
            if (e instanceof ops.OpError) return send(res, e.code, { error: e.message, needsConfirmation: e.needsConfirmation || false, command: e.command, reason: e.reason, dockerDown: e.dockerDown || false });
            throw e;
          }
        }
      }
      if (method === 'POST' && (parts[2] === 'dev' || parts[2] === 'worktrees')) {
        let body: Record<string, any>;
        try { body = await readBody(req); } catch (e) { return fail(res, 400, (e as Error).message); }
        const confirmed = body.confirmed === true;
        try {
          let job: ReturnType<Jobs['start']>;
          if (parts[2] === 'worktrees' && parts.length === 3 && body.skipDockerCheck !== true) {
            const pre = await docker.preflight(p.root);
            if (pre && !pre.ok) return send(res, 409, { error: pre.reason, dockerPreflight: pre });
          }
          if (parts[2] === 'dev' && parts.length === 3) job = ops.startDev(jobs, p, body.worktree, { confirmed });
          else if (parts[2] === 'worktrees' && parts.length === 3) job = ops.createWorktree(jobs, p, body.feature, { confirmed });
          else if (parts[2] === 'worktrees' && parts[3] === 'remove') job = ops.removeWorktree(jobs, p, body.path, { confirmed });
          else return fail(res, 404, 'not found');
          cacheDoctor.clear(p.root);
          return send(res, 202, { job: jobs.view(job) });
        } catch (e) {
          if (e instanceof ops.OpError) return send(res, e.code, { error: e.message, needsConfirmation: e.needsConfirmation || false, command: e.command, reason: e.reason });
          throw e;
        }
      }
      if (parts[2] === 'git' && parts.length === 3 && method === 'GET') {
        const def = ops.readProfile(p.root).vcs?.default_branch || 'main';
        const wts = registry.worktrees(p.root);
        if (ghOk === null) ghOk = gitinfo.ghAvailable();
        const gh = await ghOk;
        const out: GitResponse = { worktrees: {}, gh };
        await Promise.all(wts.map(async (w, i) => {
          const info = await gitinfo.worktreeGit(w.path, def);
          const pull = gh && i > 0 && info.branch ? await cachePulls(`${p.root}|${info.branch}`, () => gitinfo.pullFor(p.root, info.branch as string)) : null;
          out.worktrees[w.path] = { ...info, pull };
        }));
        return send(res, 200, out);
      }
      if (parts[2] === 'diff' && parts.length === 3 && method === 'GET') {
        let wt;
        try { wt = ops.resolveWorktree(p.root, url.searchParams.get('worktree')); } catch (e) { if (e instanceof ops.OpError) return fail(res, e.code, e.message); throw e; }
        const base = await gitinfo.baseRef(wt.path, ops.readProfile(p.root).vcs?.default_branch || 'main');
        const file = url.searchParams.get('file');
        if (file === null) { const out: DiffListResponse = { base, files: await gitinfo.changedFiles(wt.path, base) }; return send(res, 200, out); }
        const d = await gitinfo.fileDiff(wt.path, base, file);
        return d ? send(res, 200, d) : fail(res, 404, 'not a changed file of this worktree');
      }
      if (parts[2] === 'metrics' && method === 'GET') {
        const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') ?? '', 10) || 30));
        try { return send(res, 200, await cacheMetrics(`${p.root}|${days}`, () => runMetrics(p.root, [`--days=${days}`, '--runs']))); }
        catch (e) { return fail(res, 502, (e as Error).message); }
      }
      if (parts[2] === 'specs' && parts[3] && method === 'GET') {
        const d = specDetail(p, parts[3]);
        return d ? send(res, 200, d) : fail(res, 404, 'unknown spec');
      }
    }
    return fail(res, 404, 'not found');
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    const ext = path.extname(file);
    if (!file.startsWith(PUBLIC + path.sep) || !TYPES[ext]) { res.writeHead(404); res.end('not found'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) { res.writeHead(403); return res.end('bad host'); }
      const url = new URL(req.url || '/', 'http://x');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const o = req.headers.origin;
        if (o && o !== origin) return fail(res, 403, 'bad origin');
        if (!tokenOk(req)) return fail(res, 401, 'missing or invalid token');
        return await api(req, res, url);
      }
      serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) fail(res, 500, String((e as Error)?.message || e));
      else res.end();
    }
  });

  function listen(port = 0): Promise<{ port: number; url: string; token: string; origin: string }> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const p = (server.address() as import('net').AddressInfo).port;
        origin = `http://127.0.0.1:${p}`;
        resolve({ port: p, url: `${origin}/#token=${token}`, token, origin });
      });
    });
  }

  flow.start();
  return { server, listen, token, jobs, runs, flow, close: () => {
    flow.stop(); jobs.stopAll(); runs.stopAll(); runs.flush();
    for (const r of subs) { try { r.end(); } catch { /* closed */ } }
    subs.clear();
    return new Promise<void>((r) => { server.close(() => r()); (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.(); });
  } };
}
