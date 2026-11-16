'use strict';
// cohorte — the machine-wide install: commands, fixed agents, workflows and the generic core.
//
//   <globalDir> = ~/.claude (or $CLAUDE_CONFIG_DIR)
//     commands/cohorte-*.md          the 16 slash commands
//     agents/cohorte-*.md            cohorte-review, cohorte-release, cohorte-profile-reader
//     workflows/cohorte-*.js         review / audit / refactor / loop
//     cohorte/                       the generic core: pipeline/, templates/, hooks/gate.py, lib/project.js
//     cohorte/manifest.json          every file above, with the hash it was written with
//     cohorte.config.yaml            YOUR config (seeded once, never in the manifest)
//
// Ownership rules, each one a bug that shipped in 2.x:
//   - nothing outside the manifest is ever deleted (2.x rm'd any ~/.claude/commands/review.md);
//   - a file we would overwrite that the user changed is backed up first;
//   - no hook is registered machine-wide — the gate lives in each project (lib/project.js);
//   - a settings.json that does not parse aborts the run instead of being reset.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const R = require('./render.js');
const { readJsonObject, ProjectError } = require('./project.js');

const pkgRoot = path.join(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
const MANIFEST = path.join('cohorte', 'manifest.json');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const readMaybe = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const toPosix = (p) => p.split(path.sep).join('/');

function walk(dir) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
    const p = path.join(dir, e.name);
    out = e.isDirectory() ? out.concat(walk(p)) : out.concat([p]);
  }
  return out;
}

function pruneEmpty(dir, stopAt) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) pruneEmpty(path.join(dir, e.name), stopAt);
  if (dir === stopAt) return;
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* not empty */ }
}

// --- what this version installs ------------------------------------------------
// rel path (under globalDir) → { content: Buffer|string, mode? }
function desiredFiles(globalDir) {
  const L = R.layout(globalDir);
  const files = new Map();
  const put = (rel, content, mode) => files.set(toPosix(rel), { content, mode });
  const core = path.join(pkgRoot, 'core');

  for (const f of fs.readdirSync(path.join(core, 'commands')).sort()) {
    if (!f.endsWith('.md')) continue;
    put(path.join('commands', f), R.renderCommand(fs.readFileSync(path.join(core, 'commands', f), 'utf8'), L));
  }
  for (const f of fs.readdirSync(path.join(core, 'agents')).sort()) {
    if (!f.endsWith('.md')) continue;
    const src = fs.readFileSync(path.join(core, 'agents', f), 'utf8');
    // The implementer is rendered per SURFACE later, by /cohorte-init-pipeline, into the
    // project's .claude/agents. Ship its rendered template, never an agent named after it.
    if (f.endsWith('.template.md')) put(path.join('cohorte', 'pipeline', f), R.renderAgent(src, L));
    else put(path.join('agents', f), R.renderAgent(src, L));
  }
  for (const f of fs.readdirSync(path.join(core, 'workflows')).sort()) {
    if (f.endsWith('.js')) put(path.join('workflows', `cohorte-${f}`), fs.readFileSync(path.join(core, 'workflows', f)));
  }
  put(path.join('cohorte', 'hooks', 'gate.py'), fs.readFileSync(path.join(core, 'hooks', 'gate.py')), 0o755);
  for (const f of walk(path.join(core, 'templates'))) {
    put(path.join('cohorte', 'templates', path.relative(path.join(core, 'templates'), f)), fs.readFileSync(f));
  }
  for (const f of ['PIPELINE.template.md', 'SCHEMA.md', 'cohorte.config.template.yaml']) {
    put(path.join('cohorte', 'pipeline', f), fs.readFileSync(path.join(pkgRoot, 'profile', f)));
  }
  // A `<x>.sh` with an `<x>.sh.template` sibling is rendered per project by
  // /cohorte-init-pipeline, so only the template ships; every other `.sh` is executable.
  const scripts = fs.readdirSync(path.join(pkgRoot, 'scripts'));
  for (const f of scripts.sort()) {
    const isTemplate = f.endsWith('.sh.template');
    const isShipped = f.endsWith('.sh') && !scripts.includes(`${f}.template`);
    if (!isTemplate && !isShipped) continue;
    put(path.join('cohorte', 'pipeline', 'scripts', f), fs.readFileSync(path.join(pkgRoot, 'scripts', f)),
      isShipped ? 0o755 : undefined);
  }
  put(path.join('cohorte', 'pipeline', 'CHANGELOG.md'), fs.readFileSync(path.join(pkgRoot, 'CHANGELOG.md')));
  put(path.join('cohorte', 'pipeline', 'VERSION'), VERSION + '\n');
  put(path.join('cohorte', 'lib', 'project.js'), fs.readFileSync(path.join(pkgRoot, 'lib', 'project.js')));
  return files;
}

