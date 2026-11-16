'use strict';
// Programmatic port of the /cohorte-doctor checks (core/commands/cohorte-doctor.md), so
// `cohorte doctor` can report without a coding agent in the loop.
// Read-only: inspects files only. Checks that need a live process (MCP connectivity,
// git worktree state, DesignSync) are reported as `skip` with a note — the node server
// can't run them, and honest "not checked here" beats a false green.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseProfileBlock } = require('./yaml');
const { versions } = require('./versions');

// Shipped (non-surface) agent names. 3.x installs them machine-wide; a 2.x bundled repo has
// the bare names in its .claude/agents. Never reported as stray surface agents.
const FIXED_AGENTS = new Set([
  'cohorte-review', 'cohorte-release', 'cohorte-profile-reader',
  'review', 'release', 'profile-reader', 'smoke', 'implementer.template',
]);
const WORKFLOWS = ['cohorte-review.js', 'cohorte-audit.js', 'cohorte-refactor.js', 'cohorte-loop.js'];
const GATE_FILE = path.join('.claude', 'hooks', 'cohorte-gate.py');

// The spec lifecycle (SCHEMA.md §Spec status). `in-progress` and `blocked` stay valid after
// /cohorte-loop was retired in 2.2.0: specs in existing repos carry them, and an external driver
// still needs somewhere to record "a round is under way" / "a round gave up".
const VALID_STATUS = ['draft', 'frozen', 'in-progress', 'in-review', 'shipped', 'blocked'];

// Artifacts the pipeline itself writes into specs/ that are NOT feature specs and have no
// front-matter status. `/cohorte-audit` writes specs/refactor-backlog.md by design, so scanning it
// as a spec made /cohorte-doctor warn about a file cohorte had just created — a false positive that
// fired in every project that had ever run /cohorte-audit. `_`-prefixed files (e.g. _template.md)
// are already skipped by the reader below.
const NON_SPEC_FILES = new Set(['refactor-backlog.md']);

const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const isTrue = v => v === true;
const sameSet = (a, b) => {
  const A = new Set(a || []), B = new Set(b || []);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
};

// Paths are reported to a human looking at a repo: show them relative to it.
const rel = (projectRoot) => (p) => {
  const r = path.relative(projectRoot, p);
  return r && !r.startsWith('..') ? r : p;
};

function mk(id, label, status, detail, fix) {
  return fix ? { id, label, status, detail, fix } : { id, label, status, detail };
}

// --- individual checks -------------------------------------------------------

function checkCore(v, isProject) {
  if (v.installMode === 'none') {
    if (v.legacy.global.present) {
      return mk('core', 'Core & pointer', 'bad',
        `a 2.x core (${v.legacy.global.version}) is installed the old way, straight in ~/.claude`,
        'npm i -g cohorte@latest && cohorte update   (migrates it into ~/.claude/cohorte)');
    }
    return mk('core', 'Core & pointer', 'bad', 'cohorte is not installed on this machine',
      'npm i -g cohorte && cohorte install');
  }
  const notes = [];
  if (v.legacy.global.present) notes.push('2.x files still in ~/.claude (run `cohorte update` to migrate them)');
  if (isProject && v.legacy.bundled.present) notes.push(`2.x vendored core in .claude/ (${v.legacy.bundled.version})`);
  if (isProject && v.pointer.present && v.pointer.mode) notes.push(`2.x pointer (mode: ${v.pointer.mode})`);
  if (notes.length) {
    return mk('core', 'Core & pointer', 'warn', notes.join(' · '),
      v.legacy.global.present && !(isProject && (v.legacy.bundled.present || v.pointer.mode))
        ? 'cohorte update'
        : '/cohorte-update-pipeline   (or  cohorte sync  — migrates this repo to the 3.x layout)');
  }
  if (isProject && v.pointer.present && v.pointer.core_version && v.pointer.core_version !== v.installedVersion) {
    return mk('core', 'Core & pointer', 'warn',
      `pointer says core ${v.pointer.core_version} but the installed core is ${v.installedVersion}`,
      'cohorte sync   (bumps .claude/pipeline.json — commit it)');
  }
  if (v.freshness === -1) {
    return mk('core', 'Core & pointer', 'warn',
      `core ${v.installedVersion} installed; npm latest is ${v.latest}`,
      'npm i -g cohorte@latest && cohorte update');
  }
  const tail = v.latest ? `, npm latest ${v.latest}` : '';
  return mk('core', 'Core & pointer', 'ok', `core ${v.installedVersion}${tail}`);
}

