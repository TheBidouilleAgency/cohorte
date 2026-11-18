#!/usr/bin/env node
// cohorte — CLI for the multi-agent dev pipeline for Claude Code.
//
//   npm i -g cohorte          # the CLI, and the `cohorte` binary on PATH
//   cohorte install           # once per machine: commands, agents, workflows, core → ~/.claude
//   cohorte sync [project]    # wire one repo: gate hook, pointer, .gitignore (init/update run it)
//   cohorte update            # refresh the machine-wide install (same as install, idempotent)
//   cohorte uninstall         # remove exactly what install wrote
//
// One mode since 3.0.0: the machine gets the commands and the generic core; everything that
// describes a project (PIPELINE.md, surface agents, gate config, the gate hook) lives in that
// project and is committed with it.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const globalDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function usage(code) {
  console.log(`cohorte v${VERSION}

Usage:
  cohorte install                 Install (or refresh) cohorte on this machine
  cohorte update                  Same as install — idempotent, migrates a 2.x install
  cohorte sync      [project]     Wire one repo (run by /cohorte-init-pipeline and /cohorte-update-pipeline)
  cohorte uninstall [--purge]     Remove what install wrote (--purge also removes your config)
  cohorte uninstall --project [project]   Remove what sync wrote in one repo
  cohorte doctor    [project] [--porcelain | --json | --panel]
  cohorte specs     [project] [--porcelain | --json | --panel]
  cohorte metrics   [project] [--days=N] [--since=ISO] [--runs] [--json]
  cohorte ui        [--port=N] [--no-open]   Local dashboard over every registered project
  cohorte version

Where things go:
  This machine (${displayHome(globalDir)}):
    commands/cohorte-*.md, agents/cohorte-*.md, workflows/cohorte-*.js, cohorte/ (core + manifest),
    cohorte.config.yaml (your kanban/vault config — seeded once, never overwritten).
  Each project (committed):
    PIPELINE.md, .claude/agents/<surface>.md, .claude/gate-config.json,
    .claude/hooks/cohorte-gate.py + its registration in .claude/settings.json, .claude/pipeline.json.

  install never deletes a file it did not write, backs up any file of ours you modified, and
  refuses to run if ~/.claude/settings.json is not valid JSON.

  doctor runs the same checks as /cohorte-doctor without a coding agent; exits 1 when any check
  is bad (CI-friendly). --panel emits the payload the Francois extension panel expects.
  CLAUDE_CONFIG_DIR moves ${displayHome(path.join(os.homedir(), '.claude'))}; COHORTE_NO_VERSION_CHECK=1 skips the npm lookup.`);
  process.exit(code);
}

function displayHome(p) {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? '~/' + path.relative(home, p) : p;
}

// --- arg parsing -------------------------------------------------------------
const args = process.argv.slice(2);
let mode = null;
let target = null;
let format = 'human';
let purge = false;
let projectScope = false;
const metricsFlags = [];
const isMetricsFlag = (a) =>
  a === '--json' || a === '--runs' || a.startsWith('--days=') || a.startsWith('--since=');
const VERBS = ['install', 'update', 'sync', 'uninstall', 'metrics', 'specs', 'doctor', 'ui'];
let uiPort = 0;
let uiOpen = true;