function readManifest(globalDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(globalDir, MANIFEST), 'utf8'));
    return m && typeof m.files === 'object' ? m : { files: {} };
  } catch { return { files: {} }; }
}

// --- 2.x global installs ------------------------------------------------------------
// 2.x wrote its core straight into ~/.claude (pipeline/, templates/, workflows/review.js,
// hooks/gate.py, agents/review.md …) and registered `python3 "~/.claude/hooks/gate.py"` in
// the GLOBAL settings.json. That registration must go BEFORE its file moves: a registered
// hook whose script is missing makes python exit 2, which Claude Code reads as "block" —
// every Bash call in every session on the machine would be refused.
function legacyGateCommandMatches(cmd, globalDir) {
  if (typeof cmd !== 'string') return false;
  const norm = (s) => s.replace(/\\/g, '/');
  const target = norm(path.join(globalDir, 'hooks', 'gate.py'));
  const home = norm(os.homedir());
  const c = norm(cmd).replace(/\$HOME|\$\{HOME\}|~(?=\/)/g, home);
  return c.includes(target);
}

function removeLegacyGlobalHook(globalDir, report) {
  const settingsPath = path.join(globalDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;
  const data = readJsonObject(settingsPath); // throws on invalid JSON — nothing written yet
  const pre = data.hooks && Array.isArray(data.hooks.PreToolUse) ? data.hooks.PreToolUse : null;
  if (!pre) return;
  let removed = 0;
  const kept = [];
  for (const g of pre) {
    if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
    const hooks = g.hooks.filter((h) => !(h && legacyGateCommandMatches(h.command, globalDir)));
    removed += g.hooks.length - hooks.length;
    if (hooks.length) kept.push(hooks.length === g.hooks.length ? g : { ...g, hooks });
  }
  if (!removed) return;
  if (kept.length) data.hooks.PreToolUse = kept; else delete data.hooks.PreToolUse;
  if (data.hooks && !Object.keys(data.hooks).length) delete data.hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n');
  report.push(`removed the 2.x machine-wide gate hook from ${R.displayPath(settingsPath)} (the gate now lives in each project)`);
  // That hook was the ONLY gate of every 2.x global-mode project: until `cohorte sync` runs in
  // each one, they are ungated. Say so, and name the ones Claude Code knows about.
  const projects = knownCohorteProjects(globalDir);
  report.push('! 2.x projects have NO gate until you wire them: run /cohorte-update-pipeline (or `cohorte sync <path>`) in each'
    + (projects.length ? `:\n${projects.map((p) => `      cohorte sync ${JSON.stringify(p)}`).join('\n')}` : '.'));
}

// Projects Claude Code has opened (~/.claude.json `projects`) that carry a cohorte pointer or
// gate config but no 3.x project gate yet.
function knownCohorteProjects(globalDir) {
  const out = [];
  for (const f of [path.join(os.homedir(), '.claude.json'), path.join(globalDir, '.claude.json')]) {
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const p of Object.keys((data && data.projects) || {})) {
      if (out.includes(p)) continue;
      const c = path.join(p, '.claude');
      if ((fs.existsSync(path.join(c, 'pipeline.json')) || fs.existsSync(path.join(c, 'gate-config.json')))
          && !fs.existsSync(path.join(c, 'hooks', 'cohorte-gate.py'))) out.push(p);
    }
  }
  return out.sort();
}

