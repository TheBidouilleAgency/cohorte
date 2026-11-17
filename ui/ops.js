'use strict';
// cohorte ui — what the dashboard can DO to a project: provision / remove a worktree, start a dev server.
//
// Rules, each one a thing the HTTP layer must not be trusted with:
//   - the command that runs is never client-supplied: it is the project's own `commands.dev` or its own
//     isolation scripts, or a fixed git invocation;
//   - the project's gate (.claude/hooks/cohorte-gate.py --check) is asked first, like verify-run.sh does:
//     `deny` refuses, `ask` needs an explicit confirmation from the human;
//   - a worktree is addressed by a path that `git worktree list` reports for that repo;
//   - the main checkout is never removed, and removal never forces (a dirty tree is refused by git).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const registry = require('../lib/registry.js');
const { checkTrust } = require('../lib/doctor.js');
const { parseProfileBlock } = require('../lib/yaml.js');

const FEATURE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
class OpError extends Error { constructor(message, code = 400, extra = {}) { super(message); this.code = code; Object.assign(this, extra); } }

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

function readProfile(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'profile.json'), 'utf8')); } catch { /* fall through */ }
  try { return parseProfileBlock(fs.readFileSync(path.join(root, 'PIPELINE.md'), 'utf8')) || {}; } catch { return {}; }
}

// 'allow' | 'ask' | 'deny' + the gate's own words. No gate file ⇒ allow (nothing to ask).
function gateVerdict(root, command, cwd) {
  const gate = path.join(root, '.claude', 'hooks', 'cohorte-gate.py');
  if (!fs.existsSync(gate)) return { verdict: 'allow', reason: '' };
  const r = spawnSync('python3', [gate, '--check', '--cwd', cwd || root, '--', command], { encoding: 'utf8', timeout: 15000 });
  if (r.error) return { verdict: 'ask', reason: `the gate could not run (${r.error.message})` };
  const reason = (r.stdout || '').trim();
  return { verdict: r.status === 0 ? 'allow' : r.status === 2 ? 'deny' : 'ask', reason };
}

function isolationScripts(root) {
  const has = (n) => fs.existsSync(path.join(root, 'scripts', n));
  return { create: has('new-feature.sh'), remove: has('remove-feature.sh') };
}

function devInfo(root) {
  const c = (readProfile(root).commands || {});
  return { command: typeof c.dev === 'string' && c.dev.trim() ? c.dev.trim() : null,
    ready: typeof c.dev_ready === 'string' && c.dev_ready.trim() ? c.dev_ready.trim() : null };
}

function resolveWorktree(root, wtPath) {
  if (typeof wtPath !== 'string') throw new OpError('a worktree path is required');
  const want = realOr(wtPath);
  const wt = registry.worktrees(root).find((w) => realOr(w.path) === want);
  if (!wt) throw new OpError('not a worktree of this project', 404);
  return wt;
}

function confirm(verdict, confirmed, command) {
  if (verdict.verdict === 'deny') throw new OpError(`the project's gate refuses this command: ${verdict.reason}`, 403);
  if (verdict.verdict === 'ask' && !confirmed) {
    throw new OpError('the project gate asks for confirmation', 409, { needsConfirmation: true, command, reason: verdict.reason });
  }
}

function startDev(jobs, project, wtPath, { confirmed = false } = {}) {
  const wt = resolveWorktree(project.root, wtPath);
  const dev = devInfo(project.root);
  if (!dev.command) throw new OpError('this project declares no commands.dev in its profile', 400);
  if (jobs.find(project.id, 'dev', wt.path)) throw new OpError('a dev server is already running in this worktree', 409);
  confirm(gateVerdict(project.root, dev.command, wt.path), confirmed, dev.command);
  return jobs.start({ projectId: project.id, kind: 'dev', tag: wt.path, label: `dev · ${path.basename(wt.path)}`, cwd: wt.path,
    command: dev.command, ready: dev.ready });
}

function stopJob(jobs, project, jobId) {
  const job = jobs.get(jobId);
  if (!job || job.projectId !== project.id) throw new OpError('unknown job', 404);
  return jobs.stop(job);
}

