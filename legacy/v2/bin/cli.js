#!/usr/bin/env node
// cohorte — installer CLI for the portable multi-agent pipeline.
// Cross-platform, dependency-free port of install.sh / install.ps1.
//
//   npm i -g cohorte                 # once — the CLI, and the `cohorte` binary on PATH
//   cohorte install                  # bundle the core into <cwd>/.claude (committable)
//   cohorte install [target]         # same, into another project
//   cohorte install --global         # one shared core in ~/.claude
//   cohorte update [--global]        # refresh the core, keep every generated file
//   cohorte version
//
// `npx cohorte <verb>` runs any of these without installing anything — it is the
// escape hatch, not the documented path: a Francois extension panel can only spawn
// a bare binary on PATH, and a globally installed CLI is what puts one there.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const adapter = require('../core/adapter/render.js');

const pkgRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const REPO_URL = 'https://github.com/TheBidouilleAgency/cohorte';

// PreToolUse matcher for the gate hook. MUST cover Task as well as Bash:
// gate.py's preflight phase gate keys off tool_name === "Task" (the `preflight`
// block in a repo's gate-config.json). A Bash-only matcher never delivers a Task
// dispatch to the hook, so that gate silently never fires — it was dead code
// from 1.3.0 to 1.3.1. Keep in lockstep with install.sh and install.ps1.
const GATE_MATCHER = 'Bash|Task';

function usage(code) {
  console.log(`cohorte v${VERSION}

Usage:
  cohorte install   [target] [--global] [--runtime=a,b | --all-runtimes]
  cohorte update    [target] [--global] [--runtime=a,b | --all-runtimes]
  cohorte metrics   [target] [--days=N] [--since=ISO] [--runs] [--json]
  cohorte specs     [target] [--porcelain | --json | --panel]
  cohorte doctor    [target] [--porcelain | --json | --panel]
  cohorte version

Commands:
  install   Fresh install. Default: bundle the core into <target>/.claude
            (committed with the repo). --global: one shared core in ~/.claude,
            available to every project on this machine.
  update    Refresh the stack-agnostic core only. PIPELINE.md, rendered surface
            agents, gate-config.json, settings.json and your filled
            ~/.claude/cohorte.config.yaml are never touched.
  metrics   Cost and runtime per command, reconstructed from Claude Code's own
            transcripts (tokens, USD, wall/active time, subagent count). Reads
            ~/.claude/projects — nothing to enable, and it covers runs that
            already happened. Worktree-aware, so a feature adds up. --json for
            the raw rollup, --runs to include every individual invocation.
  specs     The spec board of <target>: id, status, branch, title, read from the
            frontmatter of specs/*.md. --porcelain for one record per line with
            U+001F between fields, --json for the list.
  doctor    The same checks /cohorte-doctor runs (core, pointer, profile, agents,
            hook, gate, retrieval, design, isolation, specs), without a coding
            agent in the loop. Exits 1 when any check is bad, 0 otherwise, so it
            drops into CI. --porcelain / --json as above.
  version   Print the installed CLI version.

  --panel on specs, doctor and metrics emits the payload a Francois extension
  panel expects (github.com/TheBidouilleAgency/francois-plugin-cohorte).

Runtimes (--runtime=): ${adapter.listRuntimes().join(', ')}
  The pipeline's doctrine is one set of source prompts; the installer renders them into
  whatever each coding agent reads (markdown + frontmatter, plain markdown, or TOML) and
  branches the text on what that agent can actually enforce — where there is no blocking
  hook the gate becomes an explicit check the commands call. Real subagents are required.
  Omit the flag and the installer detects what you have and asks; with no TTY it installs
  for Claude Code alone.`);
  process.exit(code);
}

// --- arg parsing -------------------------------------------------------------
const args = process.argv.slice(2);
let mode = null;
let scope = 'project';
let target = process.cwd();

// Flags that belong to `metrics` and are forwarded verbatim to the collector. They are
// listed here rather than parsed, so the collector stays the single source of truth for
// its own options — but the generic "unknown flag" guard below must not reject them.
const metricsFlags = [];
const isMetricsFlag = (a) =>
  a === '--json' || a === '--runs' || a.startsWith('--days=') || a.startsWith('--since=');

// How `specs`, `doctor` and `metrics` render. One variable, not one flag per command,
// so `--porcelain` never means two different things depending on where it sits.
let format = 'human';

// Which coding agents to install for. Empty ⇒ resolved later (detect, then ask on a TTY,
// then fall back to claude — the only behaviour that existed before 2.2.0).
let wantRuntimes = [];

for (const a of args) {
  if (a === 'install' || a === 'update' || a === 'metrics'
      || a === 'specs' || a === 'doctor') mode = a;
  else if (a === '--porcelain' || a === '--panel') format = a.slice(2);
  else if (isMetricsFlag(a)) { if (a === '--json') format = 'json'; metricsFlags.push(a); }
  else if (a === '--all-runtimes') wantRuntimes = adapter.listRuntimes();
  else if (a === '--runtimes' || a === '--runtime') {
    console.error('error: --runtime needs a value, e.g. --runtime=codex,cursor'); process.exit(2);
  }
  else if (a.startsWith('--runtime=') || a.startsWith('--runtimes=')) {
    for (const id of a.slice(a.indexOf('=') + 1).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!adapter.listRuntimes().includes(id)) {
        console.error(`error: unknown runtime "${id}" (known: ${adapter.listRuntimes().join(', ')})`);
        process.exit(2);
      }
      if (!wantRuntimes.includes(id)) wantRuntimes.push(id);
    }
  }
  else if (a === 'version' || a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
  else if (a === '--global' || a === '-g') scope = 'global';
  else if (a === 'help' || a === '--help' || a === '-h') usage(0);
  else if (a.startsWith('-')) { console.error(`error: unknown flag: ${a}`); usage(2); }
  else target = path.resolve(a);
}
if (!mode) usage(args.length ? 2 : 0);

