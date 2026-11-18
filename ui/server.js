'use strict';
// cohorte ui — a local dashboard over every project registered in the registry.
//
// Security model (this origin will launch commands in a later release, so it is hardened now):
//   - listens on 127.0.0.1 only;
//   - every /api request needs the session token (Authorization: Bearer), a loopback Host (DNS
//     rebinding) and, when the browser sends one, an Origin equal to this server's own;
//   - state-changing requests must be application/json (a cross-site form cannot send that);
//   - reads address a project by the id of a REGISTERED project, never by a path;
//   - the page is served with a strict CSP and renders project content with textContent only.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const registry = require('../lib/registry.js');
const { state, scanSpecs } = require('../lib/doctor.js');
const report = require('../bin/report.js');
const { Jobs } = require('./jobs.js');
const { Runs } = require('./runs.js');
const ops = require('./ops.js');
const docker = require('./docker.js');

const pkgRoot = path.join(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const REPORT_KINDS = ['readiness', 'build', 'verdict', 'verify'];
const SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const MAX_BODY = 16 * 1024;

// A small TTL cache keyed by string; concurrent callers share one in-flight computation.
function memo(ttlMs) {
  const m = new Map();
  const run = (key, fn) => {
    const hit = m.get(key);
    if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.value;
    const value = Promise.resolve().then(fn);
    const entry = { at: Date.now(), value, pending: true };
    m.set(key, entry);
    value.then(() => { entry.pending = false; entry.at = Date.now(); }, () => m.delete(key));
    return value;
  };
  run.clear = (key) => m.delete(key);
  return run;
}

function runMetrics(root, args) {
  return new Promise((resolve, reject) => {
    const script = path.join(pkgRoot, 'scripts', 'metrics', 'collect.mjs');
    const child = spawn(process.execPath, [script, root, '--json', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('metrics timed out')); }, 60000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`metrics exited ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('metrics returned no JSON')); }
    });
  });
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function create({ globalDir, version, token = crypto.randomBytes(24).toString('hex'), storePath }) {
  const cacheDoctor = memo(8000);
  const cacheMetrics = memo(60000);
  const jobs = new Jobs();
  const runs = new Runs();
  let origin = null; // set once listening

  const doctorOf = (root) => cacheDoctor(root, () => state({ projectRoot: root, globalDir, cliVersion: version, offline: true }));

  async function summary(p) {
    const base = { id: p.id, root: p.root, name: path.basename(p.root), addedAt: p.addedAt };
    if (!fs.existsSync(p.root)) return { ...base, missing: true };
    try {
      const s = await doctorOf(p.root);
      const counts = {};
      for (const sp of s.specs) counts[sp.status || 'unknown'] = (counts[sp.status || 'unknown'] || 0) + 1;
      return { ...base, missing: false, title: s.profile && s.profile.name || base.name,
        oneLiner: s.profile && s.profile.one_liner || '', summary: s.summary, specCounts: counts,
        specTotal: s.specs.length, core: s.versions && s.versions.core || null };
    } catch (e) {
      return { ...base, missing: false, error: String(e && e.message || e) };
    }
  }

  async function detail(p) {
    const s = await doctorOf(p.root);
    const specs = report.specRecords(p.root, scanSpecs);
    const wt = registry.worktrees(p.root);
    const dev = ops.devInfo(p.root);
    const scripts = ops.isolationScripts(p.root);
    const withDev = wt.map((w, i) => ({ ...w, main: i === 0, dev: (jobs.find(p.id, 'dev', w.path) && jobs.view(jobs.find(p.id, 'dev', w.path))) || null }));
    return { id: p.id, root: p.root, name: path.basename(p.root), doctor: s, specs, worktrees: withDev,
      dev: { command: dev.command, ready: dev.ready }, isolation: scripts,
      docker: (() => { const c = docker.composeFile(p.root); return c ? { file: c.rel } : null; })(),
      runs: runs.forProject(p.id).map((r) => runs.view(r)) };
  }

  function specDetail(p, specId) {
    if (!SPEC_ID.test(specId)) return null;
    const spec = scanSpecs(p.root).find((s) => s.id === specId);
    if (!spec) return null;
    let body = '';
    try { body = fs.readFileSync(path.join(p.root, 'specs', path.basename(spec.file)), 'utf8'); } catch { /* listed, then removed */ }
    const reports = {};
    for (const k of REPORT_KINDS) reports[k] = readJson(path.join(p.root, 'specs', 'reports', `${specId}.${k}.json`));
    return { spec, body: body.slice(0, 200000), reports };
  }

  // --- http plumbing -------------------------------------------------------
  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  const fail = (res, code, message) => send(res, code, { error: message });

  function hostOk(req) {
    const h = String(req.headers.host || '');
    return /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(h);
  }
  function tokenOk(req) {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let n = 0;
      const chunks = [];
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('invalid JSON')); } });
      req.on('error', reject);
    });
  }

  async function api(req, res, url) {
    const method = req.method;
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    if (method === 'POST' || method === 'DELETE') {
      if (method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return fail(res, 415, 'application/json required');
    }

    if (parts[0] === 'state' && method === 'GET') {
      const list = registry.load(globalDir);
      return send(res, 200, { version, projects: await Promise.all(list.map(summary)) });
    }
    if (parts[0] === 'commands' && method === 'GET') return send(res, 200, { commands: ops.listCommands(globalDir) });
    if (parts[0] === 'discover' && method === 'GET') {
      return send(res, 200, { suggestions: registry.discover(globalDir, storePath) });
    }
    if (parts[0] === 'projects' && parts.length === 1 && method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
      try {
        const r = registry.add(globalDir, body.path);
        return send(res, r.created ? 201 : 200, { project: await summary(r.project), created: r.created });
      } catch (e) {
        if (e instanceof registry.RegistryError) return fail(res, 400, e.message);
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
        if (parts[4] === 'logs' && method === 'GET') return send(res, 200, jobs.view(job, Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0)));
        if (parts[4] === 'stop' && method === 'POST') return send(res, 200, { stopped: ops.stopJob(jobs, p, job.id) });
      }
      if (parts[2] === 'runs') {
        if (parts.length === 3 && method === 'GET') return send(res, 200, { runs: runs.forProject(p.id).map((r) => runs.view(r)) });
        if (parts.length === 3 && method === 'POST') {
          let body;
          try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
          try { return send(res, 202, { run: runs.view(ops.startRun(runs, p, globalDir, body), 0) }); } catch (e) {
            if (e instanceof ops.OpError) return send(res, e.code, { error: e.message, untrusted: e.untrusted || false, fix: e.fix });
            throw e;
          }
        }
        const run = parts[3] && runs.get(parts[3]);
        if (!run || run.projectId !== p.id) return fail(res, 404, 'unknown run');
        if (parts.length === 4 && method === 'GET') return send(res, 200, runs.view(run, Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0)));
        if (parts[4] === 'stop' && method === 'POST') return send(res, 200, { stopped: runs.stop(run) });
        if (parts[4] === 'reply' && method === 'POST') {
          let body;
          try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
          const err = runs.reply(run, body.text);
          return err ? fail(res, 409, err) : send(res, 202, { run: runs.view(run, 0) });
        }
        if (parts[4] === 'respond' && method === 'POST') {
          let body;
          try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
          if (body.behavior !== 'allow' && body.behavior !== 'deny') return fail(res, 400, 'behavior must be allow or deny');
          return runs.respond(run, String(body.requestId), body.behavior, body.answers) ? send(res, 200, { ok: true }) : fail(res, 404, 'no such pending request');
        }
      }
      if (parts[2] === 'docker' && parts.length === 3) {
        if (method === 'GET') return send(res, 200, await docker.status(p.root));
        if (method === 'POST') {
          let body;
          try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
          try { return send(res, 202, { job: jobs.view(await docker.act(jobs, p, { action: body.action, service: body.service, confirmed: body.confirmed === true })) }); } catch (e) {
            if (e instanceof ops.OpError) return send(res, e.code, { error: e.message, needsConfirmation: e.needsConfirmation || false, command: e.command, reason: e.reason, dockerDown: e.dockerDown || false });
            throw e;
          }
        }
      }
      if (method === 'POST' && (parts[2] === 'dev' || parts[2] === 'worktrees')) {
        let body;
        try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
        const confirmed = body.confirmed === true;
        try {
          let job;
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
      if (parts[2] === 'metrics' && method === 'GET') {
        const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 30));
        try { return send(res, 200, await cacheMetrics(`${p.root}|${days}`, () => runMetrics(p.root, [`--days=${days}`, '--runs']))); }
        catch (e) { return fail(res, 502, e.message); }
      }
      if (parts[2] === 'specs' && parts[3] && method === 'GET') {
        const d = specDetail(p, parts[3]);
        return d ? send(res, 200, d) : fail(res, 404, 'unknown spec');
      }
    }
    return fail(res, 404, 'not found');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    const ext = path.extname(file);
    if (!file.startsWith(PUBLIC + path.sep) || !TYPES[ext]) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) { res.writeHead(403); return res.end('bad host'); }
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const o = req.headers.origin;
        if (o && o !== origin) return fail(res, 403, 'bad origin');
        if (!tokenOk(req)) return fail(res, 401, 'missing or invalid token');
        return await api(req, res, url);
      }
      serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) fail(res, 500, String(e && e.message || e));
      else res.end();
    }
  });

  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const p = server.address().port;
        origin = `http://127.0.0.1:${p}`;
        resolve({ port: p, url: `${origin}/#token=${token}`, token, origin });
      });
    });
  }

  return { server, listen, token, jobs, runs, close: () => { jobs.stopAll(); runs.stopAll(); return new Promise((r) => server.close(r)); } };
}

module.exports = { create };