function createWorktree(jobs, project, feature, { confirmed = false } = {}) {
  if (typeof feature !== 'string' || !FEATURE_ID.test(feature)) throw new OpError('the feature id must be kebab-case (a-z, 0-9, -; at most 63 chars)');
  const root = project.root;
  const scripts = isolationScripts(root);
  const label = `worktree · ${feature}`;
  if (scripts.create) {
    const command = `scripts/new-feature.sh ${feature}`;
    confirm(gateVerdict(root, command, root), confirmed, command);
    return jobs.start({ projectId: project.id, kind: 'worktree-create', tag: feature, label, cwd: root, file: 'bash', args: ['scripts/new-feature.sh', feature] });
  }
  // No isolation script: a plain sibling worktree on a new branch, off the remote default branch when there is one.
  const profile = readProfile(root);
  const vcs = profile.vcs || {};
  const prefix = typeof vcs.feature_branch_prefix === 'string' ? vcs.feature_branch_prefix : 'feature/';
  const def = typeof vcs.default_branch === 'string' && vcs.default_branch ? vcs.default_branch : 'main';
  const base = git(root, 'rev-parse', '--verify', '-q', `origin/${def}`).status === 0 ? `origin/${def}` : 'HEAD';
  const dir = path.join(path.dirname(root), `${path.basename(root)}-${feature}`);
  if (fs.existsSync(dir)) throw new OpError(`${dir} already exists`, 409);
  return jobs.start({ projectId: project.id, kind: 'worktree-create', tag: feature, label, cwd: root,
    file: 'git', args: ['worktree', 'add', '-b', `${prefix}${feature}`, dir, base] });
}

function removeWorktree(jobs, project, wtPath, { confirmed = false } = {}) {
  const root = project.root;
  const all = registry.worktrees(root);
  const wt = resolveWorktree(root, wtPath);
  if (all[0] && realOr(all[0].path) === realOr(wt.path)) throw new OpError('the main checkout cannot be removed', 400);
  if (jobs.find(project.id, 'dev', wt.path)) throw new OpError('stop the dev server in this worktree first', 409);
  const label = `remove · ${path.basename(wt.path)}`;
  const scripts = isolationScripts(root);
  const prefix = ((readProfile(root).vcs || {}).feature_branch_prefix) || 'feature/';
  const id = wt.branch && wt.branch.startsWith(prefix) ? wt.branch.slice(prefix.length) : null;
  if (scripts.remove && id && FEATURE_ID.test(id)) {
    const command = `scripts/remove-feature.sh ${id}`;
    confirm(gateVerdict(root, command, root), confirmed, command);
    return jobs.start({ projectId: project.id, kind: 'worktree-remove', tag: wt.path, label, cwd: root, file: 'bash', args: ['scripts/remove-feature.sh', id] });
  }
  // Never --force: git itself refuses a worktree with changes in it. The branch is left alone.
  return jobs.start({ projectId: project.id, kind: 'worktree-remove', tag: wt.path, label, cwd: root, file: 'git', args: ['worktree', 'remove', wt.path] });
}

// The pipeline commands this machine has (`cohorte install` wrote them), with their one-line description.
function listCommands(globalDir) {
  const dir = path.join(globalDir, 'commands');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^cohorte-[a-z0-9-]+\.md$/.test(f)).sort(); } catch { return []; }
  return files.map((f) => {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const d = fm && fm[1].match(/^description:\s*(.*)$/m);
    const h = fm && fm[1].match(/^argument-hint:\s*(.*)$/m);
    return { name: f.slice(0, -3), description: d ? d[1].replace(/^["']|["']$/g, '').trim() : '', argumentHint: h ? h[1].replace(/^["']|["']$/g, '').trim() : '' };
  });
}

// Starts `/cohorte-<name> <args>` in a worktree. What the human may pass is a command NAME this machine has
// and a one-line argument; both reach Claude as prompt text, never a shell.
function startRun(runs, project, globalDir, body) {
  const wt = resolveWorktree(project.root, body.worktree);
  const name = typeof body.command === 'string' ? body.command.replace(/^\//, '') : '';
  if (!listCommands(globalDir).some((c) => c.name === name)) throw new OpError('unknown cohorte command — run `cohorte install`', 400);
  const args = typeof body.args === 'string' ? body.args.trim() : '';
  if (args.length > 500 || /[\r\n]/.test(args)) throw new OpError('arguments must be one line of at most 500 characters');
  if (runs.find(project.id, wt.path)) throw new OpError('a run is already in progress in this worktree', 409);
  // Under `claude -p`, an untrusted folder's permissions.allow are ignored: every pipeline script would prompt.
  const trust = checkTrust(wt.path, globalDir);
  if (trust.status === 'warn' && body.acknowledgeUntrusted !== true) {
    throw new OpError(trust.detail, 409, { untrusted: true, fix: trust.fix });
  }
  if (fs.existsSync(path.join(project.root, '.claude', 'hooks', 'cohorte-gate.py')) && spawnSync('python3', ['--version'], { stdio: 'ignore' }).status !== 0) {
    throw new OpError('python3 is not on PATH: the project gate is fail-closed, so every tool call would be refused', 400);
  }
  return runs.start({ projectId: project.id, cwd: wt.path, command: `/${name}${args ? ` ${args}` : ''}`, permissionMode: body.permissionMode });
}

module.exports = { listCommands, startRun, startDev, stopJob, createWorktree, removeWorktree, devInfo, isolationScripts, resolveWorktree, OpError, FEATURE_ID };