const LEGACY_TEMPLATES = [
  'agent-handoff.md', 'brainstorm-return.md', 'decisions.template.md', 'design-brief.md',
  'patch.template.md', 'pr-body.md', 'review-feedback.md', 'spec.template.md',
  'research-brief.md', 'questionnaire-blueprint.md', 'questionnaire-declaration.md',
  'questionnaire-verdict.md', 'questionnaire-domain-brief.md',
];
const LEGACY_BARE_COMMANDS = ['align-ds', 'audit', 'brainstorm', 'build', 'doctor', 'drive', 'fix',
  'init-pipeline', 'refactor', 'review', 'ship', 'spec', 'update-pipeline', 'cycle', 'loop', 'smoke',
  'research', 'questionnaire'];
const MARKERS = ['Generated by the cohorte adapter', 'Generated by the cohorte installer'];

const text = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const looksCohorte = (p) => { const t = text(p); return t != null && (MARKERS.some((m) => t.includes(m)) || /PIPELINE\.md/.test(t)); };

// What a 2.x (or 1.x) global install left in ~/.claude that is PROVABLY ours: a
// `pipeline/VERSION`-stamped core, files carrying our marker, or 1.x command names whose
// body is pipeline doctrine. A user's own `review.md` that never mentions PIPELINE.md is
// not touched. Surface agents a 2.x global init rendered here are NOT moved — live
// projects still dispatch them; they are reported instead.
function legacyGlobalCandidates(globalDir) {
  const out = [];
  const add = (rel) => { if (fs.existsSync(path.join(globalDir, rel))) out.push(rel); };
  const hasCore = fs.existsSync(path.join(globalDir, 'pipeline', 'VERSION'));
  if (hasCore) for (const f of walk(path.join(globalDir, 'pipeline'))) out.push(path.relative(globalDir, f));
  const gate = path.join(globalDir, 'hooks', 'gate.py');
  if (fs.existsSync(gate) && (hasCore || /gate-config\.json/.test(text(gate) || ''))) add(path.join('hooks', 'gate.py'));
  for (const n of ['tdd_gate.py']) if (hasCore) add(path.join('hooks', n));
  if (hasCore) {
    for (const t of LEGACY_TEMPLATES) add(path.join('templates', t));
    for (const d of ['init-pipeline', 'research', 'questionnaire']) {
      for (const f of walk(path.join(globalDir, 'templates', 'steps', d))) out.push(path.relative(globalDir, f));
    }
  }
  for (const n of ['review', 'audit', 'refactor', 'loop', 'cycle']) {
    const rel = path.join('workflows', `${n}.js`);
    const t = text(path.join(globalDir, rel));
    if (t && (/name:\s*'cohorte-/.test(t) || (hasCore && n === 'cycle'))) out.push(rel);
  }
  for (const n of ['review', 'release', 'profile-reader', 'smoke', 'questionnaire-researcher',
    'research-agent', 'questionnaire-architect', 'questionnaire-writer', 'questionnaire-validator']) {
    const rel = path.join('agents', `${n}.md`);
    if (looksCohorte(path.join(globalDir, rel))) out.push(rel);
  }
  for (const n of LEGACY_BARE_COMMANDS) {
    const rel = path.join('commands', `${n}.md`);
    if (looksCohorte(path.join(globalDir, rel))) out.push(rel);
  }
  // Retired prefixed commands (e.g. cohorte-loop.md, 2.2.0) carry the marker.
  for (const f of walk(path.join(globalDir, 'commands'))) {
    const rel = path.relative(globalDir, f);
    if (/^cohorte-[\w-]+\.md$/.test(path.basename(f)) && path.dirname(rel) === 'commands') {
      if (!fs.existsSync(path.join(pkgRoot, 'core', 'commands', path.basename(f))) && looksCohorte(f)) out.push(rel);
    }
  }
  return [...new Set(out.map(toPosix))];
}

function legacySurfaceAgents(globalDir) {
  const out = [];
  for (const f of walk(path.join(globalDir, 'agents'))) {
    const t = text(f) || '';
    if (/Dispatched by \/cohorte-build/.test(t) && MARKERS.some((m) => t.includes(m))) out.push(path.basename(f));
  }
  return out;
}

function migrateLegacy(globalDir, report) {
  const candidates = legacyGlobalCandidates(globalDir);
  const settingsPath = path.join(globalDir, 'settings.json');
  const hookPresent = fs.existsSync(settingsPath) && (text(settingsPath) || '').includes('gate.py');
  if (!candidates.length && !hookPresent) return;
  removeLegacyGlobalHook(globalDir, report);
  if (!candidates.length) return;
  const backup = path.join(globalDir, 'cohorte', 'legacy-backup', stamp());
  for (const rel of candidates) {
    const from = path.join(globalDir, rel);
    const to = path.join(backup, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
  for (const d of ['pipeline', 'templates', 'workflows', 'hooks']) pruneEmpty(path.join(globalDir, d));
  report.push(`moved ${candidates.length} file(s) of the 2.x core out of ${R.displayPath(globalDir)} → ${R.displayPath(backup)}`);
  const surface = legacySurfaceAgents(globalDir);
  if (surface.length) {
    report.push(`left in place: 2.x surface agents in ${R.displayPath(path.join(globalDir, 'agents'))} (${surface.join(', ')}). ` +
      'They belong in each project now: run /cohorte-update-pipeline in every project that uses them, then delete these.');
  }
}

// --- config ---------------------------------------------------------------------------
async function seedConfig(globalDir, { ask } = {}, report) {
  const cfg = path.join(globalDir, 'cohorte.config.yaml');
  if (fs.existsSync(cfg)) return;
  const legacy = path.join(globalDir, 'thebidouille.config.yaml');
  if (fs.existsSync(legacy)) { report.push(`kept legacy ${R.displayPath(legacy)} (still read as a fallback)`); return; }
  let t = fs.readFileSync(path.join(pkgRoot, 'profile', 'cohorte.config.template.yaml'), 'utf8');
  if (ask) {
    const vault = await ask('    · absolute path to your shared Obsidian vault for the kanban mirror (Enter to skip): ');
    if (vault) {
      t = t.split('\n').map((line) => {
        const i = line.indexOf('# cfg:vault_path');
        if (i === -1) return line;
        const m = line.slice(0, i).match(/^(\s*[\w.]+:\s*)/);
        return m ? `${m[1]}"${vault}"  ${line.slice(i)}` : line;
      }).join('\n');
    }
  }
  fs.mkdirSync(globalDir, { recursive: true });
  fs.writeFileSync(cfg, t);
  report.push(`seeded ${R.displayPath(cfg)}`);
}

// --- install / update ----------------------------------------------------------------
async function install(globalDir, opts = {}) {
  const report = [];
  const warnings = [];
  // Refuse before touching anything if the settings file we may have to edit is broken.
  const settingsPath = path.join(globalDir, 'settings.json');
  if (fs.existsSync(settingsPath)) readJsonObject(settingsPath);

  migrateLegacy(globalDir, report);

  const old = readManifest(globalDir);
  const want = desiredFiles(globalDir);
  const backupDir = path.join(globalDir, 'cohorte', 'backup', stamp());
  const manifest = { version: VERSION, files: {} };
  let written = 0;

  for (const [rel, { content, mode }] of want) {
    const dest = path.join(globalDir, rel);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const cur = readMaybe(dest);
    const newHash = sha(buf);
    if (cur && sha(cur) !== newHash) {
      const known = old.files[rel];
      // A 2.x install has no manifest, but every file it rendered carries our marker.
      const ours2x = !known && MARKERS.some((m) => cur.toString('utf8').includes(m));
      // Modified since we wrote it, or a file we never wrote that sits on our name.
      if (!ours2x && (!known || known !== sha(cur))) {
        const to = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(dest, to);
        warnings.push(`${rel} differed from what cohorte installed — your copy is saved in ${R.displayPath(to)}`);
      }
    }
    if (!cur || sha(cur) !== newHash) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      written++;
    }
    if (mode && process.platform !== 'win32') { try { fs.chmodSync(dest, mode); } catch { /* optional */ } }
    manifest.files[rel] = newHash;
  }

  // Files the previous version installed and this one does not: delete them when they are
  // exactly as we wrote them, keep (and say so) when the user changed them.
  let removed = 0;
  for (const [rel, hash] of Object.entries(old.files)) {
    if (want.has(rel)) continue;
    const dest = path.join(globalDir, rel);
    const cur = readMaybe(dest);
    if (!cur) continue;
    if (sha(cur) === hash) { fs.rmSync(dest); removed++; }
    else warnings.push(`kept ${rel}: no longer shipped, but you modified it`);
  }
  for (const d of ['cohorte', 'workflows']) pruneEmpty(path.join(globalDir, d), path.join(globalDir, d));

  fs.mkdirSync(path.join(globalDir, 'cohorte'), { recursive: true });
  fs.writeFileSync(path.join(globalDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  await seedConfig(globalDir, opts, report);

  report.unshift(`${old.version ? `updated ${old.version} → ${VERSION}` : `installed ${VERSION}`}: `
    + `${want.size} files (${written} written${removed ? `, ${removed} retired file(s) removed` : ''})`);
  return { report, warnings, version: VERSION, previous: old.version || null };
}

// --- uninstall ----------------------------------------------------------------------------
function uninstall(globalDir, { purge = false } = {}) {
  const report = [];
  const warnings = [];
  const settingsPath = path.join(globalDir, 'settings.json');
  if (fs.existsSync(settingsPath)) readJsonObject(settingsPath);
  removeLegacyGlobalHook(globalDir, report);

  const m = readManifest(globalDir);
  let removed = 0;
  for (const [rel, hash] of Object.entries(m.files)) {
    const dest = path.join(globalDir, rel);
    const cur = readMaybe(dest);
    if (!cur) continue;
    if (sha(cur) === hash) { fs.rmSync(dest); removed++; }
    else warnings.push(`kept ${rel}: you modified it`);
  }
  fs.rmSync(path.join(globalDir, MANIFEST), { force: true });
  pruneEmpty(path.join(globalDir, 'cohorte'));
  pruneEmpty(path.join(globalDir, 'workflows'));
  if (removed) report.push(`removed ${removed} installed file(s)`);
  const leftovers = legacyGlobalCandidates(globalDir);
  if (leftovers.length) warnings.push(`2.x files still present (run \`cohorte update\` first to migrate them, then uninstall): ${leftovers.slice(0, 5).join(', ')}${leftovers.length > 5 ? '…' : ''}`);
  if (fs.existsSync(path.join(globalDir, 'cohorte'))) {
    warnings.push(`${R.displayPath(path.join(globalDir, 'cohorte'))} still holds backups or files you changed — review and delete it yourself`);
  }
  const cfg = path.join(globalDir, 'cohorte.config.yaml');
  if (fs.existsSync(cfg)) {
    if (purge) { fs.rmSync(cfg); report.push(`removed ${R.displayPath(cfg)}`); }
    else report.push(`kept your config ${R.displayPath(cfg)} (--purge removes it)`);
  }
  const surface = legacySurfaceAgents(globalDir);
  if (surface.length) warnings.push(`2.x surface agents remain in ${R.displayPath(path.join(globalDir, 'agents'))}: ${surface.join(', ')}`);
  return { report, warnings };
}

module.exports = { install, uninstall, desiredFiles, legacyGlobalCandidates, VERSION, ProjectError };
