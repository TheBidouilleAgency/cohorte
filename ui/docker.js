'use strict';
// cohorte ui — the project's Docker Compose stack: what is up, and the few things the dashboard may do to it.
//
// Same rules as ops.js:
//   - the compose file is the one the profile declares (isolation.compose_file) or a conventional name at the
//     repo root, resolved INSIDE the repo — never a path from the client;
//   - the verbs are fixed (up -d, stop, restart, down, logs); `down` never takes -v, so volumes (the data) stay;
//   - a service name from the client is only accepted when `docker compose config --services` lists it;
//   - the project's gate is asked first, like every other command this dashboard launches.
// Reads (daemon, ps) never go through a shell and are bounded by a timeout so a hung daemon cannot hang the page.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { OpError, gateVerdict, confirm, readProfile } = require('./ops.js');

const CANDIDATES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const ACTIONS = ['up', 'stop', 'restart', 'down', 'logs'];
const bin = () => process.env.COHORTE_DOCKER_BIN || 'docker';
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// { file, rel } or null. The declared file wins; it must stay inside the repo.
function composeFile(root) {
  const declared = ((readProfile(root).isolation || {}).compose_file);
  const names = typeof declared === 'string' && declared.trim() ? [declared.trim(), ...CANDIDATES] : CANDIDATES;
  const base = realOr(root);
  for (const n of names) {
    if (path.isAbsolute(n)) continue;
    const file = realOr(path.join(root, n));
    if (!file.startsWith(base + path.sep)) continue;
    try { if (fs.statSync(file).isFile()) return { file, rel: path.relative(base, file) }; } catch { /* next */ }
  }
  return null;
}

