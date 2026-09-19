#!/usr/bin/env node
// collect.mjs — reconstruct per-command cost and runtime from Claude Code's own transcripts.
//
//   node scripts/metrics/collect.mjs [projectRoot] [--json] [--runs] [--since=ISO] [--days=N]
//
// WHY THIS EXISTS
// `.claude/pipeline-metrics.jsonl` is written by the model itself (each command file tells
// it to append a line). That makes it unreliable — a command that ends early, errors, or
// simply forgets writes nothing, and it can never report tokens because the model does not
// know its own usage. Claude Code, meanwhile, already logs every API response it makes to
// ~/.claude/projects/<slug>/<sessionId>.jsonl with exact `usage` and timestamps, and every
// subagent to <sessionId>/subagents/agent-<id>.jsonl. That is ground truth, it needs no
// cooperation from the model, and it is retroactive: this script works on runs that already
// happened. Nothing here writes to the pipeline — it is a pure reader.
//
// THREE THINGS THAT ARE EASY TO GET WRONG, HANDLED HERE
//   1. One API response is written as SEVERAL transcript lines (one per content block:
//      thinking, text, tool_use, tool_use), and EACH line repeats the full `usage` object.
//      Summing lines inflates tokens ~1.8x. We dedupe by message.id.
//   2. Feature work happens in git worktrees, whose cwd hashes to a DIFFERENT project slug.
//      Scanning only the main checkout's slug silently drops most of a multi-surface run. We match
//      sessions by their recorded `cwd` against `git worktree list`.
//   3. Subagent spend lives in a separate file tree and is invisible in the parent
//      transcript. For cohorte that is the majority of the cost, so we walk subagents/ and
//      attribute each agent to the command segment that spawned it (via meta.toolUseId,
//      falling back to timestamp containment for agents spawned by the Workflow runner).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRICES = JSON.parse(fs.readFileSync(path.join(HERE, 'prices.json'), 'utf8'));

// A gap longer than this between two API responses is the human thinking, reading, or away
// — not the command working. `wall` keeps it, `active` drops it. Without the split, a
// command left open over lunch reports a two-hour runtime and poisons every median.
const IDLE_GAP_S = 120;

// A prompt this short with no command in it ("continue", "go", "ok next") is the human
// steering a run that is already going, not starting a new one. Without this, a single
// /cohorte-review driven by three "continue"s reports as one /cohorte-review plus three anonymous chat
// runs, and three quarters of its cost lands under (chat).
const CONTINUATION_MAX_CHARS = 40;

// Commands are recognised two ways. `<command-name>` is emitted only when the whole prompt
// IS the slash command; in practice people write "move on branding-ramp and /cohorte-review", which
// the harness records as ordinary prose. So we also look for an inline mention, checked
// against the real command list rather than any /token — otherwise a file path like
// /usr/bin or a URL fragment would invent commands that were never run.
function knownCommands() {
  const names = new Set();
  for (const dir of [path.join(HERE, '..', '..', 'core', 'commands'),
                     path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'pipeline', 'commands')]) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) names.add(f.slice(0, -3));
    } catch {}
  }
  // Fallback for a collector run outside the package (e.g. copied into a repo on its own).
  if (!names.size) {
    for (const n of ['cohorte-brainstorm', 'cohorte-spec', 'cohorte-build', 'cohorte-review',
                     'cohorte-fix', 'cohorte-ship', 'cohorte-audit', 'cohorte-refactor',
                     'cohorte-align-ds', 'cohorte-doctor',
                     'cohorte-init-pipeline', 'cohorte-update-pipeline']) names.add(n);
  }
  // Retired commands. The list above is read from the shipped core, so a command that is
  // removed stops being recognised — and every run of it already in the transcripts silently
  // reclassifies as (chat), rewriting history and inflating the catch-all bucket. Keep the
  // names here so past runs stay attributed to what actually ran.
  //
  // 2.0.0 prefixed every command with `cohorte-`, which retires all 13 bare names at once:
  // months of transcripts say `/build`, and without these they would all reclassify to (chat)
  // — the largest instance of exactly the bug this list exists to prevent. `drive`/`loop` are
  // both here because the driver was `/loop` → `/drive` (1.6.0) → `/cohorte-loop` (2.0.0), and
  // `cohorte-loop` joins them now that 2.2.0 retired the driver outright.
  for (const n of ['cycle', 'smoke', 'drive', 'loop', 'cohorte-loop',
                   'brainstorm', 'spec', 'build', 'review',
                   'fix', 'ship', 'audit', 'refactor', 'align-ds', 'doctor',
                   'init-pipeline', 'update-pipeline']) names.add(n);
  return names;
}
const COMMANDS = knownCommands();