// --- specs / doctor: read-only reports on <target> ---------------------------
// Both read through lib/, so every consumer of the pipeline's state — the CLI, a
// Francois panel — answers from one implementation. Nothing here writes or spawns.
if (mode === 'specs' || mode === 'doctor') {
  const report = require('./report.js');
  const { state, scanSpecs } = require('../lib/doctor.js');
  const globalDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

  if (mode === 'specs') {
    const records = report.specRecords(target, scanSpecs);
    if (format === 'json') console.log(JSON.stringify({ project: target, specs: records }, null, 2));
    else if (format === 'porcelain') { if (records.length) console.log(report.specsPorcelain(records)); }
    else if (format === 'panel') console.log(report.specsPanel(records));
    else console.log(report.specsHuman(records));
    process.exit(0);
  }

  // `state` is async (it probes versions), so this branch owns the whole tail.
  state({ projectRoot: target, globalDir, cliVersion: VERSION }).then((s) => {
    const records = report.checkRecords(s);
    if (format === 'json') console.log(JSON.stringify(s, null, 2));
    else if (format === 'porcelain') { if (records.length) console.log(report.doctorPorcelain(records)); }
    else if (format === 'panel') console.log(report.doctorPanel(records));
    else console.log(report.doctorHuman(s, records));
    // A bad check is a failure the shell can branch on; warn and skip are not.
    process.exit(s.summary.bad > 0 && format !== 'panel' ? 1 : 0);
  }).catch((e) => {
    console.error(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
  return;
}

// --- metrics: cost + runtime per command ------------------------------------
// The collector is ESM and this CLI is CommonJS, so it runs as a child process rather
// than being required. stdio is inherited so --json stays pipeable.
if (mode === 'metrics') {
  // `--panel` is not in isMetricsFlag (it is not metrics-specific), so forward it here.
  if (format === 'panel') metricsFlags.push('--panel');
  const script = path.join(pkgRoot, 'scripts', 'metrics', 'collect.mjs');
  if (!fs.existsSync(script)) {
    console.error(`error: metrics collector not found at ${script}`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [script, target, ...metricsFlags], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

// --- paths -------------------------------------------------------------------
const globalDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const src = pkgRoot;

if (!fs.existsSync(path.join(src, 'core'))) {
  console.error(`error: pipeline source not found (no core/ in ${src})`);
  process.exit(1);
}

// Filled per runtime by the install loop. `dest` stays the Claude-shaped root (`.claude` /
// `~/.claude`) so every helper below — hook registration, the legacy scrubs — keeps working
// unchanged; non-Claude runtimes put their shared assets under `paths.core` instead.
// CLAUDE_CONFIG_DIR moves Claude Code's whole tree; the registry declares it as `~/.claude`,
// so every resolution has to be re-rooted or the install lands half here, half there.
const PATH_OVERRIDES = { '~/.claude': globalDir };

let runtime = adapter.loadRuntime('claude');
let paths = adapter.resolvePaths(runtime, scope, target, { overrides: PATH_OVERRIDES });
let dest = scope === 'global' ? globalDir : path.join(target, '.claude');

// 2.2.0 retired /cohorte-loop — the autonomous build→review→fix driver. Copy-over never
// deletes, so on an upgrade its command file and its two scripts would survive as a decoy the
// model can still fire: a command that spawns headless children against a core that no longer
// documents them. Scrub the command in every shape this runtime could have installed it, plus
// the scripts, for every runtime rather than only the Claude layout.
function scrubLoop() {
  const ext = runtime.command.ext || '.md';
  fs.rmSync(path.join(paths.commands, `cohorte-loop${ext}`), { recursive: true, force: true });
  // Skills are a directory (`<name>/SKILL.md`), so the parent has to go too.
  if (runtime.command.format === 'skill') {
    fs.rmSync(path.join(paths.commands, 'cohorte-loop'), { recursive: true, force: true });
  }
  for (const f of ['loop.sh', 'loop-detach.sh']) {
    fs.rmSync(path.join(paths.core, 'pipeline', 'scripts', f), { force: true });
  }
}

// Resolve every capability conditional in the copied templates, in place. Unlike commands
// and agents these get no frontmatter and no preamble of their own: a template is always
// read from within a command that already established the runtime.
function resolveTemplateConditionals(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { resolveTemplateConditionals(p); continue; }
    if (!p.endsWith('.md')) continue;
    const src = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, adapter.adaptInstructions(src, runtime));
  }
}

// --- helpers (mirror install.sh) --------------------------------------------
function copyCore() {
  // The runtime-neutral assets. `commands` is NOT among them any more: it is rendered per
  // runtime by renderSurfaces() into whatever directory that agent actually reads.
  // `workflows` = the deterministic orchestration scripts (review/audit/refactor), copied
  // only where a Workflow engine exists — shipping them elsewhere would advertise a path
  // the rendered commands have already conditionalled out.
  const dirs = ['hooks', 'templates'];
  if (runtime.capabilities.workflows) dirs.push('workflows');
  for (const d of dirs) {
    fs.cpSync(path.join(src, 'core', d), path.join(paths.core, d), {
      recursive: true,
      force: true,
      // Never carry a Python bytecode cache into a user's .claude. It appears in a
      // source checkout the moment anyone compiles or imports gate.py (CI does), it
      // is machine- and interpreter-specific, and copy-over never deletes it later.
      filter: s => !s.split(/[\\/]/).includes('__pycache__') && !s.endsWith('.pyc'),
    });
  }
  fs.rmSync(path.join(paths.core, 'hooks', '__pycache__'), { recursive: true, force: true });
  // Templates are read at run time BY a command, so they inherit that command's preamble and
  // its `<core>`/`<state>` tokens — but their capability conditionals are still theirs to
  // resolve, and copying them raw would leave `cohorte:if` markers in the model's context.
  resolveTemplateConditionals(path.join(paths.core, 'templates'));
  // 0.1.19 renamed questionnaire-domain-brief.md → research-brief.md; drop the stale copy.
  fs.rmSync(path.join(paths.core, 'templates', 'questionnaire-domain-brief.md'), { force: true });
  const pipelineDir = path.join(paths.core, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'scripts'), { recursive: true });
  for (const f of ['PIPELINE.template.md', 'SCHEMA.md', 'cohorte.config.template.yaml']) {
    fs.copyFileSync(path.join(src, 'profile', f), path.join(pipelineDir, f));
  }
  // SCHEMA.md is the agents' rulebook, read at RUN time from `<core>/pipeline/`, so its
  // capability conditionals have to be resolved here like any other prompt — a `cohorte:if`
  // left in it would reach the model as visible noise, and the wrong branch would tell it to
  // write where this runtime does not look.
  resolveTemplateConditionals(pipelineDir);
  // Copy the *.template files AND the shipped executables (kanban-move.sh,
  // preflight.sh). Until 1.2.4 this loop took only `.template`, so every
  // `cohorte install/update` produced a core missing both scripts — and since
  // every caller chains them with `|| true`, the result was silent: no kanban card
  // moves, no error. The shell installers named them explicitly
  // and this port drifted. The rule below needs no list to keep in sync: a `<x>.sh`
  // with an `<x>.sh.template` sibling is rendered per-project by /cohorte-init-pipeline, so
  // only the template ships; every other `.sh` is a shipped executable.
  const scriptFiles = fs.readdirSync(path.join(src, 'scripts'));
  for (const f of scriptFiles) {
    const isTemplate = f.endsWith('.template');
    const isShipped = f.endsWith('.sh') && !scriptFiles.includes(`${f}.template`);
    if (!isTemplate && !isShipped) continue;
    const target = path.join(pipelineDir, 'scripts', f);
    fs.copyFileSync(path.join(src, 'scripts', f), target);
    if (isShipped && process.platform !== 'win32') {
      try { fs.chmodSync(target, 0o755); } catch { /* optional */ }
    }
  }
  // 2.3.0 removed telemetry. The copy loop above is by-rule, so it simply stops shipping the
  // sender — but copy-over never deletes, and an existing install would keep an executable
  // that still POSTs to the collector. Scrub it. The dead `telemetry:` block in the user's
  // config is not this installer's to parse: /cohorte-update-pipeline deletes it, where an
  // agent can edit the YAML surgically (SCHEMA.md §Reconcile step 5).
  fs.rmSync(path.join(pipelineDir, 'scripts', 'telemetry-send.sh'), { force: true });
  // The per-surface implementer template is rendered per SURFACE later, by
  // /cohorte-init-pipeline inside the target repo — but its runtime shape (frontmatter keys,
  // capability branches, the preamble) is fixed here, at install time. Run it through the
  // adapter with its <SURFACE_*> placeholders untouched, so init only fills the blanks.
  fs.writeFileSync(path.join(pipelineDir, 'implementer.template.md'), adapter.renderAgent({
    source: fs.readFileSync(path.join(src, 'core', 'agents', 'implementer.template.md'), 'utf8'),
    name: 'implementer.template', runtime, paths, projectRoot: target,
  }).content);
  // What the runtimes ARE, for /cohorte-doctor and anything else that must branch on them at
  // run time. A MAP, merged across installs, not one record: every non-Claude runtime shares
  // the same `.cohorte` core, so a single-record file made each install silently erase the
  // previous one and left /cohorte-doctor diagnosing the wrong agent. Each rendered command
  // already names its own runtime in its preamble; this file supplies the details.
  const registry = path.join(pipelineDir, 'runtimes.json');
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(registry, 'utf8')) || {}; } catch { /* first install */ }
  installed[runtime.id] = {
    label: runtime.label, scope, core_version: VERSION,
    capabilities: runtime.capabilities,
    excluded_commands: runtime.exclude_commands || [],
    paths: {
      core: paths.core, commands: paths.commands,
      agents: paths.agents || path.join(paths.core, 'agents'),
      surface_agents: runtime.id === 'codex' ? '.codex/agents' : undefined,
      agent_ext: runtime.agent.ext,
      // Where the gate registration lives. `cohorte doctor` needs it to tell a registered
      // hook from a missing one without re-deriving each runtime's config layout itself.
      hooks_config: paths.hooks_config,
      state: adapter.stateDir(runtime), config: adapter.configPath(runtime),
    },
  };
  fs.writeFileSync(registry, JSON.stringify(installed, null, 2) + '\n');
  fs.rmSync(path.join(pipelineDir, 'runtime.json'), { force: true });  // 2.2.0-dev single-record form
  // /cohorte-doctor reads this to tell the human what they're missing; the shell installers
  // have always copied it, this port never did.
  const changelog = path.join(src, 'CHANGELOG.md');
  if (fs.existsSync(changelog)) fs.copyFileSync(changelog, path.join(pipelineDir, 'CHANGELOG.md'));
  fs.writeFileSync(path.join(pipelineDir, 'VERSION'), VERSION + '\n');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(path.join(paths.core, 'hooks', 'gate.py'), 0o755); } catch { /* optional */ }
  }
  scrubTddGate();
  scrubLoop();
}

