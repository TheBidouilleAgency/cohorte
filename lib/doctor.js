'use strict';
// Programmatic port of the /cohorte-doctor checks (core/commands/cohorte-doctor.md), so
// `cohorte doctor` can report without a coding agent in the loop.
// Read-only: inspects files only. Checks that need a live process (MCP connectivity,
// git worktree state, DesignSync) are reported as `skip` with a note — the node server
// can't run them, and honest "not checked here" beats a false green.

const fs = require('fs');
const path = require('path');
const { layouts, stateDirs } = require('./runtime.js');
const { parseProfileBlock } = require('./yaml');
const { versions } = require('./versions');

// Rendered surface agents live alongside these fixed (non-surface) agents; exclude them
// from the orphan check so they're never mistaken for a stray surface agent.
const FIXED_AGENTS = new Set([
  'review', 'release', 'profile-reader',
  // retired (1.5.0) — still excluded so a stale install's leftover file isn't
  // reported as a stray surface agent.
  'smoke',
  'implementer.template',
]);

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

function acrossRuntimes(all, check) {
  const distinct = all.filter((l, i) => all.findIndex(other => other.id === l.id) === i);
  const results = (distinct.length ? distinct : [null]).map(check);
  if (results.length === 1) return results[0];
  const rank = { skip: 0, ok: 1, warn: 2, bad: 3 };
  const worst = results.reduce((a, b) => rank[b.status] > rank[a.status] ? b : a);
  return { ...worst, detail: results.map((r, i) => `${distinct[i].label}: ${r.detail}`).join(' · ') };
}

// --- individual checks -------------------------------------------------------