// An invocation is a short instruction that is mostly the command ("move on branding-ramp
// and /cohorte-review"). A long prompt that happens to name one is someone TALKING ABOUT the
// command — a bug report, a design discussion, a pasted transcript. Counting those as runs
// inflates a command's run count and cost with conversation that never invoked it, which is
// exactly what happened in cohorte's own repo while this pipeline was being discussed.
// Only inline mentions are length-gated; an explicit <command-name> is always an invocation.
const MENTION_MAX_CHARS = 120;

function commandIn(text) {
  const explicit = /<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/.exec(text);
  if (explicit) return explicit[1].replace(/^\//, '');
  if (text.trim().length > MENTION_MAX_CHARS) return null;
  // Last mention wins: "finish /cohorte-build then /cohorte-review" ends on the one being asked for.
  let found = null;
  for (const m of text.matchAll(/(?:^|\s)\/([a-z][a-z0-9-]{2,})\b/g)) {
    if (COMMANDS.has(m[1])) found = m[1];
  }
  return found;
}

// ── paths ────────────────────────────────────────────────────────────────────────────────

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

// Every checkout that belongs to this repo: the main one plus every live feature worktree.
// A cohorte run spreads its surfaces across worktrees, so this set is what makes a feature
// add up instead of reporting only whatever the human happened to type in the main window.
function repoCheckouts(root) {
  const out = new Set([norm(root)]);
  const common = git(['rev-parse', '--git-common-dir'], root).trim();
  if (common) out.add(norm(path.resolve(root, common, '..')));
  for (const line of git(['worktree', 'list', '--porcelain'], root).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) out.add(norm(line.slice(9)));
  }
  return out;
}

const projectsDir = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

// Read only the head of a transcript to decide whether it belongs to this repo. Transcripts
// run to tens of MB and most of them belong to other projects; fully parsing every file to
// find the handful that match turns a 2-second command into a 2-minute one.
function sessionCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString('utf8'));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function findSessions(checkouts) {
  const root = projectsDir();
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }

  const found = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const cwd = sessionCwd(file);
      if (!cwd) continue;
      // A worktree's cwd can be a SUBDIRECTORY of the checkout (an agent cd'd into a
      // package), so prefix-match rather than compare for equality.
      const c = norm(cwd);
      if (![...checkouts].some((k) => c === k || c.startsWith(k + '/'))) continue;
      found.push({ file, dir: path.join(dir, path.basename(f, '.jsonl')), cwd });
    }
  }
  return found;
}

// ── pricing ──────────────────────────────────────────────────────────────────────────────

function rates(model, speed) {
  let best = null;
  for (const key of Object.keys(PRICES.models)) {
    if (String(model || '').startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  if (!best) return null;
  const entry = PRICES.models[best];
  return (speed === 'fast' && entry.fast) ? entry.fast : entry;
}

const emptyTokens = () => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });

function addUsage(acc, usage, model, speed) {
  // `<synthetic>` messages are harness-authored (API error notices, interrupt markers).
  // They carry a usage block but cost nothing — billing them invents spend.
  if (model === '<synthetic>') return;
  const cc = usage.cache_creation || {};
  let w5 = cc.ephemeral_5m_input_tokens || 0;
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  // Older transcripts carry only the flat total with no TTL breakdown. Bill it as 5m —
  // the cheaper of the two, so an unknown-TTL run under-reports rather than inflates.
  if (!w5 && !w1) w5 = usage.cache_creation_input_tokens || 0;

  const t = { input: usage.input_tokens || 0, output: usage.output_tokens || 0,
              cacheWrite5m: w5, cacheWrite1h: w1, cacheRead: usage.cache_read_input_tokens || 0 };
  for (const k of Object.keys(t)) acc.tokens[k] += t[k];

  const r = rates(model, speed);
  if (!r) { acc.unpriced.add(model || 'unknown'); return; }
  const m = PRICES.multipliers;
  acc.cost += (
    t.input * r.input +
    t.output * r.output +
    t.cacheWrite5m * r.input * m.cacheWrite5m +
    t.cacheWrite1h * r.input * m.cacheWrite1h +
    t.cacheRead * r.input * m.cacheRead
  ) / 1e6;

  const byModel = acc.models[model] || (acc.models[model] = emptyTokens());
  for (const k of Object.keys(t)) byModel[k] += t[k];
}