function checkProfile(profile, hasPipelineMd) {
  if (!hasPipelineMd) {
    return mk('profile', 'Profile (PIPELINE.md)', 'bad', 'PIPELINE.md not found',
      '/cohorte-init-pipeline   (generate the project profile)');
  }
  if (!profile) {
    return mk('profile', 'Profile (PIPELINE.md)', 'bad',
      'PIPELINE.md present but its `yaml pipeline-profile` block is missing or unparseable',
      '/cohorte-init-pipeline   (or fix the fenced yaml block)');
  }
  const n = (profile.surfaces || []).length;
  return mk('profile', 'Profile (PIPELINE.md)', n ? 'ok' : 'warn',
    `${profile.name || 'unnamed'} · ${n} surface${n === 1 ? '' : 's'}`,
    n ? undefined : 'add at least one surface to §surfaces');
}

function checkAgents(profile, projectRoot, globalDir) {
  if (!profile || !(profile.surfaces || []).length) {
    return mk('agents', 'Surfaces ↔ agents', 'skip', 'no surfaces to reconcile');
  }
  const agentsDir = path.join(projectRoot, '.claude', 'agents');
  const surfaceAgents = profile.surfaces.map(s => s.agent).filter(Boolean);
  const missing = surfaceAgents.filter(a => !exists(path.join(agentsDir, `${a}.md`)));
  let files = [];
  try { files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)); }
  catch { /* dir absent → handled by `missing` */ }
  const orphans = files.filter(f => !FIXED_AGENTS.has(f) && !surfaceAgents.includes(f));
  if (missing.length) {
    // A 2.x "global" repo rendered its surface agents into ~/.claude/agents: they still work
    // on THIS machine, but nobody else gets them and another project can overwrite them.
    const inGlobal = missing.filter(a => exists(path.join(globalDir, 'agents', `${a}.md`)));
    if (inGlobal.length === missing.length) {
      return mk('agents', 'Surfaces ↔ agents', 'warn',
        `surface agent(s) only in ~/.claude/agents (2.x layout): ${missing.join(', ')}`,
        '/cohorte-update-pipeline   (re-renders them into .claude/agents — commit them)');
    }
    return mk('agents', 'Surfaces ↔ agents', 'bad',
      `surface(s) with no rendered agent in .claude/agents: ${missing.join(', ')}`,
      '/cohorte-update-pipeline   (re-renders the surface agents)');
  }
  if (orphans.length) {
    return mk('agents', 'Surfaces ↔ agents', 'warn',
      `agent file(s) with no owning surface: ${orphans.join(', ')}`,
      'remove the stale agent file, or add its surface to PIPELINE.md');
  }
  return mk('agents', 'Surfaces ↔ agents', 'ok',
    `${surfaceAgents.length} surface agent(s) rendered in .claude/agents, no orphans`);
}