for (const a of args) {
  if (!mode && VERBS.includes(a)) mode = a;
  else if (a === '--porcelain' || a === '--panel') format = a.slice(2);
  else if (isMetricsFlag(a)) { if (a === '--json') format = 'json'; metricsFlags.push(a); }
  else if (a === 'version' || a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
  else if (a === 'help' || a === '--help' || a === '-h') usage(0);
  else if (a.startsWith('--port=') && mode === 'ui') {
    uiPort = Number(a.slice(7));
    if (!Number.isInteger(uiPort) || uiPort < 0 || uiPort > 65535) { console.error('error: --port must be 0-65535'); process.exit(2); }
  }
  else if (a === '--no-open' && mode === 'ui') uiOpen = false;
  else if (a === '--purge') purge = true;
  else if (a === '--project') projectScope = true;
  // 2.x flags. --global is what 3.x always does; --runtime=claude is the only runtime left.
  else if (a === '--global' || a === '-g') { /* the only mode */ }
  else if (a === '--runtime=claude' || a === '--runtimes=claude') { /* the only runtime */ }
  else if (a.startsWith('--runtime') || a === '--all-runtimes') {
    console.error('error: cohorte 3.x supports Claude Code only. The multi-runtime installer (Codex, Cursor,\n'
      + '       Gemini, OpenCode) is archived: npx cohorte@2.10.2, or the archive/multi-runtime branch.');
    process.exit(2);
  }
  else if (a.startsWith('-')) { console.error(`error: unknown flag: ${a}`); usage(2); }
  else if (target === null) target = path.resolve(a);
  else { console.error(`error: unexpected argument: ${a}`); usage(2); }
}
if (!mode) usage(args.length ? 2 : 0);
if ((mode === 'install' || mode === 'update') && target) {
  console.error(`error: \`cohorte ${mode}\` installs on this machine and takes no project path.\n`
    + `       To wire a project, run \`cohorte sync ${path.relative(process.cwd(), target) || '.'}\` (or /cohorte-init-pipeline inside it).\n`
    + '       2.x "bundled" installs (a core copied into the repo) no longer exist.');
  process.exit(2);
}
if (mode === 'ui' && target) {
  console.error('error: `cohorte ui` is a dashboard over all your projects and takes no path.\n'
    + '       Add a project from the page, or open one with its own `cohorte doctor <path>`.');
  process.exit(2);
}
const project = target || process.cwd();

// --- dashboard ---------------------------------------------------------------
if (mode === 'ui') {
  const built = path.join(__dirname, '..', 'ui', 'dist-server', 'server', 'server.js');
  if (!fs.existsSync(built) || !fs.existsSync(path.join(__dirname, '..', 'ui', 'dist-web', 'index.html'))) {
    console.error('error: the dashboard is not built in this checkout.\n       Run `npm run build:ui` here first (the published package ships it built).');
    process.exit(1);
  }
  const { create } = require(built);
  const ui = create({ globalDir, version: VERSION });
  const bye = () => { ui.jobs.stopAll(); ui.runs.stopAll(); ui.runs.flush(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('exit', () => { ui.jobs.stopAll(); ui.runs.stopAll(); ui.runs.flush(); });
  ui.listen(uiPort).then((l) => {
    console.log(`cohorte ui — ${l.url}\n  Local only (127.0.0.1); the link carries this session's token. Ctrl-C stops it and the dev servers it started.`);
    if (uiOpen && process.stdout.isTTY) {
      const [cmd, ...a] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
      const c = spawnSync(cmd, [...a, l.url], { stdio: 'ignore' });
      if (c.error) console.log('  (could not open a browser — open the link above)');
    }
  }).catch((e) => { console.error(`error: ${e && e.message ? e.message : e}`); process.exit(1); });
  return;
}

// --- read-only reports -------------------------------------------------------
if (mode === 'specs' || mode === 'doctor') {
  const report = require('./report.js');
  const { state, scanSpecs } = require('../lib/doctor.js');
  if (mode === 'specs') {
    const records = report.specRecords(project, scanSpecs);
    if (format === 'json') console.log(JSON.stringify({ project, specs: records }, null, 2));
    else if (format === 'porcelain') { if (records.length) console.log(report.specsPorcelain(records)); }
    else if (format === 'panel') console.log(report.specsPanel(records));
    else console.log(report.specsHuman(records));
    process.exit(0);
  }
  state({ projectRoot: project, globalDir, cliVersion: VERSION }).then((s) => {
    const records = report.checkRecords(s);
    if (format === 'json') console.log(JSON.stringify(s, null, 2));
    else if (format === 'porcelain') { if (records.length) console.log(report.doctorPorcelain(records)); }
    else if (format === 'panel') console.log(report.doctorPanel(records));
    else console.log(report.doctorHuman(s, records));
    process.exit(s.summary.bad > 0 && format !== 'panel' ? 1 : 0);
  }).catch((e) => {
    console.error(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
  return;
}

if (mode === 'metrics') {
  if (format === 'panel') metricsFlags.push('--panel');
  const script = path.join(pkgRoot, 'scripts', 'metrics', 'collect.mjs');
  const r = spawnSync(process.execPath, [script, project, ...metricsFlags], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

// --- writers -----------------------------------------------------------------
function ask(question) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res((a || '').trim()); }));
}

function printList(lines, bullet = '·') { for (const l of lines) console.log(`  ${bullet} ${l}`); }

// The committed project hook runs `python3 …` on every platform, so that is the name to probe.
function python3Present() {
  const r = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { stdio: 'ignore' });
  return r.status === 0;
}

async function staleVersionNotice() {
  if (process.env.CI) return;
  try {
    const v = require('../lib/versions.js');
    const latest = await v.latestNpm({ timeoutMs: 2500, fallback: false });
    if (!latest || v.cmpSemver(VERSION, latest) >= 0) return;
    const viaNpx = /[\\/]_npx[\\/]/.test(pkgRoot);
    console.log(`\n! You ran cohorte ${VERSION}, but ${latest} is published.\n  `
      + (viaNpx ? 'Re-run as  npx cohorte@latest <same command>.' : 'Upgrade with  npm i -g cohorte@latest  and re-run the same command.'));
  } catch { /* never fatal */ }
}

(async () => {
  try {
    if (mode === 'install' || mode === 'update') {
      const { install } = require('../lib/install.js');
      const interactive = process.stdin.isTTY && process.stdout.isTTY;
      console.log(`→ ${mode === 'update' ? 'updating' : 'installing'} cohorte ${VERSION} in ${displayHome(globalDir)}`);
      const r = await install(globalDir, { ask: interactive ? ask : null });
      printList(r.report);
      if (r.warnings.length) { console.log('\n  Heads-up:'); printList(r.warnings, '!'); }
      if (!python3Present()) {
        console.log('\n  ! python3 ≥ 3.9 was not found. The gate hook each project runs needs it — without it,'
          + '\n    every Bash call in a cohorte project is refused (the hook is fail-closed).');
      }
      console.log(`
✓ cohorte ${VERSION} is installed for Claude Code on this machine.

Next, in each project:
  1. Open it in Claude Code and run  /cohorte-init-pipeline  (once) — it writes PIPELINE.md, renders the
     surface agents into .claude/agents and runs  cohorte sync  to wire the gate.
  2. Commit what it lists, then  /cohorte-brainstorm  to start a feature.
Already-wired projects: run  /cohorte-update-pipeline  inside each to pick up this version.`);
    } else if (mode === 'sync') {
      const { sync } = require('../lib/project.js');
      const r = sync(project);
      console.log(`cohorte sync — ${r.root} (core ${r.version})`);
      if (r.changes.length) printList(r.changes); else console.log('  · already in sync');
      if (r.notes && r.notes.length) printList(r.notes, '!');
      if (!fs.existsSync(path.join(globalDir, 'cohorte', 'pipeline', 'VERSION'))) {
        console.log('  ! cohorte is not installed on this machine — run `cohorte install` for the commands.');
      }
      if (r.changes.length) console.log(`  Commit ${require('../lib/project.js').COMMIT_LIST}.`);
    } else if (mode === 'uninstall') {
      if (projectScope) {
        const { unsync } = require('../lib/project.js');
        const r = unsync(project);
        if (r.changes.length) printList(r.changes); else console.log('  · nothing of cohorte\'s to remove here');
        if (r.left.length) console.log(`  Project files kept (yours to delete): ${r.left.join(', ')}`);
      } else {
        const { uninstall } = require('../lib/install.js');
        const r = uninstall(globalDir, { purge });
        printList(r.report.length ? r.report : ['nothing installed']);
        if (r.warnings.length) { console.log('\n  Heads-up:'); printList(r.warnings, '!'); }
        console.log('\n  Projects keep their own files (PIPELINE.md, .claude/…): `cohorte uninstall --project <path>` removes the gate wiring.');
      }
      return;
    }
    await staleVersionNotice();
  } catch (e) {
    console.error(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
})();