// ── transcript parsing ───────────────────────────────────────────────────────────────────

const userText = (msg) => {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
};

const isToolResultTurn = (msg) =>
  Array.isArray(msg && msg.content) && msg.content.some((b) => b && b.type === 'tool_result');

function newSegment(label, ts) {
  return {
    label, startTs: ts, endTs: ts,
    tokens: emptyTokens(), cost: 0, models: {}, unpriced: new Set(),
    activeS: 0, lastTs: ts, turns: 0, continuations: 0,
    toolUseIds: new Set(), agents: [],
  };
}

// One segment = one command invocation (or one free-form chat turn). Boundaries are user
// turns that are NOT tool results — a tool result is the harness feeding the loop, not the
// human starting something new.
function parseSession(file) {
  const segments = [];
  let seg = null;
  const seenMessageIds = new Set();

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return segments; }

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;

    if (e.type === 'user') {
      const msg = e.message || {};
      if (isToolResultTurn(msg) || e.isMeta || e.isSidechain) continue;
      const text = userText(msg);
      const cmd = commandIn(text);
      // Not every user-role turn is the human starting something. The harness injects
      // turns mid-run — a local-command echo, and (critically for cohorte) a
      // <task-notification> when a background agent finishes. Those arrive DURING a
      // a /cohorte-build; treating them as boundaries chops one command into several
      // cheap-looking fragments and strands the agent spend in the wrong segment.
      if (!cmd && /<(local-command-(stdout|stderr)|task-notification|system-reminder)>/.test(text)) continue;
      // A short steer with no command keeps the current run open rather than opening a new
      // one — see CONTINUATION_MAX_CHARS.
      if (!cmd && seg && text.trim().length <= CONTINUATION_MAX_CHARS) { seg.continuations += 1; continue; }
      seg = newSegment(cmd ? '/' + cmd : '(chat)', ts);
      segments.push(seg);
      continue;
    }

    if (e.type !== 'assistant' || !seg) continue;
    const msg = e.message || {};

    // Dedupe: the same API response is written once per content block, each copy carrying
    // the full usage. See header note 1 — this is the single biggest correctness trap.
    const id = msg.id;
    if (id && seenMessageIds.has(id)) {
      for (const b of msg.content || []) if (b && b.type === 'tool_use' && b.id) seg.toolUseIds.add(b.id);
      if (!Number.isNaN(ts)) seg.endTs = Math.max(seg.endTs, ts);
      continue;
    }
    if (id) seenMessageIds.add(id);

    if (msg.usage) addUsage(seg, msg.usage, msg.model, msg.usage.speed);
    for (const b of msg.content || []) if (b && b.type === 'tool_use' && b.id) seg.toolUseIds.add(b.id);

    seg.turns += 1;
    if (!Number.isNaN(ts)) {
      const gap = (ts - seg.lastTs) / 1000;
      if (gap > 0 && gap <= IDLE_GAP_S) seg.activeS += gap;
      seg.lastTs = ts;
      seg.endTs = Math.max(seg.endTs, ts);
    }
  }
  return segments;
}

// ── subagents ────────────────────────────────────────────────────────────────────────────

function readSubagents(sessionDir) {
  const dir = path.join(sessionDir, 'subagents');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }

  const agents = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const base = f.slice(0, -'.jsonl'.length);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, base + '.meta.json'), 'utf8')); } catch {}

    const acc = { tokens: emptyTokens(), cost: 0, models: {}, unpriced: new Set() };
    let startTs = Infinity, endTs = -Infinity, turns = 0;
    const seen = new Set();

    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'assistant') continue;
      const msg = e.message || {};
      if (msg.id && seen.has(msg.id)) continue;
      if (msg.id) seen.add(msg.id);
      if (msg.usage) addUsage(acc, msg.usage, msg.model, msg.usage.speed);
      turns += 1;
      const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (!Number.isNaN(ts)) { startTs = Math.min(startTs, ts); endTs = Math.max(endTs, ts); }
    }

    agents.push({
      id: base.replace(/^agent-/, ''),
      agentType: meta.agentType || 'unknown',
      description: meta.description || '',
      toolUseId: meta.toolUseId || null,
      spawnDepth: meta.spawnDepth ?? null,
      turns, startTs, endTs, ...acc,
    });
  }
  return agents;
}