function checkGate(profile, projectRoot) {
  const stateDirs = [path.join(projectRoot, '.claude')];
  const gate = profile && profile.gate;
  if (!gate || (!gate.deny && !gate.ask && !gate.ask_on_default_branch && !gate.preflight)) {
    return mk('gate', 'Gate config', 'skip', 'no gate block in the profile');
  }
  const cfgPath = stateDirs.map(d => path.join(d, 'gate-config.json')).find(exists);
  const cfg = cfgPath ? readJson(cfgPath) : null;
  if (!cfg) {
    return mk('gate', 'Gate config', 'bad',
      `gate-config.json missing or unreadable (looked in ${stateDirs.map(rel(projectRoot)).join(', ')})`,
      '/cohorte-init-pipeline   (regenerate gate-config.json from the gate block)');
  }
  const drifted = [];
  if (!sameSet(cfg.deny, gate.deny)) drifted.push('deny');
  if (!sameSet(cfg.ask, gate.ask)) drifted.push('ask');
  if (!sameSet(cfg.ask_on_default_branch, gate.ask_on_default_branch)) drifted.push('ask_on_default_branch');
  if ((cfg.default_branch || 'main') !== (gate.default_branch || 'main')) drifted.push('default_branch');
  // The phase gate (1.3.0) lives in the same file: a profile that enables
  // gate.preflight with a pre-1.3.0 gate-config.json silently never fires it.
  const wantPf = gate.preflight || {};
  const havePf = (cfg.preflight && typeof cfg.preflight === 'object') ? cfg.preflight : {};
  if (!!wantPf.enabled !== !!havePf.enabled
      || !sameSet(wantPf.agents || ['cohorte-review'], havePf.agents || ['cohorte-review'])
      || Number(wantPf.max_age_minutes || 30) !== Number(havePf.max_age_minutes || 30)) {
    drifted.push('preflight');
  }
  if (drifted.length) {
    return mk('gate', 'Gate config', 'warn',
      `gate-config.json drifted from PIPELINE.md gate block (${drifted.join(', ')})`,
      `regenerate ${rel(projectRoot)(cfgPath)} to mirror the gate block`);
  }
  const branchGated = (gate.ask_on_default_branch || []).length;
  return mk('gate', 'Gate config', 'ok',
    `mirrors the profile (${(gate.deny || []).length} deny, ${(gate.ask || []).length} ask` +
    (branchGated ? `, ${branchGated} gated on ${gate.default_branch || 'main'}` : '') + ')');
}

// Local-only pipeline artifacts, under the project's `.claude` state dir. `preflight.ok` is the
// one that BREAKS things when versioned rather than merely being noise: the stamp names the tree
// it verified, committing it moves HEAD past that, and the committed copy then rides into every
// fresh clone and worktree — the phase gate either blocks a clean tree or greens one it never
// checked.
function localArtifacts(stateRels) {
  const out = [];
  for (const d of stateRels) {
    out.push({ path: `${d}/preflight.ok`, stamp: true,
      why: 'the phase-gate stamp — a versioned one breaks the gate in every clone and worktree' });
    out.push({ path: `${d}/pipeline-metrics.jsonl`,
      why: 'the per-dispatch metrics sink (local, append-only)' });
  }
  out.push({ path: 'specs/reports/',
    why: 'the /cohorte-review report buffer (derived, regenerated each run)' });
  return out;
}

// Does any .gitignore in play cover `rel`? Deliberately literal — it recognizes the exact
// path, its basename, a trailing-slash dir prefix and a `*.<ext>` glob, which is every form
// /cohorte-init-pipeline writes. Anything more clever would need a real gitignore engine.
function ignoreCovers(projectRoot, rel) {
  const base = rel.replace(/\/$/, '').split('/').pop();
  const ext = base.includes('.') ? '*' + base.slice(base.lastIndexOf('.')) : null;
  const files = [
    path.join(projectRoot, '.gitignore'),
    path.join(projectRoot, '.claude', '.gitignore'),
  ];
  for (const f of files) {
    const text = readText(f);
    if (!text) continue;
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const p = line.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!p) continue;
      if (p === rel.replace(/\/$/, '') || p === base || p === ext) return true;
      // A directory rule covers everything under it (`.claude/` ignores the stamp too).
      if (rel.startsWith(p + '/')) return true;
    }
  }
  return false;
}

function checkLocalArtifacts(projectRoot, stateRels) {
  const artifacts = localArtifacts(stateRels);
  const unignored = artifacts.filter(a => !ignoreCovers(projectRoot, a.path));
  if (!unignored.length) {
    return mk('artifacts', 'Local artifacts', 'ok',
      `${artifacts.length} local-only artifact path(s) all gitignored`);
  }
  const stamp = unignored.find(a => a.stamp);
  return mk('artifacts', 'Local artifacts', stamp ? 'bad' : 'warn',
    `not gitignored: ${unignored.map(a => a.path).join(', ')} — ${unignored[0].why}`,
    `add ${unignored.map(a => a.path).join(' + ')} to .gitignore`
    + (stamp ? `, then \`git rm --cached --ignore-unmatch ${stamp.path}\`` : ''));
}