// The TDD gate was removed in 0.1.6. Older installs have hooks/tdd_gate.py on disk and
// registered in settings.json — copy-over never deletes, and a registered hook whose file
// is gone errors on every Write/Edit, so scrub both.
function scrubTddGate() {
  fs.rmSync(path.join(dest, 'hooks', 'tdd_gate.py'), { force: true });
  const settingsPath = path.join(dest, 'settings.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return; }
  const pre = data && data.hooks && Array.isArray(data.hooks.PreToolUse) ? data.hooks.PreToolUse : null;
  if (!pre) return;
  const kept = pre.filter(entry => !(entry.hooks || []).some(
    h => typeof h.command === 'string' && h.command.trim().endsWith('tdd_gate.py')));
  if (kept.length !== pre.length) {
    data.hooks.PreToolUse = kept;
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n');
    console.log('  · removed the retired tdd_gate.py hook (file + settings registration)');
  }
}

// The fixed (non-rendered-per-surface) agents — review, release, profile-reader — plus every
// command. Both go through the adapter, so the same source text lands as a native subagent +
// slash command on Claude/OpenCode and as a persona file + prompt file everywhere else.
function renderSurfaces() {
  const agentsOut = paths.agents || path.join(paths.core, 'agents');
  fs.mkdirSync(agentsOut, { recursive: true });
  fs.mkdirSync(paths.commands, { recursive: true });

  // Every agent in core/agents/ EXCEPT the *.template.md ones, which /cohorte-init-pipeline renders
  // per-surface. Until 1.2.6 this was a hardcoded ['review.md', 'release.md'] that never grew
  // the agents the shell installers copy, so `cohorte install` shipped a command with no
  // agent to dispatch — the run reported the command as not installed.
  // Reading the directory needs no list to keep in sync with the shell installers.
  const agentDir = path.join(src, 'core', 'agents');
  for (const f of fs.readdirSync(agentDir)) {
    if (!f.endsWith('.md') || f.endsWith('.template.md')) continue;
    const out = adapter.renderAgent({
      source: fs.readFileSync(path.join(agentDir, f), 'utf8'),
      name: f.slice(0, -3), runtime, paths, projectRoot: target,
    });
    fs.writeFileSync(path.join(agentsOut, out.filename), out.content);
  }

  const cmdDir = path.join(src, 'core', 'commands');
  const excluded = runtime.exclude_commands || [];
  for (const f of fs.readdirSync(cmdDir)) {
    if (!f.endsWith('.md')) continue;
    // A command the runtime cannot actually execute is not installed at all. Shipping it
    // would put a working-looking entry in the slash menu that fails on first use — and the
    // human would reasonably read that as the pipeline being broken.
    if (excluded.includes(f.slice(0, -3))) continue;
    const out = adapter.renderCommand({
      source: fs.readFileSync(path.join(cmdDir, f), 'utf8'),
      name: f.slice(0, -3), runtime, paths, projectRoot: target,
    });
    // A Codex skill is `<name>/SKILL.md`, so the filename can carry a directory.
    const dest = path.join(paths.commands, out.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out.content);
  }

  // The scrubs below repair Claude-shaped installs that predate the adapter. They are a
  // no-op anywhere else — a fresh non-Claude runtime has no history to clean up — so guard
  // them rather than rm-ing paths that never existed.
  if (runtime.id !== 'claude') return;
  // 0.1.19 split the bi-mode questionnaire-researcher into research-agent + questionnaire-architect;
  // copy-over never deletes, so scrub the retired agent lest a dead subagent_type linger.
  fs.rmSync(path.join(dest, 'agents', 'questionnaire-researcher.md'), { force: true });
  // 1.5.0 removed the /smoke phase; copy-over never deletes, so scrub the orphan agent+command.
  fs.rmSync(path.join(dest, 'agents', 'smoke.md'), { force: true });
  fs.rmSync(path.join(dest, 'commands', 'smoke.md'), { force: true });
  // 1.4.0 removed /cycle and its workflow — and no installer ever scrubbed them, so every
  // install since has kept offering a command that dispatches a workflow whose phases were
  // later deleted. A dead command is worse than a missing one: the model can still fire it.
  fs.rmSync(path.join(dest, 'commands', 'cycle.md'), { force: true });
  fs.rmSync(path.join(dest, 'workflows', 'cycle.js'), { force: true });
  // 1.6.0 renamed /loop → /drive: Claude Code's own built-in /loop shadowed ours, so a leftover
  // commands/loop.md is a command the user can never reach — scrub it rather than leave a decoy.
  fs.rmSync(path.join(dest, 'commands', 'loop.md'), { force: true });
  // 2.0.0 prefixed every command with `cohorte-`, which ends the shadowing problem for good.
  // Copy-over never deletes, so all 13 bare names would survive an upgrade as decoys — and a
  // stale /build is the worst kind: it still dispatches implementers, from a 1.x command file
  // that knows nothing of this core's contract. /drive goes too (it became /cohorte-loop).
  for (const c of ['align-ds', 'audit', 'brainstorm', 'build', 'doctor', 'drive', 'fix',
                   'init-pipeline', 'refactor', 'review', 'ship', 'spec', 'update-pipeline']) {
    fs.rmSync(path.join(dest, 'commands', `${c}.md`), { force: true });
  }
  scrubResearchQuestionnaire();
}

// The research + questionnaire capability was removed. Older installs have its agents, commands,
// templates and template-step dirs on disk; copy-over never deletes, so scrub every orphan.
function scrubResearchQuestionnaire() {
  for (const f of ['research-agent.md', 'questionnaire-architect.md',
                   'questionnaire-writer.md', 'questionnaire-validator.md']) {
    fs.rmSync(path.join(dest, 'agents', f), { force: true });
  }
  for (const f of ['research.md', 'questionnaire.md']) {
    fs.rmSync(path.join(dest, 'commands', f), { force: true });
  }
  for (const f of ['research-brief.md', 'questionnaire-blueprint.md',
                   'questionnaire-declaration.md', 'questionnaire-verdict.md']) {
    fs.rmSync(path.join(dest, 'templates', f), { force: true });
  }
  for (const d of ['research', 'questionnaire']) {
    fs.rmSync(path.join(dest, 'templates', 'steps', d), { recursive: true, force: true });
  }
}

// --- interactive config helpers ---------------------------------------------
// Ask one question on the TTY. Resolves to the trimmed answer (or '' on EOF).
function ask(question) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res((a || '').trim()); }));
}
function yes(a) { return /^(y|yes|o|oui)$/i.test(a); }