function attachAgents(segments, agents) {
  for (const a of agents) {
    // Preferred link: the Task/Agent tool_use that spawned it. Workflow-spawned agents can
    // carry a toolUseId the parent transcript never recorded, so fall back to which segment
    // was running when the agent started.
    let seg = a.toolUseId ? segments.find((s) => s.toolUseIds.has(a.toolUseId)) : null;
    if (!seg && Number.isFinite(a.startTs)) {
      seg = segments.find((s) => a.startTs >= s.startTs && a.startTs <= s.endTs + 5 * 60_000);
    }
    if (!seg) continue;
    seg.agents.push(a);
    for (const k of Object.keys(seg.tokens)) seg.tokens[k] += a.tokens[k];
    seg.cost += a.cost;
    for (const [m, t] of Object.entries(a.models)) {
      const dst = seg.models[m] || (seg.models[m] = emptyTokens());
      for (const k of Object.keys(t)) dst[k] += t[k];
    }
    for (const m of a.unpriced) seg.unpriced.add(m);
    if (Number.isFinite(a.endTs)) seg.endTs = Math.max(seg.endTs, a.endTs);
    // Agents run in parallel, so their wall time is not additive and cannot be folded into
    // the parent's `active`. Segment `wall` already covers them via endTs; agent runtime is
    // reported separately per command as agentWallS.
  }
}

// ── rollup ───────────────────────────────────────────────────────────────────────────────

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

function rollup(segments) {
  const by = new Map();
  for (const s of segments) {
    let g = by.get(s.label);
    if (!g) {
      g = { command: s.label, runs: 0, continuations: 0, tokens: emptyTokens(), cost: 0, models: {},
            wall: [], active: [], agentCounts: [], agentWall: [], turns: [], unpriced: new Set() };
      by.set(s.label, g);
    }
    g.runs += 1;
    g.continuations += s.continuations;
    for (const k of Object.keys(s.tokens)) g.tokens[k] += s.tokens[k];
    g.cost += s.cost;
    for (const [m, t] of Object.entries(s.models)) {
      const dst = g.models[m] || (g.models[m] = emptyTokens());
      for (const k of Object.keys(t)) dst[k] += t[k];
    }
    for (const m of s.unpriced) g.unpriced.add(m);
    g.wall.push(Math.max(0, (s.endTs - s.startTs) / 1000) || 0);
    g.active.push(s.activeS);
    g.turns.push(s.turns);
    g.agentCounts.push(s.agents.length);
    g.agentWall.push(s.agents.reduce((n, a) => n + (Number.isFinite(a.endTs) ? (a.endTs - a.startTs) / 1000 : 0), 0));
  }

  return [...by.values()]
    .map((g) => ({
      command: g.command,
      runs: g.runs,
      continuations: g.continuations,
      cost: { total: g.cost, perRun: g.cost / g.runs },
      tokens: g.tokens,
      tokensPerRun: Object.fromEntries(Object.entries(g.tokens).map(([k, v]) => [k, Math.round(v / g.runs)])),
      wallS: { p50: pct(g.wall, 50), p90: pct(g.wall, 90), total: g.wall.reduce((a, b) => a + b, 0) },
      activeS: { p50: pct(g.active, 50), p90: pct(g.active, 90) },
      agents: { perRunP50: pct(g.agentCounts, 50), total: g.agentCounts.reduce((a, b) => a + b, 0),
                serialWallP50S: pct(g.agentWall, 50) },
      turnsP50: pct(g.turns, 50),
      models: g.models,
      unpriced: [...g.unpriced],
    }))
    .sort((a, b) => b.cost.total - a.cost.total);
}

// ── output ───────────────────────────────────────────────────────────────────────────────

const fmtUsd = (n) => (n < 0.01 && n > 0 ? '<$0.01' : '$' + n.toFixed(2));
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const fmtDur = (s) => (s >= 3600 ? (s / 3600).toFixed(1) + 'h' : s >= 60 ? Math.round(s / 60) + 'm' : Math.round(s) + 's');