function checkCore(v) {
  if (v.installMode === 'none') {
    return mk('core', 'Core & pointer', 'bad', 'no pipeline core installed for this project',
      'cohorte install   (or --global)');
  }
  if (v.pointer.present && v.pointer.core_version && v.installedVersion &&
      v.pointer.core_version !== v.installedVersion) {
    return mk('core', 'Core & pointer', 'warn',
      `pointer says core ${v.pointer.core_version} but installed core is ${v.installedVersion}`,
      'cohorte update   (reconcile the pointer)');
  }
  if (v.freshness === -1) {
    return mk('core', 'Core & pointer', 'warn',
      `core ${v.installedVersion} installed (${v.installMode}); npm latest is ${v.latest}`,
      '/cohorte-update-pipeline   (or  cohorte update)');
  }
  const tail = v.latest ? `, npm latest ${v.latest}` : ', npm unreachable';
  return mk('core', 'Core & pointer', 'ok', `core ${v.installedVersion} (${v.installMode})${tail}`);
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

function checkAgents(profile, projectRoot, layout) {
  if (!profile || !(profile.surfaces || []).length) {
    return mk('agents', 'Surfaces ↔ agents', 'skip', 'no surfaces to reconcile');
  }
  if (!layout) {
    return mk('agents', 'Surfaces ↔ agents', 'skip', 'no core installed — nothing renders agents yet');
  }
  const agentsDir = layout.surfaceAgents || layout.agents;
  const ext = layout.agentExt || (layout.id === 'codex' ? '.toml' : '.md');
  const surfaceAgents = profile.surfaces.map(s => s.agent).filter(Boolean);

  const missing = surfaceAgents.filter(a => !exists(path.join(agentsDir, `${a}${ext}`)));

  let files = [];
  try { files = fs.readdirSync(agentsDir).filter(f => f.endsWith(ext)).map(f => f.slice(0, -ext.length)); }
  catch { /* dir absent → handled by `missing` */ }
  // Orphan detection only makes sense against a PROJECT agents dir. A global install's
  // agents dir (~/.claude/agents) is the user's shared Claude Code space — their personal
  // agents and other cohorte projects' surface agents live there legitimately, and
  // flagging them sent humans deleting files that were not this project's to judge.
  const orphans = layout.scope === 'global' && layout.id !== 'codex'
    ? []
    : files.filter(f => !FIXED_AGENTS.has(f) && !surfaceAgents.includes(f));

  if (missing.length) {
    return mk('agents', 'Surfaces ↔ agents', 'bad',
      `surface(s) with no rendered agent: ${missing.join(', ')}`,
      '/cohorte-init-pipeline   (re-render surface agents)');
  }
  if (orphans.length) {
    return mk('agents', 'Surfaces ↔ agents', 'warn',
      `agent file(s) with no owning surface: ${orphans.join(', ')}`,
      'remove the stale agent file, or add its surface to PIPELINE.md');
  }
  return mk('agents', 'Surfaces ↔ agents', 'ok',
    `${surfaceAgents.length} surface agent(s) all rendered, no orphans (${layout.label})`);
}

function checkGate(profile, projectRoot, stateDirs) {
  const gate = profile && profile.gate;
  if (!gate || (!gate.deny && !gate.ask && !gate.ask_on_default_branch && !gate.preflight)) {
    return mk('gate', 'Gate config', 'skip', 'no gate block in the profile');
  }
  // One gate config per PROJECT, wherever the installed runtime keeps it. A repo driven from
  // two agents shares it deliberately — they must not disagree about what is gated.
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
      || !sameSet(wantPf.agents || ['review'], havePf.agents || ['review'])
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

// Local-only pipeline artifacts, named relative to whichever `<state>` dir the installed
// runtime uses (`.claude` on a Claude install, `.cohorte` on the others). `preflight.ok` is the
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

// Gate registrations in one config file. Three shapes across the runtimes that host the hook:
// Claude Code and Codex use the matcher-group form under `PreToolUse`, Gemini the same shape
// under `BeforeTool`, Cursor a flat `[{command}]` under `beforeShellExecution`. A registration
// read with the wrong shape looks absent, which is how a healthy install gets reported broken.
function gateRegs(settingsPath, event) {
  const data = readJson(settingsPath);
  const list = data && data.hooks && Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
  // Trailing-quote tolerant, like the installers since 1.3.2: the Windows form is
  // `py "C:\…\gate.py"` — a bare .endsWith() reports every healthy Windows install
  // as "not registered".
  // Strip the trailing `--runtime <id>` BEFORE the quotes: the registered command is
  // `python3 "/path/gate.py" --runtime cursor`, so taking the quotes off first leaves
  // `…gate.py"` and the match fails — a healthy registration read as missing.
  const isOurs = (c) => typeof c === 'string'
    && c.trim().replace(/\s+--runtime[= ]\S+$/, '').replace(/"+$/, '').endsWith('gate.py');
  return list.filter(e => isOurs(e && e.command)
    || ((e && e.hooks) || []).some(h => isOurs(h && h.command)));
}

function checkHooks(projectRoot, globalDir, installMode, all) {
  // A registration can exist without a discoverable core — a repo whose core lives in a global
  // dir the caller was not pointed at, or one predating `runtimes.json`. Falling through to
  // "no runtime installed" there would hide a real double-registration, so assume the Claude
  // layout: before the adapter it was the only one, and it is the only one whose hook can be
  // registered outside its own core dir.
  const known = all.length ? all : [{
    id: 'claude', label: 'Claude Code', scope: installMode === 'bundled' ? 'project' : 'global',
    core: path.join(projectRoot, '.claude'),
    hooksConfig: path.join(projectRoot, '.claude', 'settings.json'),
    capabilities: { subagents: true, hooks: true, workflows: true },
  }];
  const hosts = known.filter(l => l.capabilities && l.capabilities.hooks && l.hooksConfig);
  const advisory = known.filter(l => !(l.capabilities && l.capabilities.hooks));

  if (!hosts.length) {
    if (advisory.length) {
      // OpenCode extends via plugins, not a blocking hook. The gate still runs — the rendered
      // commands call `gate.py --check` — but it is advisory, and saying ✅ here would claim an
      // enforcement property that genuinely is not there.
      return mk('hooks', 'Gate hook', 'warn',
        `${advisory.map(l => l.label).join(', ')} has no blocking hook — the gate runs as an explicit --check the agent must call`,
        'nothing to fix; run /cohorte-doctor inside that runtime for the full picture');
    }
    return mk('hooks', 'Gate hook', 'warn', 'no runtime installed to register the gate hook against',
      'cohorte install   (or --global)');
  }

  const problems = [];
  const okLines = [];
  for (const l of hosts.filter((h, i) => hosts.findIndex(other => other.id === h.id) === i)) {
    const event = (l.id === 'cursor') ? 'beforeShellExecution'
      : (l.id === 'gemini') ? 'BeforeTool' : 'PreToolUse';
    // A Claude registration serves the project from EITHER scope: bundled repos get it from
    // /cohorte-init-pipeline in project settings, but on a machine with the global core it
    // usually lives (correctly, exactly once) in global settings — warning there would
    // prescribe a re-registration that double-prompts.
    const paths = l.id === 'claude'
      ? (installMode === 'global'
        ? [path.join(globalDir, 'settings.json'), path.join(projectRoot, '.claude', 'settings.json')]
        : [path.join(projectRoot, '.claude', 'settings.json'), path.join(globalDir, 'settings.json')])
      : l.id === 'codex'
        ? [...new Set([...hosts.filter(h => h.id === 'codex').map(h => h.hooksConfig),
          path.join(projectRoot, '.codex', 'hooks.json')])]
        : [l.hooksConfig];
    const found = paths.map(p2 => ({ path: p2, regs: gateRegs(p2, event) })).filter(f => f.regs.length);
    if (!found.length) {
      problems.push(`${l.label}: not registered (${event})`);
      continue;
    }
    const total = found.reduce((n, f) => n + f.regs.length, 0);
    if (total > 1) {
      problems.push(`${l.label}: registered ${total}× — it will double-prompt`);
      continue;
    }
    // Validate the regex against the host's real tool names, including dispatch aliases.
    const matcher = String(found[0].regs[0].matcher || '');
    const matches = name => {
      if (!matcher || matcher === '*') return true;
      try { return new RegExp(matcher).test(name); } catch { return false; }
    };
    const dispatch = l.id === 'codex' ? ['spawn_agent', 'Agent'] : ['Task'];
    if (['claude', 'codex'].includes(l.id)
        && (!matches('Bash') || !dispatch.some(matches))) {
      problems.push(`${l.label}: matcher "${matcher}" must cover Bash and ${dispatch.join('/')}`);
      continue;
    }
    okLines.push(`${l.label} (${event}${matcher ? `, ${matcher}` : ''})`);
  }

  if (problems.length) {
    // Name the healthy ones too. With several runtimes installed, "Claude Code: not registered"
    // alone reads as if the gate were off everywhere, when four of five may be fine.
    const tail = okLines.length ? ` (ok: ${okLines.join(', ')})` : '';
    return mk('hooks', 'Gate hook', 'warn', problems.join(' · ') + tail,
      'npm i -g cohorte@latest && cohorte update   (re-registers the gate hook for every installed runtime)');
  }
  const tail = advisory.length ? ` · ${advisory.map(l => l.label).join(', ')}: advisory --check only` : '';
  return mk('hooks', 'Gate hook', 'ok', `registered once for ${okLines.join(', ')}${tail}`);
}

function checkRetrieval(profile, projectRoot, layout) {
  const provider = profile && profile.retrieval && profile.retrieval.provider;
  if (!provider || provider === 'none' || String(provider).startsWith('<')) {
    return mk('retrieval', 'Code retrieval', 'skip', 'provider: none');
  }
  if (layout?.id === 'codex') {
    const file = '.codex/config.toml';
    const config = readText(path.join(projectRoot, file)) || '';
    // Static registration check only, as for the JSON path below. Connectivity requires
    // a live session. Anchor to table declarations so prose/comments cannot count as wired.
    const tables = [...config.matchAll(/^\s*\[mcp_servers\.([^\]\n]+)\]\s*(?:#.*)?$/gm)]
      .map(m => m[1].trim().replace(/^["']|["']$/g, ''));
    const wired = tables.includes(String(provider));
    return mk('retrieval', 'Code retrieval', wired ? 'ok' : 'warn', wired
      ? `provider: ${provider} — table present in ${file} (validity/connectivity need in-session verification)`
      : `profile says provider: ${provider} but ${file} has no matching server table`,
    wired ? undefined : '$cohorte-update-pipeline   (merge the project MCP table)');
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
// Whether the session has workflows ENABLED needs a live Claude session — /cohorte-doctor
// in-session checks that; here we only check what's on disk.
function checkWorkflows(projectRoot, globalDir, installMode, all) {
  if (installMode === 'none') return mk('workflows', 'Workflows', 'skip', 'no core installed');
  // The Workflow engine is Claude Code's; the other runtimes are not shipped the scripts at
  // all, and reporting them as "missing" would flag a deliberate omission as a defect.
  const cc = all.find(l => l.id === 'claude');
  if (!cc) {
    return mk('workflows', 'Workflows', 'skip',
      `not available on ${all.map(l => l.label).join(', ') || 'this runtime'} — conversational commands only`);
  }
  const dir = path.join(cc.core, 'workflows');
  const agentsDir = cc.agents;
  const scripts = ['review.js', 'audit.js', 'refactor.js', 'loop.js'];
  const missing = scripts.filter(s => !exists(path.join(dir, s)));
  if (missing.length === scripts.length) {
    return mk('workflows', 'Workflows', 'warn',
      'no workflow scripts installed — conversational commands only (the default path)',
      'cohorte update   (ships core/workflows/)');
  }
  if (missing.length) {
    return mk('workflows', 'Workflows', 'warn', `missing script(s): ${missing.join(', ')}`,
      'cohorte update   (half-copied core)');
  }
  if (!exists(path.join(agentsDir, 'profile-reader.md'))) {
    return mk('workflows', 'Workflows', 'warn',
      'scripts present but the profile-reader agent (their phase 0) is missing',
      'cohorte update   (re-copies the fixed agents)');
  }
  return mk('workflows', 'Workflows', 'ok',
    'scripts + profile-reader installed — opt-in per run; needs Claude Code ≥ 2.1.154 with ' +
    'workflows enabled (run /cohorte-doctor in-session to check the live half). Inline design ' +
    '(design.inline) has its own, higher floor of ≥ 2.1.234 — it is a separate prerequisite and ' +
    'does not gate this check either way');
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

async function state({ projectRoot, globalDir, cliVersion }) {
  const v = await versions({ projectRoot, globalDir, cliVersion });

  const pipelineMd = readText(path.join(projectRoot, 'PIPELINE.md'));
  const profile = pipelineMd ? parseProfileBlock(pipelineMd) : null;
  const specs = scanSpecs(projectRoot);

  // Which coding agent(s) this repo is wired for. Every path-dependent check below reads from
  // this rather than assuming `.claude/` — on a Cursor-only repo that assumption reported the
  // core, the agents, the artifacts and the hook as all broken, and every one of them was fine.
  const all = layouts({ projectRoot, globalDir });
  const stateAbs = stateDirs(all, projectRoot);
  const stateRels = stateAbs.map(rel(projectRoot));

  const checks = [
    checkCore(v),
    checkProfile(profile, pipelineMd != null),
    acrossRuntimes(all, layout => checkAgents(profile, projectRoot, layout)),
    checkGate(profile, projectRoot, stateAbs),
    checkLocalArtifacts(projectRoot, stateRels),
    checkHooks(projectRoot, globalDir, v.installMode, all),
    acrossRuntimes(all, layout => checkRetrieval(profile, projectRoot, layout)),
    checkDesign(profile, projectRoot),
    checkIsolation(profile, projectRoot),
    checkWorkflows(projectRoot, globalDir, v.installMode, all),
    checkSpecs(specs),
  ];

  const summary = { ok: 0, warn: 0, bad: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;

  return {
    project: projectRoot,
    runtimes: all.map(l => ({ id: l.id, label: l.label, scope: l.scope,
      capabilities: l.capabilities, legacy: !!l.legacy })),
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