// Set the value on the line carrying `# cfg:<cfgKey>`, preserving the yaml key + the comment.
// The config template anchors every interactive field this way, so we never parse YAML.
// Line-scoped on purpose (a multiline regex would let \s span newlines and mangle keys).
function setCfg(text, cfgKey, value) {
  const marker = `# cfg:${cfgKey}`;
  return text.split('\n').map(line => {
    const idx = line.indexOf(marker);
    if (idx === -1) return line;
    const m = line.slice(0, idx).match(/^(\s*[\w.]+:\s*)/);   // "  key: "
    return m ? `${m[1]}${value}  ${line.slice(idx)}` : line;
  }).join('\n');
}

// Register gate.py as this runtime's blocking pre-command hook. Four of the five can do it —
// only OpenCode has no hook contract (plugins are a different thing), and there the rendered
// commands call `gate.py --check` explicitly instead.
//
// Three config shapes, all reconciled rather than appended: drop every existing cohorte gate
// entry, then add exactly one. Idempotent, collapses duplicates an older installer left, and
// repairs a stale matcher in place — an append-if-absent would find the stale entry and skip.
function registerRuntimeHook() {
  const spec = runtime.hook;
  const cfgPath = runtime.scopes[scope].hooks_config;
  if (!spec || !cfgPath) return 'n/a (this runtime has no hook contract — the gate runs as an explicit --check)';
  const python = findPython();
  if (!python) return 'skipped (no python found — register the gate hook manually)';

  const file = path.join(paths.core, 'hooks', 'gate.py');
  // Quoted on every platform — see registerGlobalHook: an unquoted path with a space breaks
  // every tool call in the session, and the config dirs these runtimes use live under the
  // user's home, which on macOS routinely contains one.
  const cmd = `${python} "${file}" --runtime ${runtime.id}`;
  const isOurs = (s) => typeof s === 'string' && s.includes('gate.py');

  const dest = adapter.expandHome(cfgPath);
  const abs = path.isAbsolute(dest) ? dest : path.join(target, dest);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch { /* absent or invalid → start fresh */ }
  if (!data.hooks || typeof data.hooks !== 'object') data.hooks = {};

  if (spec.format === 'cursor') {
    // { "version": 1, "hooks": { "beforeShellExecution": [ { "command": "…" } ] } }
    if (!data.version) data.version = 1;
    const list = Array.isArray(data.hooks[spec.event]) ? data.hooks[spec.event] : [];
    data.hooks[spec.event] = list.filter((e) => !isOurs(e && e.command));
    data.hooks[spec.event].push({ command: cmd });
  } else {
    // Claude/Codex PreToolUse and Gemini BeforeTool share the matcher-group shape.
    const list = Array.isArray(data.hooks[spec.event]) ? data.hooks[spec.event] : [];
    data.hooks[spec.event] = list.filter(
      (e) => !((e && e.hooks) || []).some((h) => isOurs(h && h.command)));
    data.hooks[spec.event].push({
      matcher: spec.matcher, hooks: [{ type: 'command', command: cmd }],
    });
  }
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
  const where = adapter.displayPath(abs, target);
  return spec.supports_ask
    ? `registered in ${where} (${spec.event})`
    : `registered in ${where} (${spec.event}) — no confirmation tier here, so a gated command is denied rather than queried`;
}

