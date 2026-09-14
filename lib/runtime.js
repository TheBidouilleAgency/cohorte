'use strict';
// Which coding agent(s) this project is wired for, and where each one keeps its files.
//
// Before 2.2.0 every path here was `.claude/…`. That is now one layout of five:
// a repo driven from Cursor keeps its core in `.cohorte/cursor/`, its agents in
// `.cursor/agents/` and its gate registration in `.cursor/hooks.json`. Checking the Claude
// paths there reports a perfectly healthy install as broken — "no core", "no rendered agent",
// "gate not registered" — which is worse than not checking at all: it sends a human fixing
// something that is not wrong.
//
// The installer writes `<core>/pipeline/runtimes.json` (a map of every runtime installed
// against that core), so discovery is a directory probe rather than a guess.

const fs = require('fs');
const os = require('os');
const path = require('path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// `<state>` — where the pipeline writes what it generates FOR THIS PROJECT (gate config,
// preflight stamp, metrics). Shared by every non-Claude runtime on purpose: it describes the
// project, not the agent driving it.
function stateDirFor(id) {
  return id === 'claude' ? '.claude' : '.cohorte';
}

// Candidate core directories, project scope first — a bundled core wins over a global one,
// same precedence the commands themselves use.
function candidateCores(projectRoot, globalDir) {
  const home = os.homedir();
  const out = [
    { dir: path.join(projectRoot, '.claude'), scope: 'project' },
    { dir: globalDir || path.join(home, '.claude'), scope: 'global' },
  ];
  for (const [root, scope] of [[path.join(projectRoot, '.cohorte'), 'project'],
                               [path.join(home, '.cohorte'), 'global']]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* absent */ }
    for (const e of entries) {
      if (e.isDirectory()) out.push({ dir: path.join(root, e.name), scope });
    }
  }
  return out;
}

/**
 * Every runtime installed against this project, most-authoritative first.
 * Each layout resolves the paths a check needs, absolute where they are absolute.
 * Returns [] when nothing is installed — callers report that as the missing core it is.
 */
function layouts({ projectRoot, globalDir }) {
  const found = [];
  const seen = new Set();
  for (const { dir, scope } of candidateCores(projectRoot, globalDir)) {
    const registry = readJson(path.join(dir, 'pipeline', 'runtimes.json'));
    // A core with no registry predates the adapter ⇒ it can only be a Claude install.
    const ids = registry ? Object.keys(registry) : (
      fs.existsSync(path.join(dir, 'pipeline', 'VERSION')) ? ['claude'] : []);
    for (const id of ids) {
      const key = `${id}@${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rec = (registry && registry[id]) || {};
      const p = rec.paths || {};
      // runtimes.json records ABSOLUTE install-time paths. For a bundled (committed)
      // core, a clone or a moved checkout still carries the ORIGINAL machine's paths —
      // taken verbatim, every doctor check goes red on a healthy install ("no rendered
      // agent", "gate not registered"). Recover the install-time project root from the
      // recorded core path (its tail must match this core's path relative to the
      // current project root — '.claude', '.cohorte/<rt>') and re-root anything under
      // it onto the current projectRoot. Global cores sit outside the project and are
      // machine-local by definition — their absolute paths pass through untouched.
      const rel = path.relative(projectRoot, dir);
      let recordedRoot = null;
      if (p.core && rel && !rel.startsWith('..') && !path.isAbsolute(rel)
          && (p.core === rel || p.core.endsWith(path.sep + rel))) {
        recordedRoot = p.core.slice(0, p.core.length - rel.length - 1) || null;
      }
      const abs = (v, fallback) => {
        const raw = v || fallback;
        if (!raw) return null;
        if (!path.isAbsolute(raw)) return path.join(projectRoot, raw);
        if (recordedRoot && recordedRoot !== projectRoot
            && (raw === recordedRoot || raw.startsWith(recordedRoot + path.sep))) {
          return path.join(projectRoot, raw.slice(recordedRoot.length + 1) || '.');
        }
        return raw;
      };
      found.push({
        id,
        label: rec.label || id,
        scope: rec.scope || scope,
        core: dir,
        agents: abs(p.agents, path.join(dir, 'agents')),
        // A global Codex core must never bind surface agents to its installing project.
        // Also repair discovery for registries written before this distinction existed.
        surfaceAgents: id === 'codex' ? path.join(projectRoot, '.codex', 'agents')
          : abs(p.surface_agents || p.agents, path.join(dir, 'agents')),
        agentExt: p.agent_ext || (id === 'codex' ? '.toml' : '.md'),
        commands: abs(p.commands, path.join(dir, 'commands')),
        state: abs(null, p.state || stateDirFor(id)),
        // Pre-2.2.0 cores carry no registry, so nothing records where the hook is registered.
        // Claude's is `<core>/settings.json` and always has been — without this fallback a
        // legacy install reports its perfectly good registration as missing.
        hooksConfig: (rec.paths && rec.paths.hooks_config)
          ? abs(rec.paths.hooks_config)
          : (id === 'claude' ? path.join(dir, 'settings.json') : null),
        capabilities: rec.capabilities || {
          subagents: true, hooks: id === 'claude', workflows: id === 'claude',
        },
        legacy: !registry,
      });
    }
  }
  return found;
}

/**
 * The layout the project-level checks should use. Claude first when present — it is the
 * reference implementation and the layout every pre-2.2.0 repo has — else whatever is
 * installed. Null when nothing is.
 */
function primary(all) {
  if (!all.length) return null;
  return all.find((l) => l.id === 'claude') || all[0];
}

// The state dirs actually in play. A repo driven from Claude AND Cursor has both `.claude`
// and `.cohorte`; a check that looked at only one would miss a stamp or a metrics file.
function stateDirs(all, projectRoot) {
  const dirs = [];
  for (const l of all) if (!dirs.includes(l.state)) dirs.push(l.state);
  if (!dirs.length) dirs.push(path.join(projectRoot, '.claude'));
  return dirs;
}

module.exports = { layouts, primary, stateDirs, stateDirFor };
