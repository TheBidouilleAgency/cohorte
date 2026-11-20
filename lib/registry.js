'use strict';
// cohorte — the list of projects the dashboard (`cohorte ui`) manages.
//
//   <globalDir>/cohorte.projects.json   { "version": 1, "projects": [{ "root": "/abs/path", "addedAt": "ISO" }] }
//
// A separate file on purpose: cohorte.config.yaml is the user's own, hand-edited file. The registry
// stores real paths only — the id a client sees is a hash of the path, so the HTTP layer never
// accepts a filesystem path for a read, only the id of a project that was registered.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FILE = 'cohorte.projects.json';

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const idOf = (root) => crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isCohorteProject = (root) =>
  fs.existsSync(path.join(root, 'PIPELINE.md')) || fs.existsSync(path.join(root, '.claude', 'pipeline.json'));

function gitTop(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? realOr(r.stdout.trim()) : null;
}

class RegistryError extends Error {}

function file(globalDir) { return path.join(globalDir, FILE); }

function load(globalDir) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file(globalDir), 'utf8')); } catch { return []; }
  const list = Array.isArray(data && data.projects) ? data.projects : [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || typeof p.root !== 'string' || !path.isAbsolute(p.root) || seen.has(p.root)) continue;
    seen.add(p.root);
    out.push({ id: idOf(p.root), root: p.root, addedAt: typeof p.addedAt === 'string' ? p.addedAt : null });
  }
  return out;
}

function save(globalDir, projects) {
  fs.mkdirSync(globalDir, { recursive: true });
  const body = { version: 1, projects: projects.map((p) => ({ root: p.root, addedAt: p.addedAt })) };
  const tmp = `${file(globalDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, file(globalDir));
}

// Registers a project by path. The path may be any folder inside the repo: the git root is stored,
// so two entries for one repo cannot exist. A missing folder or a repo without cohorte is refused —
// unless `founding`: cohorte ui registers a project it is founding (New project) before its PIPELINE.md exists.
function add(globalDir, input, { founding = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new RegistryError('a project path is required');
  const expanded = input.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!path.isAbsolute(expanded)) throw new RegistryError('the path must be absolute');
  if (!isDir(expanded)) throw new RegistryError(`${expanded} is not a folder`);
  const root = gitTop(expanded) || realOr(expanded);
  if (!founding && !isCohorteProject(root)) {
    throw new RegistryError(`${root} has no PIPELINE.md or .claude/pipeline.json — run /cohorte-init-pipeline in it first`);
  }
  const list = load(globalDir);
  const existing = list.find((p) => p.root === root);
  if (existing) return { project: existing, created: false };
  const project = { id: idOf(root), root, addedAt: new Date().toISOString() };
  save(globalDir, list.concat([project]));
  return { project, created: true };
}

function remove(globalDir, id) {
  const list = load(globalDir);
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  save(globalDir, next);
  return true;
}

function get(globalDir, id) { return load(globalDir).find((p) => p.id === id) || null; }

// Folders Claude Code has been used in (the `projects` keys of its user store) that look like a cohorte
// project and are not registered yet. Suggestions only: nothing is added without a click.
function discover(globalDir, storePath) {
  const store = storePath
    || (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'));
  let projects = {};
  try { projects = JSON.parse(fs.readFileSync(store, 'utf8')).projects || {}; } catch { return []; }
  const known = new Set(load(globalDir).map((p) => p.root));
  const out = [];
  for (const key of Object.keys(projects)) {
    if (!path.isAbsolute(key) || !isDir(key)) continue;
    const root = realOr(key);
    if (known.has(root) || out.some((o) => o.root === root)) continue;
    if (isCohorteProject(root)) out.push({ root, name: path.basename(root) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Worktrees of one repo, from git itself. The main checkout comes first.
function worktrees(root) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, head: null, bare: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
  }
  return out;
}

module.exports = { load, add, remove, get, discover, worktrees, idOf, isCohorteProject, RegistryError, FILE };