// Fill the seeded config from a short TTY interview (shared Obsidian vault for the kanban mirror).
// Kanban is per-project, so it is wired later by /cohorte-init-pipeline — not asked here.
async function promptConfig(text) {
  console.log('\n  Quick setup (Enter to skip — you can also wire this later via');
  console.log('  /cohorte-init-pipeline or /cohorte-update-pipeline):');
  const vault = await ask('    · absolute path to your shared Obsidian vault (for the kanban mirror): ');
  if (vault) text = setCfg(text, 'vault_path', `"${vault}"`);
  return text;
}

// The pipeline capability config is USER-level (vault, Notion DB, kanban boards) — it lives in
// ~/.claude regardless of install scope. Seed it only if the user has no copy (consolidated OR
// legacy). On a TTY, offer a quick interview to fill it; otherwise seed disabled defaults.
async function seedConfig() {
  // One config per human, but it has to live somewhere the running agent can find without
  // being told: `~/.claude` for Claude Code (unchanged — existing files stay authoritative),
  // `~/.cohorte` for every other runtime. The shipped scripts probe both, in that order, so
  // a human who drives one repo from two agents still has a single board and a single consent.
  //
  // CLAUDE_CONFIG_DIR moves the whole `~/.claude` tree (globalDir already follows it), but
  // adapter.configPath() speaks in literal `~/.claude/…` — expanding through HOME alone
  // seeded a file at a path no reader probes (kanban-move.sh follows
  // CLAUDE_CONFIG_DIR), missed a filled config there (re-seeding disabled defaults beside
  // it — the exact two-file fork this function's comments forbid), and printed a banner
  // path that did not exist. Re-root the claude-shaped path onto globalDir so the seed,
  // the existing-file check, the banner and every reader agree on one file.
  const homeClaude = path.join(os.homedir(), '.claude');
  const rerootClaude = (p) =>
    p === homeClaude || p.startsWith(homeClaude + path.sep)
      ? path.join(globalDir, p.slice(homeClaude.length + 1) || '.')
      : p;
  const cfg = rerootClaude(adapter.expandHome(adapter.configPath(runtime)));
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  // Pre-rename names, newest first — read as a fallback so upgrades don't lose the config.
  const legacy = ['thebidouille.config.yaml']
    .map((n) => path.join(globalDir, n)).find(fs.existsSync);
  if (fs.existsSync(cfg)) { console.log(`  · kept your existing ${cfg}`); return; }
  // A second runtime must not fork the config: two files means two boards and two consent
  // records, and the human edits whichever one they happen to open. The scripts read
  // `~/.cohorte` first, so seeding it here would SHADOW a filled `~/.claude` copy.
  const claudeCfg = rerootClaude(adapter.expandHome(adapter.configPath({ id: 'claude' })));
  if (cfg !== claudeCfg && fs.existsSync(claudeCfg)) {
    console.log(`  · reusing your existing ${claudeCfg} (the scripts read it as a fallback)`);
    return;
  }
  if (legacy) {
    console.log(`  · found legacy ${legacy} — kept as-is (still read as a fallback).`);
    console.log('    Run /cohorte-update-pipeline to migrate it into cohorte.config.yaml + wire the kanban.');
    return;
  }
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  let text = fs.readFileSync(path.join(src, 'profile', 'cohorte.config.template.yaml'), 'utf8');
  if (process.stdin.isTTY && process.stdout.isTTY) {
    text = await promptConfig(text);
    fs.writeFileSync(cfg, text);
    console.log(`  · seeded ${cfg} from your answers`);
  } else {
    fs.writeFileSync(cfg, text);
    console.log(`  · seeded ${cfg} (disabled defaults — enable via /cohorte-init-pipeline or /cohorte-update-pipeline)`);
  }
}