// Our hook entries in one settings file: the 3.x project gate, or a 2.x one
// (`.claude/hooks/gate.py` in a repo, `<globalDir>/hooks/gate.py` machine-wide).
function gateEntries(settingsPath, isOurs) {
  const data = readJson(settingsPath);
  const list = data && data.hooks && Array.isArray(data.hooks.PreToolUse) ? data.hooks.PreToolUse : [];
  const out = [];
  for (const g of list) {
    for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
      if (h && isOurs(String(h.command || '').replace(/\\/g, '/'))) out.push({ matcher: String(g.matcher || ''), command: h.command });
    }
  }
  return out;
}

const matches = (matcher, name) => {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(name); } catch { return false; }
};

function isTracked(projectRoot, rel) {
  const r = spawnSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore' });
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

function checkHooks(projectRoot, globalDir) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  if (exists(settingsPath) && readJson(settingsPath) == null) {
    return mk('hooks', 'Gate hook', 'bad', '.claude/settings.json is not valid JSON — Claude Code ignores it, so no gate runs',
      'fix the JSON, then  cohorte sync');
  }
  const ours = gateEntries(settingsPath, c => c.includes('cohorte-gate.py'));
  const legacyProject = gateEntries(settingsPath, c => /(^|["'\s/])\.claude\/hooks\/gate\.py/.test(c) && !c.includes('cohorte-gate.py'));
  const legacyGlobal = gateEntries(path.join(globalDir, 'settings.json'),
    c => c.includes(path.join(globalDir, 'hooks', 'gate.py').replace(/\\/g, '/')) || /~\/\.claude\/hooks\/gate\.py/.test(c));
  const problems = [];
  let status = 'ok';
  const worst = (s) => { if (s === 'bad' || (s === 'warn' && status === 'ok')) status = s; };

  const shell = ours.filter(e => matches(e.matcher, 'Bash'));
  if (!shell.length) {
    worst(legacyProject.length ? 'warn' : 'bad');
    problems.push(legacyProject.length ? '2.x gate registration (.claude/hooks/gate.py)' : 'gate not registered in .claude/settings.json');
  } else {
    if (shell.length > 1) { worst('warn'); problems.push(`registered ${shell.length}× for Bash — it will double-prompt`); }
    if (!shell.some(e => matches(e.matcher, 'Agent'))) {
      worst('bad'); problems.push(`matcher "${shell[0].matcher}" does not cover Agent — the preflight phase gate never fires`);
    }
    if (!ours.some(e => matches(e.matcher, 'Write'))) { worst('warn'); problems.push('no Write|Edit registration — the gate files are not self-protected'); }
    const py = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 3)'], { stdio: 'ignore' });
    if (py.status !== 0) {
      worst('bad'); problems.push(py.status === 3 ? 'python3 is older than 3.9 — the gate cannot run'
        : 'python3 not found — the fail-closed gate refuses every Bash call');
    }
    if (!exists(path.join(projectRoot, GATE_FILE))) {
      worst('bad'); problems.push(`${GATE_FILE} is registered but missing — every Bash call is refused`);
    } else if (isTracked(projectRoot, GATE_FILE) === false) {
      worst('warn'); problems.push(`${GATE_FILE} is not committed — teammates get no gate`);
    }
  }
  if (legacyGlobal.length) { worst('warn'); problems.push('a 2.x gate is still registered in ~/.claude/settings.json (double-prompts)'); }

  if (problems.length) {
    const onlyUncommitted = problems.length === 1 && /not committed/.test(problems[0]);
    const fix = onlyUncommitted
      ? `git add ${GATE_FILE} .claude/settings.json && git commit`
      : legacyGlobal.length && shell.length && problems.length === 1
        ? 'cohorte update   (removes the 2.x machine-wide registration)'
        : 'cohorte sync   (copies and registers the project gate — then commit .claude/)';
    return mk('hooks', 'Gate hook', status, problems.join(' · '), fix);
  }
  return mk('hooks', 'Gate hook', 'ok', `registered once (${shell[0].matcher} + Write|Edit|MultiEdit), committed`);
}

function checkRetrieval(profile, projectRoot) {
  const provider = profile && profile.retrieval && profile.retrieval.provider;
  if (!provider || provider === 'none' || String(provider).startsWith('<')) {
    return mk('retrieval', 'Code retrieval', 'skip', 'provider: none');
  }
  // The profile alone isn't proof the provider was ever wired: /cohorte-init-pipeline
  // registers it at project scope in .mcp.json. Verify the entry exists on disk;
  // live connectivity still needs a session — note it, don't fake green.
  const mcp = readJson(path.join(projectRoot, '.mcp.json'));
  const servers = (mcp && mcp.mcpServers) || {};
  const wired = Object.keys(servers).some(k => k.toLowerCase().includes(String(provider).toLowerCase()));
  if (!wired) {
    return mk('retrieval', 'Code retrieval', 'warn',
      `profile says provider: ${provider} but .mcp.json has no matching server entry`,
      '/cohorte-init-pipeline or /cohorte-update-pipeline   (re-wire the retrieval provider)');
  }
  return mk('retrieval', 'Code retrieval', 'ok',
    `provider: ${provider} — registered in .mcp.json (connectivity needs /cohorte-doctor in-session)`);
}

function checkDesign(profile, projectRoot) {
  const d = profile && profile.design;
  if (!d || !isTrue(d.enabled)) return mk('design', 'Design system', 'skip', 'design.enabled: false');
  const targets = [['snapshot_dir', d.snapshot_dir], ['ui_kit_path', d.ui_kit_path], ['tokens_path', d.tokens_path]];
  const missing = targets.filter(([, p]) => p && !exists(path.join(projectRoot, p))).map(([k]) => k);
  if (missing.length) {
    return mk('design', 'Design system', 'warn', `missing path(s): ${missing.join(', ')}`,
      'create the missing design paths or fix them in PIPELINE.md §design');
  }
  return mk('design', 'Design system', 'ok', `provider: ${d.provider} — DS paths present`);
}

function checkIsolation(profile, projectRoot) {
  const iso = profile && profile.isolation;
  if (!iso || !isTrue(iso.enabled)) return mk('isolation', 'Isolation', 'skip', 'isolation.enabled: false');
  const scripts = ['scripts/new-feature.sh', 'scripts/remove-feature.sh'];
  const problems = [];
  for (const rel of scripts) {
    const txt = readText(path.join(projectRoot, rel));
    if (txt == null) problems.push(`${rel} missing`);
    else if (/__[A-Z_]+__/.test(txt)) problems.push(`${rel} has unrendered __TOKEN__`);
  }
  if (problems.length) {
    return mk('isolation', 'Isolation', 'warn', problems.join('; '),
      '/cohorte-init-pipeline   (re-render the isolation scripts)');
  }
  return mk('isolation', 'Isolation', 'ok', 'feature scripts rendered (worktree state not checked here)');
}

// Workflow variants (review/audit/refactor as deterministic multi-agent runs) are opt-in;
// the conversational commands stay the default path, so nothing here is ever 'bad'.
function checkWorkflows(globalDir, installMode) {
  if (installMode === 'none') return mk('workflows', 'Workflows', 'skip', 'no core installed');
  const dir = path.join(globalDir, 'workflows');
  const missing = WORKFLOWS.filter(s => !exists(path.join(dir, s)));
  if (missing.length) {
    return mk('workflows', 'Workflows', 'warn', `missing script(s) in ~/.claude/workflows: ${missing.join(', ')}`,
      'cohorte update');
  }
  if (!exists(path.join(globalDir, 'agents', 'cohorte-profile-reader.md'))) {
    return mk('workflows', 'Workflows', 'warn',
      'scripts present but the cohorte-profile-reader agent (their phase 0) is missing', 'cohorte update');
  }
  return mk('workflows', 'Workflows', 'ok',
    'scripts + cohorte-profile-reader installed — opt-in per run; needs Claude Code ≥ 2.1.154 with ' +
    'workflows enabled (run /cohorte-doctor in-session to check the live half)');
}

function scanSpecs(projectRoot) {
  const dir = path.join(projectRoot, 'specs');
  const specs = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_') && !NON_SPEC_FILES.has(f)); }
  catch { return specs; }
  for (const f of files) {
    const txt = readText(path.join(dir, f)) || '';
    const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const body = fm ? fm[1] : '';
    const get = k => { const m = body.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')); return m ? m[1].trim() : null; };
    const status = get('status');
    // Legacy resume state from the retired /cohorte-loop driver. Nothing writes it any more;
    // it is still read so a spec left mid-flight by an older core still shows why on the board.
    const pass = parseInt(get('loop_pass'), 10);
    const phase = get('loop_phase');
    specs.push({
      file: f,
      id: get('feature_id') || f.replace(/\.md$/, ''),
      title: get('title'),
      status: status ? status.split('#')[0].trim() : null,
      branch: get('branch'),
      loop: pass > 0 ? { pass, phase: phase && phase !== 'done' ? phase : null } : null,
    });
  }
  return specs;
}

function checkSpecs(specs) {
  if (!specs.length) return mk('specs', 'Specs', 'skip', 'no specs yet');
  const bad = specs.filter(s => !VALID_STATUS.includes(s.status));
  const counts = {};
  for (const s of specs) counts[s.status || '?'] = (counts[s.status || '?'] || 0) + 1;
  const summary = VALID_STATUS.filter(st => counts[st]).map(st => `${counts[st]} ${st}`).join(', ');
  if (bad.length) {
    return mk('specs', 'Specs', 'warn',
      `invalid status in: ${bad.map(s => s.file).join(', ')}`,
      `set status to one of: ${VALID_STATUS.join(' · ')}`);
  }
  return mk('specs', 'Specs', 'ok', `${specs.length} spec(s) — ${summary}`);
}

// --- orchestrator ------------------------------------------------------------

async function state({ projectRoot, globalDir, cliVersion, offline }) {
  const v = await versions({ projectRoot, globalDir, cliVersion, offline });

  const pipelineMd = readText(path.join(projectRoot, 'PIPELINE.md'));
  const profile = pipelineMd ? parseProfileBlock(pipelineMd) : null;
  const specs = scanSpecs(projectRoot);
  const isProject = pipelineMd != null || v.pointer.present;

  const checks = [
    checkCore(v, isProject),
    checkProfile(profile, pipelineMd != null),
    checkAgents(profile, projectRoot, globalDir),
    checkGate(profile, projectRoot),
    checkLocalArtifacts(projectRoot, ['.claude']),
    isProject ? checkHooks(projectRoot, globalDir)
      : mk('hooks', 'Gate hook', 'skip', 'not a cohorte project yet (no PIPELINE.md / .claude/pipeline.json)'),
    checkRetrieval(profile, projectRoot),
    checkDesign(profile, projectRoot),
    checkIsolation(profile, projectRoot),
    checkWorkflows(globalDir, v.installMode),
    checkSpecs(specs),
  ];

  const summary = { ok: 0, warn: 0, bad: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;

  return {
    project: projectRoot,
    runtimes: v.installMode === 'none' ? [] : [{ id: 'claude', label: 'Claude Code', scope: 'global',
      capabilities: { subagents: true, hooks: true, workflows: true }, legacy: false }],
    versions: v,
    profile: profile ? {
      name: profile.name,
      one_liner: profile.one_liner,
      surfaces: (profile.surfaces || []).map(s => ({
        key: s.key, label: s.label, agent: s.agent, path: s.path,
        model: s.model, uses_design: s.uses_design, tools: s.tools,
      })),
    } : null,
    specs,
    checks,
    summary,
  };
}

module.exports = { state, scanSpecs };