function table(rows) {
  const head = ['COMMAND', 'RUNS', '$/RUN', '$ TOTAL', 'TOK/RUN', 'OUT/RUN', 'WALL p50', 'ACTIVE p50', 'AGENTS p50'];
  const body = rows.map((r) => [
    r.command,
    String(r.runs),
    fmtUsd(r.cost.perRun),
    fmtUsd(r.cost.total),
    fmtTok(Object.values(r.tokensPerRun).reduce((a, b) => a + b, 0)),
    fmtTok(r.tokensPerRun.output),
    fmtDur(r.wallS.p50),
    fmtDur(r.activeS.p50),
    String(r.agents.perRunP50),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(head), w.map((n) => '-'.repeat(n)).join('  '), ...body.map(line)].join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes('--' + name);
  const opt = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const root = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());

  let since = opt('since') ? Date.parse(opt('since')) : null;
  if (opt('days')) since = Date.now() - Number(opt('days')) * 86400_000;

  const checkouts = repoCheckouts(root);
  const sessions = findSessions(checkouts);

  let segments = [];
  for (const s of sessions) {
    const segs = parseSession(s.file);
    attachAgents(segs, readSubagents(s.dir));
    segments.push(...segs);
  }
  if (since) segments = segments.filter((s) => s.startTs >= since);
  // A segment with no API call is a typo or an interrupted prompt, not a run.
  segments = segments.filter((s) => s.turns > 0);

  const rows = rollup(segments);
  const totals = {
    sessions: sessions.length,
    runs: segments.length,
    cost: rows.reduce((n, r) => n + r.cost.total, 0),
    agents: rows.reduce((n, r) => n + r.agents.total, 0),
  };

  // The headline figures as a Francois extension `stat-row` payload — four tiles, no
  // table. Deliberately ahead of the --json branch: --panel is a shape, not a filter,
  // and passing both should never print two documents.
  // See github.com/TheBidouilleAgency/francois-plugin-cohorte.
  if (flag('panel')) {
    const window = opt('days') ? `last ${opt('days')} days` : since ? 'since ' + new Date(since).toISOString().slice(0, 10) : 'all time';
    const top = rows[0];
    process.stdout.write(JSON.stringify({ tiles: [
      { label: 'Cost', value: fmtUsd(totals.cost), sublabel: window },
      { label: 'Runs', value: String(totals.runs), sublabel: `${totals.sessions} sessions` },
      { label: 'Subagents', value: String(totals.agents) },
      ...(top ? [{ label: 'Priciest', value: top.command, sublabel: fmtUsd(top.cost.total) }] : []),
    ] }) + '\n');
    return 0;
  }

  if (flag('json')) {
    const out = { generatedAt: new Date().toISOString(), projectRoot: root,
                  checkouts: [...checkouts], pricesUpdated: PRICES.updated, totals, commands: rows };
    if (flag('runs')) {
      out.runs = segments.map((s) => ({
        command: s.label, startedAt: new Date(s.startTs).toISOString(),
        wallS: Math.max(0, (s.endTs - s.startTs) / 1000), activeS: s.activeS,
        turns: s.turns, continuations: s.continuations, cost: s.cost, tokens: s.tokens,
        agents: s.agents.map((a) => ({ type: a.agentType, description: a.description,
                                       cost: a.cost, tokens: a.tokens, turns: a.turns })),
      }));
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (!sessions.length) {
    console.log(`No Claude Code transcripts found for ${root} under ${projectsDir()}.`);
    return 0;
  }
  console.log(`cohorte metrics — ${root}`);
  console.log(`${totals.runs} runs across ${totals.sessions} sessions, ${totals.agents} subagents, ${fmtUsd(totals.cost)} total`
    + (since ? `  (since ${new Date(since).toISOString().slice(0, 10)})` : ''));
  console.log(`prices as of ${PRICES.updated}; wall excludes nothing, active drops gaps > ${IDLE_GAP_S}s\n`);
  console.log(table(rows));

  const unpriced = [...new Set(rows.flatMap((r) => r.unpriced))];
  if (unpriced.length) console.log(`\nnot in prices.json (counted, not costed): ${unpriced.join(', ')}`);
  return 0;
}

process.exit(main(process.argv));