function findPython() {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore', shell: false });
    if (r.status === 0) return c;
  }
  return null;
}

// Register the profile-driven gate hook in the GLOBAL settings.json. Idempotent: the
// hook reads each repo's own .claude/gate-config.json (and no-ops where absent),
// so one registration serves every project.
function registerGlobalHook() {
  const python = findPython();
  if (!python) return 'skipped (no python found — register the gate hook manually)';
  const settingsPath = path.join(dest, 'settings.json');
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch { /* absent or invalid → start fresh */ }
  if (!data.hooks || typeof data.hooks !== 'object') data.hooks = {};
  if (!Array.isArray(data.hooks.PreToolUse)) data.hooks.PreToolUse = [];

  const file = path.join(dest, 'hooks', 'gate.py');
  const base = path.basename(file);
  // Trailing-quote tolerant: the Windows form is `py "C:\...\gate.py"`, and a
  // bare .endsWith() missed it — which is how repeat `cohorte install`
  // runs accumulated a duplicate registration every time (gate.py then ran
  // once per copy on every Bash call).
  const isGate = entry => (entry.hooks || []).some(
    h => typeof h.command === 'string' && h.command.trim().replace(/"+$/, '').endsWith(base));
  // ALWAYS quote the path. The hook command is handed to a shell, so a config dir containing a
  // space — `~/Library/Application Support/…`, which is exactly where a desktop host puts it —
  // splits into two arguments and python reports `can't open file '/Users/x/Library/Application'`
  // on EVERY tool call, in a session the human cannot easily un-break. Only the Windows form was
  // quoted, so this failed silently on precisely the platform where the path is most likely to
  // contain a space.
  const cmd = `${python} "${file}"`;

  // Reconcile rather than append-if-absent: drop every existing gate.py
  // registration, then add exactly one. Idempotent, collapses duplicates older
  // installers left behind, and upgrades a stale "Bash"-only matcher in place —
  // an append-if-absent would find the stale entry and skip, pinning the bug.
  data.hooks.PreToolUse = data.hooks.PreToolUse.filter(e => !isGate(e));
  data.hooks.PreToolUse.push({ matcher: GATE_MATCHER, hooks: [{ type: 'command', command: cmd }] });

  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n');
  return 'ok';
}

// Bump only the core_version in a repo's committed .claude/pipeline.json (bundled mode).
// Leaves every other field intact; no-ops if the pointer is absent or has no core_version.
function bumpPointerVersion(ptr) {
  if (!fs.existsSync(ptr)) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(ptr, 'utf8')); } catch { return; }
  if (data && typeof data === 'object' && 'core_version' in data) {
    data.core_version = VERSION;
    fs.writeFileSync(ptr, JSON.stringify(data, null, 2) + '\n');
  }
}