// Async, bounded, no shell. Resolves { code, out, err, missing } — never rejects.
function exec(args, { cwd, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ out, err, ...r }); } };
    let child;
    try { child = spawn(bin(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, out, err: e.message, missing: e.code === 'ENOENT' }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ code: -1, timedOut: true }); }, timeout);
    child.stdout.on('data', (d) => { out += d; if (out.length > 2e6) out = out.slice(-2e6); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 2e5) err = err.slice(-2e5); });
    child.on('error', (e) => finish({ code: -1, missing: e.code === 'ENOENT', err: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

const firstLine = (s) => String(s || '').trim().split(/\r?\n/).find((l) => l.trim()) || '';

// `docker compose ps --format json` prints one object per line on recent versions, a JSON array on older ones.
function parsePs(out) {
  const text = String(out || '').trim();
  if (!text) return [];
  let rows = [];
  try { const v = JSON.parse(text); rows = Array.isArray(v) ? v : [v]; } catch {
    for (const l of text.split(/\r?\n/)) { try { rows.push(JSON.parse(l)); } catch { /* not a row */ } }
  }
  return rows.filter((r) => r && typeof r === 'object');
}

function portsOf(row) {
  const pubs = Array.isArray(row.Publishers) ? row.Publishers : [];
  const seen = new Set();
  for (const p of pubs) if (p && p.PublishedPort) seen.add(`${p.PublishedPort}→${p.TargetPort}`);
  return [...seen];
}

async function daemon() {
  const r = await exec(['info', '--format', '{{.ServerVersion}}'], { timeout: 6000 });
  if (r.missing) return { installed: false, up: false, error: 'the docker CLI is not installed (or not on PATH)' };
  if (r.timedOut) return { installed: true, up: false, error: 'the Docker daemon did not answer in time' };
  if (r.code !== 0) return { installed: true, up: false, error: firstLine(r.err) || 'the Docker daemon is not running' };
  return { installed: true, up: true, version: firstLine(r.out) };
}

// Everything the Docker tab shows. Each part degrades alone: no daemon still lists the declared services.
async function status(root) {
  const cf = composeFile(root);
  if (!cf) return { configured: false };
  const [d, cfg] = await Promise.all([daemon(), exec(['compose', '-f', cf.file, 'config', '--services'], { cwd: root })]);
  const defined = cfg.code === 0 ? cfg.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const out = { configured: true, file: cf.rel, daemon: d, services: [], configError: cfg.code === 0 ? null : firstLine(cfg.err) || 'docker compose could not read the file' };
  let rows = [];
  if (d.up && defined.length) {
    const ps = await exec(['compose', '-f', cf.file, 'ps', '-a', '--format', 'json'], { cwd: root });
    if (ps.code === 0) rows = parsePs(ps.out); else out.psError = firstLine(ps.err);
  }
  const by = new Map();
  for (const r of rows) by.set(r.Service || r.Name, r);
  const names = defined.length ? defined : [...by.keys()];
  out.services = names.map((name) => {
    const r = by.get(name);
    if (!r) return { name, state: d.up ? 'not created' : 'unknown', health: '', status: '', ports: [], image: '' };
    return { name, state: String(r.State || '').toLowerCase() || 'unknown', health: String(r.Health || '').toLowerCase(), status: String(r.Status || ''), ports: portsOf(r), image: String(r.Image || '') };
  });
  out.running = out.services.filter((s) => s.state === 'running').length;
  return out;
}

// Starts up/stop/restart/down/logs as a job. Returns the job.
async function act(jobs, project, { action, service, confirmed = false }) {
  if (!ACTIONS.includes(action)) throw new OpError(`action must be one of ${ACTIONS.join(', ')}`);
  const cf = composeFile(project.root);
  if (!cf) throw new OpError('this project declares no compose file (isolation.compose_file)', 400);
  const d = await daemon();
  if (!d.up) throw new OpError(d.error || 'the Docker daemon is not running', 409, { dockerDown: true });
  let svc = null;
  if (service !== undefined && service !== null && service !== '') {
    if (action === 'down') throw new OpError('down applies to the whole stack');
    const cfg = await exec(['compose', '-f', cf.file, 'config', '--services'], { cwd: project.root });
    const defined = cfg.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (typeof service !== 'string' || !defined.includes(service)) throw new OpError('not a service of this compose file', 404);
    svc = service;
  }
  const verb = { up: ['up', '-d'], stop: ['stop'], restart: ['restart'], down: ['down'], logs: ['logs', '--no-color', '--tail', '200', '-f'] }[action];
  const args = ['compose', '-f', cf.file, ...verb, ...(svc ? [svc] : [])];
  const shown = `docker compose -f ${cf.rel} ${verb.join(' ')}${svc ? ` ${svc}` : ''}`;
  const kind = action === 'logs' ? 'docker-logs' : 'docker';
  const tag = action === 'logs' ? (svc || '*') : 'stack';
  if (jobs.find(project.id, kind, tag)) throw new OpError(action === 'logs' ? 'these logs are already being followed' : 'a docker command is already running for this project', 409);
  confirm(gateVerdict(project.root, shown, project.root), confirmed, shown);
  return jobs.start({ projectId: project.id, kind, tag, label: `docker · ${verb[0]}${svc ? ` ${svc}` : ''}`, cwd: project.root, file: bin(), args, command: undefined, display: shown });
}

// Before `scripts/new-feature.sh`: the script creates the worktree's database INSIDE a compose service
// (`docker compose exec -T postgres …`), so it fails — late and obscurely — when Docker or that service is down.
// Returns null when the script needs nothing, else { ok, reason, services, missing }.
async function preflight(root) {
  const cf = composeFile(root);
  let script = '';
  try { script = fs.readFileSync(path.join(root, 'scripts', 'new-feature.sh'), 'utf8'); } catch { return null; }
  if (!cf || !/\bdocker\b/.test(script)) return null;
  const needs = new Set();
  const re = /docker\s+compose[^\n]*?\bexec\b\s+(?:-[A-Za-z-]+\s+)*([A-Za-z][\w.-]*)/g;
  for (let m = re.exec(script); m; m = re.exec(script)) needs.add(m[1]);
  const s = await status(root);
  if (!s.daemon.installed) return { ok: false, reason: s.daemon.error, services: [...needs], missing: [...needs], daemonUp: false };
  if (!s.daemon.up) return { ok: false, reason: `${s.daemon.error || 'the Docker daemon is not running'} — scripts/new-feature.sh needs it to create the worktree's database`, services: [...needs], missing: [...needs], daemonUp: false };
  const down = [...needs].filter((n) => { const x = s.services.find((v) => v.name === n); return !x || x.state !== 'running'; });
  if (down.length) return { ok: false, reason: `scripts/new-feature.sh runs commands inside ${down.join(', ')}, which ${down.length > 1 ? 'are' : 'is'} not running`, services: [...needs], missing: down, daemonUp: true };
  return { ok: true, services: [...needs], missing: [], daemonUp: true };
}

module.exports = { composeFile, status, act, preflight, ACTIONS, parsePs };