// --- runtime selection -------------------------------------------------------

// Which coding agents this install targets. Explicit flags win. Otherwise: detect what is
// configured on this machine, and — on a TTY — let the human confirm, because installing
// into a runtime they don't use litters a config dir they never asked us to touch. With no
// TTY and no flag we install for Claude Code alone: the behaviour of every version before
// the adapter, so a scripted `cohorte install` keeps doing exactly what it did.
async function selectRuntimes() {
  if (wantRuntimes.length) return wantRuntimes;
  const found = adapter.detectRuntimes();
  if (found.length <= 1) return found.length ? found : ['claude'];
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.log(`  · several runtimes detected (${found.join(', ')}) — installing for claude only.`);
    console.log('    Pass --runtime=a,b or --all-runtimes to cover the others.');
    return ['claude'];
  }
  console.log('\n  Coding agents detected on this machine:');
  found.forEach((id, i) => console.log(`    ${i + 1}. ${adapter.loadRuntime(id).label}`));
  const a = await ask('    Install for which? (Enter = all, or e.g. 1,3): ');
  if (!a) return found;
  const picked = a.split(/[,\s]+/).map((n) => found[parseInt(n, 10) - 1]).filter(Boolean);
  return picked.length ? [...new Set(picked)] : found;
}

// --- staleness notice --------------------------------------------------------
// `install` and `update` write a core taken from THIS package, so the core is only
// as fresh as the CLI that ran. `npx cohorte@latest` made that self-correcting; a
// global install does not — `cohorte update` on a pinned 2.5.0 would re-lay the
// 2.5.0 core forever and report success, which is an update that updates nothing.
// So the CLI checks its own version against the registry and says what to run.
// Never fatal, never blocking a successful install: a short fetch, no `npm view`
// fallback, and silence on any failure. COHORTE_NO_VERSION_CHECK / CI opt out.
async function staleVersionNotice() {
  if (process.env.COHORTE_NO_VERSION_CHECK || process.env.CI) return;
  let latest = null;
  try {
    const v = require('../lib/versions.js');
    latest = await v.latestNpm({ timeoutMs: 2500, fallback: false });
    if (!latest || v.cmpSemver(VERSION, latest) >= 0) return;
  } catch { return; }
  // How you got here decides the fix: under npx the package is transient (and may
  // have come from the cache rather than the registry), so the answer is to pin
  // @latest; with a global install the answer is to upgrade the global.
  const viaNpx = /[\\/]_npx[\\/]/.test(pkgRoot);
  console.log(`
! You ran cohorte ${VERSION}, but ${latest} is published — the core just written is ${VERSION}.
  ${viaNpx
    ? 'Re-run as  npx cohorte@latest <same command>  to lay down the current core.'
    : 'Upgrade with  npm i -g cohorte@latest  and re-run the same command.'}`);
}

// --- run ---------------------------------------------------------------------
(async () => {
const selected = await selectRuntimes();
for (const id of selected) {
  runtime = adapter.loadRuntime(id);
  paths = adapter.resolvePaths(runtime, scope, target, { overrides: PATH_OVERRIDES });
  dest = runtime.id === 'claude'
    ? (scope === 'global' ? globalDir : path.join(target, '.claude'))
    : paths.core;
  fs.mkdirSync(paths.core, { recursive: true });
  if (selected.length > 1) console.log(`\n── ${runtime.label} ──`);
  await installOne();
}
if (selected.length > 1) {
  console.log(`\n✓ installed for ${selected.length} runtimes: ${selected.join(', ')}.`);
  console.log('  The doctrine is identical; what differs is enforcement — run /cohorte-doctor in');
  console.log('  each one to see what it can and cannot guarantee.');
}
// Last, so a stale CLI is the final thing on screen rather than scrolled past.
await staleVersionNotice();
})();

async function installOne() {
if (runtime.id !== 'claude') {
  // Everything below the Claude branch assumes Claude's own layout (settings.json hook
  // registration, the `.claude` pointer). A non-Claude runtime gets the shared core, the
  // rendered commands/personas, and nothing that would only pretend to be wired.
  copyCore();
  renderSurfaces();
  const hookState = registerRuntimeHook();
  await seedConfig();
  if (mode === 'install' && scope === 'project') {
    fs.mkdirSync(path.join(target, 'specs'), { recursive: true });
    const specTemplate = path.join(target, 'specs', '_template.md');
    if (!fs.existsSync(specTemplate)) {
      fs.copyFileSync(path.join(src, 'core', 'templates', 'spec.template.md'), specTemplate);
    }
  }
  const cmds = adapter.displayPath(paths.commands, target);
  const agentsWhere = paths.agents
    ? `${adapter.displayPath(paths.agents, target)} (${runtime.agent.format})`
    : 'sequential personas — this runtime has no subagents';
  console.log(`
✓ ${runtime.label}: core in ${adapter.displayPath(paths.core, target)}, commands in ${cmds}  (version ${VERSION})
  invoke: ${runtime.command.invoke.replace('<name>', 'cohorte-init-pipeline')}
  agents: ${agentsWhere}
  gate: ${hookState}`);
  if (runtime.id === 'codex') {
    console.log('  surface agents: .codex/agents/*.toml in each project (generated by init/reconcile)');
    console.log('  keep your normal CODEX_HOME; no project launcher or auth symlink is needed');
  }
  if ((runtime.exclude_commands || []).length) {
    const named = runtime.exclude_commands.map((c) => runtime.command.invoke.replace('<name>', c));
    console.log(`  not installed here: ${named.join(', ')}${runtime.exclude_reason ? ` — ${runtime.exclude_reason}` : ''}`);
  }
  if (runtime.scopes[scope].commands_scope === 'global' && scope === 'project') {
    console.log(`  note: ${runtime.label} reads commands only from your home dir, so they were`);
    console.log('        installed there even though the core is bundled in this repo.');
  }
  return;
}
if (scope === 'global') {
  console.log(mode === 'install'
    ? `→ installing pipeline core GLOBALLY into ${dest}`
    : `→ updating pipeline core GLOBALLY in ${dest} (keeping global settings.json)`);
  renderSurfaces();
  copyCore();
  // Register on UPDATE too — install.sh and install.ps1 always have, and this
  // port skipping it is why a duplicated or stale-matcher registration could
  // never be repaired by `cohorte update`: the only route that rewrites it
  // was a full re-install, which is not what anyone runs to get a fix. Safe to
  // run every time — registration reconciles only gate.py entries and leaves
  // every other hook and settings key untouched.
  const hookState = registerGlobalHook();
  await seedConfig();
  console.log(`
✓ pipeline core installed globally into ${dest}  (version ${VERSION})
  gate hook: ${hookState}  (reads each repo's .claude/gate-config.json; silent where absent)

The commands (/cohorte-init-pipeline, /cohorte-brainstorm, /cohorte-build …) and the review/release agents are now
available in EVERY project on this machine — nothing is copied per repo.

Per repo:
  1. Open the project in Claude Code.
  2. Run  /cohorte-init-pipeline  — it generates PIPELINE.md, renders the surface agents, writes
     .claude/gate-config.json, and drops a committed .claude/pipeline.json pointer so
     teammates know to install the global core (${REPO_URL}).
  3. Commit PIPELINE.md + .claude/, then  /cohorte-brainstorm  to start a feature.

Update later with:  npm i -g cohorte@latest && cohorte update --global

Global kanban config, user-scoped — optional:
  · One consolidated file: ${path.join(globalDir, 'cohorte.config.yaml')}
  · Don't hand-edit it — /cohorte-init-pipeline (new project) and /cohorte-update-pipeline (existing) wire it
    for you: creating + syncing an Obsidian kanban board of the pipeline in your shared vault.`);
} else if (mode === 'install') {
  console.log(`→ installing pipeline core into ${dest}`);
  renderSurfaces();
  copyCore();
  await seedConfig();
  fs.mkdirSync(path.join(target, 'specs'), { recursive: true });
  const specTemplate = path.join(target, 'specs', '_template.md');
  if (!fs.existsSync(specTemplate)) {
    fs.copyFileSync(path.join(src, 'core', 'templates', 'spec.template.md'), specTemplate);
  }
  console.log(`
✓ pipeline core installed into ${dest}  (version ${VERSION})

Next:
  1. Open the project in Claude Code.
  2. Run  /cohorte-init-pipeline   — it detects your stack, asks the gaps, and generates
     PIPELINE.md + renders one implementer agent per surface.
  3. Commit PIPELINE.md, then  /cohorte-brainstorm  to start a feature.

Update later with:  npm i -g cohorte@latest && cohorte update
Prefer one shared core across all your repos?  Re-run with  --global.`);
} else {
  console.log(`→ updating pipeline core in ${dest} (keeping your PIPELINE.md + rendered agents)`);
  copyCore();
  try { renderSurfaces(); } catch { /* best-effort, as in install.sh */ }
  await seedConfig();
  bumpPointerVersion(path.join(dest, 'pipeline.json'));
  console.log(`
✓ core refreshed to ${VERSION}. Your PIPELINE.md, rendered surface agents, gate-config.json and
  settings.json were left as-is. Re-run /cohorte-init-pipeline if your stack changed.`);
}
}
