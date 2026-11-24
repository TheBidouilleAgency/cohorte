'use strict';
// cohorte <ticket|take|lead|checkpoint|autopilot|merge|accept> — the company flow from a terminal.
//
// The same engine as `cohorte ui` (ui/dist-server/server/engine.js), on the same files: a ticket filed here is on the
// kanban page, a CP1 approved on the page can be followed here, and the reverse. Every verb is one transition the
// page has a button for, then it DRIVES what that transition started — runs are child processes of this one, and a
// run's end is what moves the flow on — until the flow rests on a person:
//
//   take        worktree + feature record (id = ticket id) → the lead frames → the plan (CP1)
//   lead        a reply to the lead (framing, or after CP1/CP2 asked to re-frame) → its next turn
//   checkpoint  CP1 approve → spec frozen → the autopilot runs to the next checkpoint; CP2/CP3 as on the page
//   autopilot   the advance loop headless: one line per stage; CP2/CP3 and handed-over questions asked here
//   merge       gh pr merge → learn → the PO's acceptance note (CP4)
//   accept      CP4: ok → done; not-quite → done + a follow-up PO conversation
//   adopt       a spec written in a plain session (no feature record) joins the flow, at the phase its files say
//   new-project vision → foundation → scaffold → pipeline set-up, with the checkpoints of the page's Founding
//
// Mid-run questions go to the decider first, exactly as in the UI; what it hands over is asked on this terminal —
// and is on the page's inbox at the same time (run files carry what a run parked; an answer from the page reaches
// this process through the store). With no terminal (stdin not a TTY, or --no-interactive) the run is stopped and
// the feature parked at CP2 — what a restart of cohorte ui does — and the verb exits 3.
//
// --detach runs the verb in a background process of its own (`--driven`: it holds the feature's lease, logs to
// <data>/drives/<project>/<id>.log, waits for answers from the page or from `cohorte autopilot <id> --follow`, and
// stops at the next checkpoint). Exit codes:
//   0 nothing waits on the developer (PR open, acceptance with the business, done, detached) · 1 error
//   2 a checkpoint or the lead waits on the developer · 3 a question was parked (CP2) · 4 another process drives it

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EXIT = { ok: 0, error: 1, waiting: 2, parked: 3, elsewhere: 4 };
const VERBS = ['ticket', 'take', 'lead', 'checkpoint', 'autopilot', 'merge', 'accept', 'adopt', 'new-project'];
/** The verbs that drive runs — the ones --detach can send to the background. */
const DRIVING = ['take', 'lead', 'checkpoint', 'autopilot', 'merge', 'adopt'];
const BOOL = new Set(['help', 'json', 'no-lead', 'interactive', 'no-interactive', 'yes', 'skip-docker-check', 'detach', 'driven', 'follow', 'idea', 'stack', 'resume']);
/** A value when one follows (`ticket list --status backlog`), else a switch (`autopilot <id> --status`). */
const OPTIONAL = new Set(['status']);
const MULTI = new Set(['criteria', 'out-of-scope']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UsageError extends Error {}

function parse(argv) {
  const pos = []; const o = { criteria: [], 'out-of-scope': [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (BOOL.has(k)) { o[k] = v === undefined ? true : v !== 'false'; continue; }
    if (v === undefined && OPTIONAL.has(k) && (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))) { o[k] = true; continue; }
    if (v === undefined) { v = argv[++i]; if (v === undefined) throw new UsageError(`--${k} needs a value`); }
    if (MULTI.has(k)) o[k].push(v); else o[k] = v;
  }
  return { pos, o };
}

function usage() {
  return `The company flow from a terminal — the same state as cohorte ui.

  cohorte ticket list [--status S]            the project's tickets
  cohorte ticket show <id>                    a ticket and its feature (phase, checkpoint, stages)
  cohorte ticket create --title T [--body-file F | --need TEXT] [--type tech|bug|feature] [--criteria C]…
        [--value V] [--out-of-scope X]… [--priority high|medium|low] [--size S|M|L|?] [--parent ID]
        [--requester NAME] [--status validate]
                                              straight to the backlog, like "New tech ticket";
                                              --status validate files it for the requester's CP0 (the PO's way)
  cohorte ticket move <id> <status>           validate→backlog|rejected is CP0; anything else moves the card
  cohorte take <ticket> [--yes] [--no-lead]   worktree + feature record (id = ticket id), the lead frames → CP1
                                              --no-lead: the calling session is the lead (/cohorte-lead in Claude Code);
                                              its CP1 approve then needs the spec it froze
  cohorte lead <ticket> --note TEXT           reply to the lead
  cohorte checkpoint <ticket> <action> [--note TEXT]
        CP1 approve | correct (= reply to the lead) | abandon   — approve freezes the spec, starts the autopilot
        CP2 continue | correct | reframe | abandon
        CP3 approve (ships: opens the PR) | correct | abandon
  cohorte autopilot <ticket>                  run build → review → fix → verify here, ask CP2/CP3 and questions here
  cohorte autopilot <ticket> --follow         attach to a detached drive: its log, and its questions asked here
  cohorte autopilot <ticket> --status         where it stands, what it waits for, the drive's last lines
  cohorte merge <ticket>                      merge the PR (gh) → journal → acceptance note (CP4)
  cohorte accept <ticket> ok|not-quite [--note TEXT]   CP4
  cohorte adopt <spec-id>                     a spec from a plain session joins the flow (ticket linked or created)
  cohorte new-project --idea "BRIEF" --name N [--parent DIR] [--requester NAME] [--based-on PATH]
  cohorte new-project --stack --name N [--parent DIR] [--brief TEXT]
  cohorte new-project --existing PATH         found a project: vision → foundations → skeleton → pipeline set-up
  cohorte new-project --resume --project PATH [approve|reply|retry|continue|abandon] [--note TEXT]
        [--identity github | --identity "Name <email>"]   the git identity cohorte commits with, in that repo only

  --project PATH       the project (default: the repo of the current folder; a worktree counts as its repo)
  --json               the result as JSON on stdout (progress goes to stderr)
  --interactive        ask on stdin even when it is not a TTY (scripts); --no-interactive never asks
  --detach             take|lead|checkpoint|autopilot|merge|adopt in the background: returns at once, prints where
                       to follow it; its questions wait for an answer from cohorte ui or --follow
  Exit: 0 nothing waits on you · 2 a checkpoint or the lead waits on you · 3 a question was parked (CP2)
        · 4 another process (cohorte ui, another terminal) is driving this feature · 1 error`;
}

// ---------------------------------------------------------------------------------------------------------------
// The engine

function loadEngine() {
  const dist = path.join(__dirname, '..', 'ui', 'dist-server', 'server');
  if (!fs.existsSync(path.join(dist, 'engine.js'))) {
    throw new Error('the flow engine is not built in this checkout — run `npm run build:ui` here first (the published package ships it built)');
  }
  return { engine: require(path.join(dist, 'engine.js')), tracker: require(path.join(dist, 'tracker.js')), docker: require(path.join(dist, 'docker.js')), history: require(path.join(dist, 'history.js')) };
}

/** The main checkout of the repo `dir` is in — a feature worktree resolves to the project it belongs to. */
function repoOf(dir) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return dir;
  const common = r.stdout.trim();
  return path.basename(common) === '.git' ? path.dirname(common) : dir;
}

// ---------------------------------------------------------------------------------------------------------------
// The terminal: one line reader for the whole command (answers are read in order, from a TTY or a pipe)

function lineReader() {
  const queue = []; let waiter = null; let closed = false; let rl = null;
  const start = () => {
    if (rl) return;
    rl = require('readline').createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
    rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  };
  return {
    /** The next line, or null at EOF — or when `cancel` resolves first (the line then goes to the next prompt). */
    next(cancel) {
      start();
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const w = (l) => resolve(l);
        waiter = w;
        if (cancel) cancel.then((why) => { if (waiter === w) { waiter = null; resolve({ cancelled: why }); } });
      });
    },
    close() { if (rl) rl.close(); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Driving: what a verb started, until the flow rests on a person

const money = (n) => (typeof n === 'number' ? ` · $${n.toFixed(2)}` : '');
const whatOf = (x) => (x.kind === 'question' ? (x.questions || []).map((q) => q.question).join(' · ') : `${x.tool}: ${x.summary || ''}`);
/** Resolves 'changed' once `cond()` holds (polled) — a prompt's cancel when the answer came from elsewhere. */
function until(cond, ms = 250) {
  return new Promise((resolve) => { const t = setInterval(() => { if (cond()) { clearInterval(t); resolve('changed'); } }, ms); t.unref(); });
}

function restOf(f) {
  if (!f) return { code: EXIT.ok, waiting: 'nothing' };
  if (f.checkpoint) return { code: EXIT.waiting, waiting: f.checkpoint.kind, reason: f.checkpoint.reason };
  if (f.phase === 'framing' && f.sessionLead) return { code: EXIT.ok, waiting: 'framing', reason: `framed in your Claude Code session, in ${f.worktree}` };
  if (f.phase === 'framing') return { code: EXIT.waiting, waiting: 'lead', reason: f.error || 'the lead waits for your reply' };
  if (f.phase === 'failed') return { code: EXIT.error, waiting: 'failed', reason: f.error || 'failed' };
  return { code: EXIT.ok, waiting: f.phase };
}

async function drive(ctx, id, { mode }) {
  const { eng, p, out, ask } = ctx;
  const { flow, runs } = eng;
  const seenStages = new Map(); const seenDecisions = new Set(); const cursors = new Map();
  const f0 = flow.features.get(p.id, id);
  for (const s of f0?.stages || []) if (s.status !== 'running') seenStages.set(s.runId, s.status); // the one the verb just started is announced
  for (const d of f0?.decisions || []) seenDecisions.add(d.id);
  // a conversation already under way (a reply just sent) prints from here on, not its earlier turns
  for (const r of runs.runs.values()) if (r.projectId === p.id && r.meta.featureId === id) cursors.set(r.id, r.dropped + r.events.length);
  let kicked = false; let prChecked = false;
  const announced = new Set();

  const report = (f) => {
    for (const s of f.stages) {
      const was = seenStages.get(s.runId);
      if (was === s.status) continue;
      seenStages.set(s.runId, s.status);
      if (s.status === 'running') out.line(`▶ ${s.stage} · ${s.model}${s.note ? ` · ${s.note}` : ''}`);
      else out.line(`${s.status === 'done' ? '✓' : '✗'} ${s.stage} · ${s.status}${money(s.costUsd)}${s.status !== 'done' && s.note ? ` · ${s.note}` : ''}`);
    }
    for (const d of f.decisions) {
      if (seenDecisions.has(d.id)) continue;
      seenDecisions.add(d.id);
      out.line(`  ${d.by === 'decider' ? 'decider' : 'you'}: ${d.question} → ${d.chosen}${d.source && d.source.kind !== 'none' ? ` (${d.source.kind}${d.source.ref ? ` ${d.source.ref}` : ''})` : ''}`);
    }
    // the conversations (lead, acceptance note): their words are the point — streamed as they come
    for (const r of runs.runs.values()) {
      if (r.projectId !== p.id || r.meta.featureId !== id || r.meta.role === 'stage' || !r.child) continue;
      const total = r.dropped + r.events.length;
      const from = cursors.has(r.id) ? cursors.get(r.id) : (r.status === 'running' ? r.dropped : total);
      for (const e of r.events.slice(Math.max(0, from - r.dropped))) if (e.kind === 'text' && !e.sub) out.say(r.meta.role, e.text);
      cursors.set(r.id, total);
    }
  };

  for (;;) {
    const f = flow.features.get(p.id, id);
    if (!f) return { code: EXIT.error, waiting: 'nothing', reason: 'no feature for this ticket' };
    report(f);

    // what a run of ours parked on a person (the decider already passed on it)
    const asked = [];
    for (const r of runs.runs.values()) {
      if (r.projectId !== p.id || r.meta.featureId !== id || !r.child || r.status !== 'running') continue;
      for (const x of r.pending.values()) if (!x.deciding) asked.push([r, x]);
    }
    if (asked.length && ctx.driven) {
      // detached: nobody types here — the question waits on disk for the page or `--follow`
      for (const [r, x] of asked) {
        if (announced.has(x.requestId)) continue;
        announced.add(x.requestId);
        out.line(`? waiting for an answer (${r.meta.stage || r.meta.role}): ${whatOf(x)} — answer it in cohorte ui (inbox), or: cohorte autopilot ${id} --follow`);
      }
    } else if (asked.length) {
      const [r, x] = asked[0];
      const what = whatOf(x);
      if (!ask.interactive) {
        const reason = `a question waits for you (${r.meta.stage || r.meta.role}): ${what} — ${r.meta.role === 'lead' ? `answer it with \`cohorte lead ${id} --note "…"\`` : `run \`cohorte autopilot ${id}\` in a terminal to answer it`}`;
        await flow.park(p.id, id, reason);
        return { code: EXIT.parked, waiting: 'question', reason, question: x.kind === 'question' ? x.questions : what };
      }
      const a = await ask.pending(r, x, until(() => !r.pending.has(x.requestId)));
      if (a && a.cancelled) { out.line('  (answered elsewhere)'); continue; }
      if (a === null) { // stdin ran out mid-question: same as no terminal
        const reason = `a question was left unanswered (${r.meta.stage || r.meta.role}): ${what}`;
        await flow.park(p.id, id, reason);
        return { code: EXIT.parked, waiting: 'question', reason };
      }
      runs.respond(r, x.requestId, a.behavior, a.answers, 'human');
      continue;
    }

    if (flow.active(p.id, id)) { await sleep(80); continue; }

    // nothing of ours in flight: where does it rest?
    if (flow.drivenElsewhere(f)) return { code: EXIT.elsewhere, waiting: 'elsewhere', reason: `driven by ${f.driver.by === 'ui' ? 'cohorte ui' : 'another terminal'} (pid ${f.driver.pid})` };
    if (mode === 'autopilot') {
      if (f.phase === 'autopilot' && !kicked) { kicked = true; await flow.advance(flow.project(p.id), f); continue; }
      if (f.phase === 'pr' && !prChecked) { prChecked = true; await flow.checkPR(p.id, id); continue; }
      if (f.checkpoint && ask.interactive) {
        const c = await ask.checkpoint(f);
        if (c === null) return restOf(flow.features.get(p.id, id));
        if (c.cancelled) { out.line(`  (answered elsewhere — the feature is now ${flow.features.get(p.id, id).phase})`); kicked = false; continue; }
        try { flow.checkpoint(p.id, id, { action: c.action, text: c.text }); } catch (e) { out.line(`  ${e.message}`); }
        kicked = false; prChecked = false;
        continue;
      }
    }
    return restOf(f);
  }
}

function asker(reader, out, interactive, flow, p) {
  const prompt = (text) => out.prompt(text);
  return {
    interactive,
    /** A parked question or permission ask, asked here. {cancelled} when `cancel` resolves first (answered elsewhere). */
    async pending(r, x, cancel) {
      if (x.kind === 'permission') {
        prompt(`\n? ${r.meta.stage || r.meta.role} asks to run ${x.tool}: ${x.summary || ''}${x.reason ? `\n  (${x.reason})` : ''}\n  allow? [y/N] `);
        const l = await reader.next(cancel);
        if (l === null) return null;
        if (typeof l === 'object') return l;
        return { behavior: /^y(es)?$/i.test(l.trim()) ? 'allow' : 'deny', answers: {} };
      }
      const answers = {};
      for (const q of x.questions || []) {
        prompt(`\n? [${r.meta.stage || r.meta.role}] ${q.header ? `${q.header} · ` : ''}${q.question}\n`
          + q.options.map((o, i) => `  ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
          + (x.advice ? `\n  the decider would pick: ${x.advice.choice || '(nothing)'} — handed to you: ${x.advice.escalated}` : '')
          + `\n  answer [1-${q.options.length}${q.multiSelect ? ', comma-separated' : ''}, or your own words]: `);
        const l = await reader.next(cancel);
        if (l === null) return null;
        if (typeof l === 'object') return l;
        const picks = l.split(q.multiSelect ? ',' : /$^/).map((s) => s.trim()).filter(Boolean)
          .map((s) => (/^\d+$/.test(s) && q.options[Number(s) - 1] ? q.options[Number(s) - 1].label : s));
        answers[q.question] = q.multiSelect ? picks : (picks[0] || '');
      }
      return { behavior: 'allow', answers };
    },
    /** The open checkpoint, asked here; resolves {cancelled} when it is answered elsewhere (the page) meanwhile. */
    async checkpoint(f) {
      const cp = f.checkpoint;
      const actions = cp.kind === 'cp1' ? ['approve', 'correct', 'abandon'] : cp.kind === 'cp2' ? ['continue', 'correct', 'reframe', 'abandon'] : ['approve', 'correct', 'abandon'];
      const lines = [`\n■ ${cp.kind.toUpperCase()} · ${cp.reason}`];
      if (cp.kind === 'cp1' && f.plan) lines.push(`  plan: ${f.plan.summary}`, ...f.plan.criteria.map((c) => `    ${c.id} ${c.text}`));
      if (cp.kind === 'cp3') {
        const by = f.decisions.filter((d) => d.by === 'decider' && !d.contested);
        if (by.length) lines.push('  decided on your behalf (shipping confirms them):', ...by.map((d) => `    ${d.question} → ${d.chosen}`));
      }
      lines.push(`  ${actions.join(' | ')} [note]: `);
      prompt(lines.join('\n'));
      const stamp = `${cp.kind}|${cp.openedAt}`;
      let stop = false;
      const elsewhere = (async () => {
        while (!stop) {
          await sleep(300);
          const g = flow.features.get(p.id, f.id);
          if (!g || `${g.checkpoint?.kind}|${g.checkpoint?.openedAt}` !== stamp) return 'changed';
        }
        return null;
      })();
      for (;;) {
        const l = await reader.next(elsewhere);
        if (l === null) { stop = true; return null; }
        if (typeof l === 'object') { stop = true; return l; }
        const m = l.trim().match(/^(\S+)\s*([\s\S]*)$/);
        let action = m && m[1].toLowerCase();
        if (action && !actions.includes(action)) { prompt(`  one of: ${actions.join(', ')} — `); continue; }
        if (!action) { prompt(`  one of: ${actions.join(', ')} — `); continue; }
        if (cp.kind === 'cp1' && action === 'correct') action = 'reply';
        stop = true;
        return { action, text: m[2] || '' };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The verbs

function ticketLine(t, f) {
  return `${t.id.padEnd(32)} ${t.status.padEnd(10)} ${t.type.padEnd(7)} ${t.title}${f ? `  [${f.phase}${f.checkpoint ? ` · ${f.checkpoint.kind}` : ''}]` : ''}`;
}

function ticketText(t, f) {
  const L = [`${t.id} — ${t.title}`, `  ${t.status} · ${t.type} · priority ${t.priority} · size ${t.size}${t.requester ? ` · ${t.requester}` : ''}${t.pr ? ` · PR ${t.pr}` : ''}`];
  if (t.need) L.push('', '  Need:', ...t.need.split('\n').map((x) => `    ${x}`));
  if (t.criteria.length) L.push('', '  Acceptance criteria:', ...t.criteria.map((c, i) => `    C${i + 1} ${c}`));
  if (t.acceptance) L.push('', `  Acceptance note: ${t.acceptance.summary}`);
  if (f) {
    L.push('', `  Feature: ${f.phase}${f.checkpoint ? ` · ${f.checkpoint.kind.toUpperCase()}: ${f.checkpoint.reason}` : ''}${f.worktree ? ` · ${f.worktree}` : ''}`);
    if (f.driver) L.push(`  driven by ${f.driver.by} (pid ${f.driver.pid})`);
    for (const s of f.stages) L.push(`    ${s.stage.padEnd(10)} ${s.status.padEnd(8)} ${s.model}${money(s.costUsd)}`);
    if (f.error) L.push(`  error: ${f.error}`);
  }
  return L.join('\n');
}

const NEXT = {
  cp1: (id) => `cohorte checkpoint ${id} approve   (or correct --note "…", abandon)`,
  cp2: (id) => `cohorte autopilot ${id}   (or cohorte checkpoint ${id} continue|correct|reframe|abandon)`,
  cp3: (id) => `cohorte checkpoint ${id} approve   (ships: opens the PR — or correct --note "…", abandon)`,
  lead: (id) => `cohorte lead ${id} --note "…"`,
  question: (id) => `cohorte autopilot ${id}   (in a terminal, to answer it)`,
  pr: (id) => `merge the PR, or: cohorte merge ${id}   (then cohorte autopilot ${id} picks the merge up)`,
  acceptance: (id) => `the requester: cohorte accept ${id} ok|not-quite --note "…"`,
  framing: (id) => `once the developer approves the frozen spec: cohorte checkpoint ${id} approve --detach`,
  elsewhere: (id) => `cohorte autopilot ${id} --follow   (or answer in cohorte ui)`,
};

async function run(argv, globalDir) {
  const { pos, o } = parse(argv);
  const verb = pos.shift();
  if (!verb || o.help) { console.log(usage()); return EXIT.ok; }
  const json = o.json === true;
  const driven = o.driven === true; // the background half of --detach
  const interactive = driven || o['no-interactive'] ? false : o.interactive === true || !!process.stdin.isTTY;
  const err = (s) => process.stderr.write(`${s}\n`);
  const out = {
    line: (s) => (json ? err(s) : console.log(s)),
    say: (who, text) => (json ? err : console.log)(`\n${who}: ${text.trim().replace(/\n/g, '\n  ')}\n`),
    prompt: (s) => (json ? process.stderr : process.stdout).write(s),
    result: (obj, human) => { if (json) console.log(JSON.stringify(obj, null, 2)); else if (human) console.log(human); },
  };

  const { engine, tracker, docker, history } = loadEngine();
  const registry = require('../lib/registry.js');
  const eng = engine.createEngine({ globalDir, by: 'cli' });
  const { flow } = eng;
  const reader = lineReader();
  if (verb === 'new-project') return newProject({ o, pos, eng, out, reader, interactive, registry, tracker, globalDir });
  const root = repoOf(path.resolve(o.project || process.cwd()));
  const p = registry.add(globalDir, root).project; // idempotent; refuses a repo without cohorte
  const ask = asker(reader, out, interactive, flow, p);
  const ctx = { eng, p, out, ask, driven };
  const drives = path.join(eng.dataDir, 'drives', p.id);

  const finish = async (code) => {
    reader.close();
    await tracker.settleMoves();
    eng.runs.flush();
    return code;
  };
  /** A ticket — or, for adopt, a spec id that may have no ticket yet. */
  const mustTicketOrSpec = (id) => (verb === 'adopt' ? (tracker.isTicketId(id) || (() => { throw new UsageError('a spec id is required'); })()) : mustTicket(id));
  const mustTicket = (id) => {
    if (!tracker.isTicketId(id)) throw new UsageError('a ticket id is required');
    const t = flow.tracker(flow.project(p.id)).get(id);
    if (!t) throw new Error(`no ticket ${id} in ${p.root}`);
    return t;
  };
  /** Drives, then reports where the flow rests and what to type next. */
  const settle = async (id, mode, extra = {}) => {
    let stopping = false;
    const onInt = () => {
      if (stopping) process.exit(130);
      stopping = true;
      out.line('\n(stopping — Ctrl-C again to quit at once)');
      flow.park(p.id, id, 'stopped from the terminal — continue to resume').then(() => finish(130)).then((c) => process.exit(c), () => process.exit(130));
    };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onInt);
    let rest;
    try { rest = await drive(ctx, id, { mode }); } finally { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onInt); }
    if (driven) { try { fs.rmSync(path.join(drives, `${id}.json`), { force: true }); } catch { /* gone */ } }
    const t = flow.tracker(flow.project(p.id)).get(id);
    const f = flow.features.get(p.id, id);
    const next = NEXT[rest.waiting] ? NEXT[rest.waiting](id) : null;
    out.result({ ...extra, rest, next, ticket: t, feature: f },
      `\n${rest.waiting === 'nothing' ? 'done' : `→ ${rest.waiting}`}${rest.reason ? ` · ${rest.reason}` : ''}${next ? `\n  next: ${next}` : ''}`);
    return finish(rest.code);
  };

  if (verb === 'ticket') {
    const sub = pos.shift();
    const tr = flow.tracker(flow.project(p.id));
    if (sub === 'list' || !sub) {
      const ts = tr.list().filter((t) => typeof o.status !== 'string' || t.status === o.status);
      const adoptable = flow.adoptable(p.id);
      const human = [ts.length ? ts.map((t) => ticketLine(t, flow.features.get(p.id, t.id))).join('\n') : `no tickets (${tr.info.kind === 'local' ? tr.info.dir : tr.info.board})`];
      if (adoptable.length) human.push('', 'Started in a Claude Code session (no feature here yet — cohorte adopt <id>):', ...adoptable.map((a) => `  ${a.id.padEnd(30)} ${String(a.status).padEnd(8)} ${a.title}${a.worktree ? '' : '  (main checkout)'}`));
      out.result({ project: p.root, tracker: tr.info, tickets: ts.map((t) => ({ ...t, feature: flow.features.get(p.id, t.id) })), adoptable }, human.join('\n'));
      return finish(EXIT.ok);
    }
    if (sub === 'show') {
      const t = mustTicket(pos[0]);
      const f = flow.features.get(p.id, t.id);
      out.result({ ticket: t, feature: f }, ticketText(t, f));
      return finish(EXIT.ok);
    }
    if (sub === 'create') {
      let need = o.need || '';
      if (o['body-file']) need = fs.readFileSync(o['body-file'] === '-' ? 0 : path.resolve(o['body-file']), 'utf8');
      if (o.status && !['validate', 'backlog'].includes(o.status)) throw new UsageError('a new ticket goes to validate (CP0) or backlog');
      const t = flow.createTicket(p.id, { title: o.title, type: o.type, need, value: o.value, criteria: o.criteria, outOfScope: o['out-of-scope'],
        priority: o.priority, size: o.size, parent: o.parent, requester: o.requester, status: o.status });
      out.result({ ticket: t }, `${t.id} — ${t.title} (${t.status})\n  next: ${t.status === 'validate' ? `the requester validates it (cohorte ui, or cohorte ticket move ${t.id} backlog)` : `cohorte take ${t.id}`}`);
      return finish(EXIT.ok);
    }
    if (sub === 'move') {
      const t = mustTicket(pos[0]);
      const to = pos[1];
      if (!tracker.STATUSES.includes(to)) throw new UsageError(`the status must be one of ${tracker.STATUSES.join(', ')}`);
      let next;
      if (['discussion', 'validate'].includes(t.status) && ['backlog', 'rejected'].includes(to)) {
        next = flow.decideTicket(p.id, t.id, to === 'backlog' ? 'validate' : 'reject'); // CP0, as the page decides it
      } else {
        const f = flow.features.get(p.id, t.id);
        if (f && flow.drivenElsewhere(f)) throw new Error(`${t.id} is being driven by ${f.driver.by} (pid ${f.driver.pid}) — not moved`);
        next = tr.update(t.id, { status: to });
        await tr.move(next);
      }
      out.result({ ticket: next }, `${next.id}: ${t.status} → ${next.status}`);
      return finish(EXIT.ok);
    }
    throw new UsageError(`unknown: cohorte ticket ${sub}`);
  }

  const id = pos.shift();
  if (o.detach && DRIVING.includes(verb)) {
    mustTicketOrSpec(id);
    return finish(await detach({ argv, id, p, eng, out, drives, history }));
  }
  if (verb === 'autopilot' && (o.follow || o.status)) {
    mustTicket(id);
    flow.mustFeature(p.id, id);
    return finish(o.status ? status({ id, p, eng, out, drives, history }) : await follow({ id, p, eng, out, ask, drives, history }));
  }
  if (verb === 'adopt') {
    if (!tracker.isTicketId(id)) throw new UsageError('a spec id is required: cohorte adopt <id>');
    const f = await flow.adopt(p.id, id);
    out.line(`adopted ${id} · ${f.phase}${f.checkpoint ? ` · ${f.checkpoint.reason}` : ''}`);
    return settle(id, 'once');
  }
  if (verb === 'take') {
    mustTicket(id);
    if (!o['skip-docker-check'] && !flow.features.get(p.id, id)) {
      const pre = await docker.preflight(p.root);
      if (pre && !pre.ok) throw new Error(`${pre.reason} (--skip-docker-check to take it anyway)`);
    }
    let confirmed = o.yes === true;
    for (;;) {
      try { flow.take(p.id, id, { confirmed, lead: !o['no-lead'] }); break; } catch (e) {
        if (!e.needsConfirmation || confirmed) throw e;
        if (!interactive) throw new Error(`${e.message} — the gate asks before \`${e.command}\`: re-run with --yes to confirm`);
        out.prompt(`the gate asks before \`${e.command}\`${e.reason ? ` (${e.reason})` : ''} — run it? [y/N] `);
        const l = await reader.next();
        if (!l || !/^y(es)?$/i.test(l.trim())) throw new Error('not confirmed — nothing was taken');
        confirmed = true;
      }
    }
    out.line(o['no-lead'] ? `taking ${id} — its worktree, for the lead of this session` : `taking ${id} — worktree, then the lead frames it`);
    return settle(id, 'once');
  }
  if (verb === 'lead') {
    mustTicket(id);
    if (!o.note) throw new UsageError('--note is the reply to the lead');
    flow.replyLead(p.id, id, o.note);
    return settle(id, 'once');
  }
  if (verb === 'checkpoint') {
    mustTicket(id);
    let action = pos.shift();
    const f = flow.mustFeature(p.id, id);
    if (!action) throw new UsageError('an action is required: approve, correct, continue, reframe or abandon');
    const cp = f.checkpoint?.kind || (f.sessionLead && ['framing', 'cp1'].includes(f.phase) ? 'cp1' : null);
    if (cp === 'cp1' && action === 'correct') action = 'reply'; // CP1's "correct" is a reply to the lead
    flow.checkpoint(p.id, id, { action, text: o.note });
    out.line(`${cp ? cp.toUpperCase() : f.phase} · ${action}${cp === 'cp1' && action === 'approve' ? ' — the lead freezes the spec, then the autopilot runs' : ''}`);
    // what hands over to the autopilot is followed as `cohorte autopilot` would; a lead conversation, to its turn's end
    return settle(id, ['reply', 'reframe', 'abandon'].includes(action) ? 'once' : 'autopilot');
  }
  if (verb === 'autopilot') {
    mustTicket(id);
    flow.mustFeature(p.id, id);
    return settle(id, 'autopilot');
  }
  if (verb === 'merge') {
    mustTicket(id);
    flow.merge(p.id, id);
    out.line(`merging ${id}`);
    return settle(id, 'once');
  }
  if (verb === 'accept') {
    mustTicket(id);
    const a = pos.shift();
    const action = a === 'ok' || a === 'accept' ? 'accept' : a === 'not-quite' ? 'not-quite' : null;
    if (!action) throw new UsageError('accept takes ok or not-quite');
    const r = flow.acceptance(p.id, id, { action, text: o.note });
    if (r.run) { // the follow-up PO conversation: its first turn, here
      while (r.run.status === 'running') await sleep(80);
      await flow.idle(p.id, id); // its end hook files the tickets it proposed
      for (const e of r.run.events) if (e.kind === 'text' && !e.sub) out.say('po', e.text);
    }
    out.result({ ticket: flow.tracker(flow.project(p.id)).get(id), run: r.run ? eng.runs.view(r.run) : null },
      `${id}: ${r.ticket.status}${r.run ? `\n  a follow-up conversation started with the PO (run ${r.run.id}) — continue it in cohorte ui` : ''}`);
    return finish(EXIT.ok);
  }
  throw new UsageError(`unknown verb: ${verb}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Detached drives: one background process per feature, its log, and the ways back to it

/** Starts the same verb as `--driven` in a background process; returns once it holds the feature (or ended). */
async function detach({ argv, id, p, eng, out, drives, history }) {
  fs.mkdirSync(drives, { recursive: true });
  const log = path.join(drives, `${id}.log`);
  const info = path.join(drives, `${id}.json`);
  const prev = readJson(info);
  if (prev && history.alive(prev.pid) && prev.pid !== process.pid) throw new Error(`a detached drive of ${id} is already running (pid ${prev.pid}) — cohorte autopilot ${id} --follow`);
  const args = argv.filter((a) => a !== '--detach' && a !== '--json' && a !== '--interactive');
  fs.writeFileSync(log, `# cohorte ${args.join(' ')} — ${new Date().toISOString()}\n`);
  const fd = fs.openSync(log, 'a');
  const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'cli.js'), ...args, '--driven', '--project', p.root],
    { detached: true, stdio: ['ignore', fd, fd], env: process.env, cwd: p.root });
  fs.closeSync(fd);
  let exited = null;
  child.on('exit', (code) => { exited = code == null ? 1 : code; });
  child.unref();
  fs.writeFileSync(info, JSON.stringify({ pid: child.pid, log, args, startedAt: new Date().toISOString() }, null, 2));
  // it is under way once it holds the lease; a verb with nothing to run (a checkpoint already open) just ends
  const end = Date.now() + 20000;
  while (exited === null && Date.now() < end && eng.flow.features.get(p.id, id)?.driver?.pid !== child.pid) await sleep(100);
  const rel = (s) => s.replace(os.homedir(), '~');
  if (exited !== null) {
    out.line(fs.readFileSync(log, 'utf8').split('\n').slice(1).join('\n').trim());
    out.result({ detached: null, exitCode: exited, log, feature: eng.flow.features.get(p.id, id) }, null);
    return exited;
  }
  out.result({ detached: { pid: child.pid, log }, feature: eng.flow.features.get(p.id, id), next: `cohorte autopilot ${id} --follow` },
    `running in the background (pid ${child.pid}) — its log: ${rel(log)}\n  follow it here: cohorte autopilot ${id} --follow   (its questions are asked there, and in cohorte ui's inbox)\n  or open cohorte ui: the feature shows it as driven from a terminal`);
  return EXIT.ok;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** The questions a run of the feature parked, in whichever process drives it (read from the run files). */
function parked(eng, p, id) {
  const outq = [];
  for (const r of eng.runs.forProject(p.id)) {
    if (r.meta.featureId !== id || r.status !== 'running') continue;
    for (const x of r.pending.values()) if (!x.deciding) outq.push([r, x]);
  }
  return outq;
}

function status({ id, p, eng, out, drives, history }) {
  const f = eng.flow.features.get(p.id, id);
  const t = eng.flow.tracker(eng.flow.project(p.id)).get(id);
  const info = readJson(path.join(drives, `${id}.json`));
  const live = info && history.alive(info.pid);
  const qs = parked(eng, p, id).map(([r, x]) => ({ run: r.id, stage: r.meta.stage || r.meta.role, requestId: x.requestId, kind: x.kind, what: whatOf(x), questions: x.questions || null }));
  const tail = info ? (() => { try { return fs.readFileSync(info.log, 'utf8').trim().split('\n').slice(-15); } catch { return []; } })() : [];
  const lines = [ticketText(t, f)];
  if (qs.length) lines.push('', 'Waiting for an answer:', ...qs.map((q) => `  ? (${q.stage}) ${q.what}`), `  answer: cohorte autopilot ${id} --follow, or cohorte ui's inbox`);
  if (info) lines.push('', `Detached drive: ${live ? `running (pid ${info.pid})` : 'ended'} — ${info.log}`, ...tail.map((l) => `  | ${l}`));
  out.result({ ticket: t, feature: f, waiting: qs, drive: info ? { ...info, running: !!live, tail } : null, rest: restOf(f) }, lines.join('\n'));
  return EXIT.ok;
}

/** Attaches to a detached drive: prints its log as it grows and asks its parked questions here, until it ends. */
async function follow({ id, p, eng, out, ask, drives, history }) {
  const info = readJson(path.join(drives, `${id}.json`));
  let pos = 0;
  const flush = () => {
    if (!info) return;
    try {
      const buf = fs.readFileSync(info.log);
      if (buf.length > pos) { out.prompt(buf.subarray(pos).toString("utf8")); pos = buf.length; } // stderr under --json
    } catch { /* not yet */ }
  };
  if (!info || !history.alive(info.pid)) {
    flush();
    out.line(info ? '(the detached drive has ended)' : `no detached drive of ${id} — start one with: cohorte autopilot ${id} --detach`);
  }
  const told = new Set();
  while (info && history.alive(info.pid)) {
    flush();
    const qs = parked(eng, p, id);
    if (qs.length) {
      const [r, x] = qs[0];
      if (ask.interactive) {
        const a = await ask.pending(r, x, until(() => !parked(eng, p, id).some(([, y]) => y.requestId === x.requestId)));
        if (a && a.cancelled) out.line('  (answered elsewhere)');
        else if (a === null) break;
        else eng.runs.respond(r, x.requestId, a.behavior, a.answers, 'human'); // another process's run: the answer goes through the store
      } else if (!told.has(x.requestId)) { told.add(x.requestId); out.line(`? waiting for an answer: ${whatOf(x)}`); }
    }
    await sleep(300);
  }
  await sleep(200);
  flush();
  const f = eng.flow.features.get(p.id, id);
  const rest = restOf(f);
  const next = NEXT[rest.waiting] ? NEXT[rest.waiting](id) : null;
  out.result({ rest, next, feature: f }, `\n→ ${rest.waiting}${rest.reason ? ` · ${rest.reason}` : ''}${next ? `\n  next: ${next}` : ''}`);
  return rest.code;
}

// ---------------------------------------------------------------------------------------------------------------
// New project — the page's Founding, from a terminal: the same FoundingFlow, its checkpoints asked here

async function newProject({ o, pos, eng, out, reader, interactive, registry, tracker, globalDir }) {
  const { flow, runs } = eng;
  const fd = flow.founding;
  let projectId;
  if (o.resume) {
    const root = repoOf(path.resolve(o.project || process.cwd()));
    projectId = registry.add(globalDir, root, { founding: true }).project.id;
    if (!fd.store.get(projectId)) throw new Error(`${root} is not being founded — start with cohorte new-project --idea|--stack|--existing`);
  } else {
    const mode = o.existing ? 'existing' : o.stack ? 'stack' : o.idea ? 'idea' : null;
    if (!mode) throw new UsageError('new-project takes --idea "BRIEF", --stack or --existing PATH (or --resume)');
    const brief = typeof o.idea === 'string' ? o.idea : o.brief || (mode === 'idea' ? pos.join(' ') : '');
    // --based-on: an existing project whose stack and conventions the lead starts from, as the page's "start from"
    const basedOn = o['based-on'] ? registry.add(globalDir, repoOf(path.resolve(o['based-on']))).project.id : null;
    const r = await fd.create({ mode, name: o.name, parent: path.resolve(o.parent || process.cwd()), path: typeof o.existing === 'string' ? path.resolve(o.existing) : undefined, brief, requester: o.requester, basedOn });
    projectId = r.project.id;
    out.line(`founding ${r.project.root} (${mode})`);
  }
  if (o.identity) await setIdentity(fd, projectId, o.identity);
  const action = o.resume ? pos.shift() : null;
  if (action) await fd.checkpoint(projectId, { action, text: o.note });

  const cursors = new Map();
  for (const r of runs.runs.values()) if (r.projectId === projectId) cursors.set(r.id, r.dropped + r.events.length);
  const busy = () => flow.activeProject(projectId);
  for (;;) {
    for (const r of runs.runs.values()) {
      if (r.projectId !== projectId || !r.child) continue;
      const total = r.dropped + r.events.length;
      const from = cursors.has(r.id) ? cursors.get(r.id) : r.dropped;
      for (const e of r.events.slice(Math.max(0, from - r.dropped))) if (e.kind === 'text' && !e.sub) out.say(r.meta.role, e.text);
      cursors.set(r.id, total);
      for (const x of r.status === 'running' ? r.pending.values() : []) {
        if (!interactive) { runs.stop(r); out.line(`? ${whatOf(x)} — no terminal to answer: stopped (cohorte new-project --resume in a terminal)`); break; }
        const a = await asker(reader, out, true, flow, { id: projectId }).pending(r, x);
        if (a === null) { runs.stop(r); break; }
        runs.respond(r, x.requestId, a.behavior, a.answers, 'human');
      }
    }
    if (busy()) { await sleep(100); continue; }
    const v = fd.view(projectId);
    const ph = v.phase;
    if (ph === 'done' || ph === 'abandoned') {
      const done = ph === 'done';
      out.result({ founding: v }, done ? `\n✓ ${v.root} is a cohorte project${v.warning ? `\n  ! ${v.warning}` : ''}\n  next: cohorte ticket list --project ${v.root}` : '\nabandoned');
      await tracker.settleMoves();
      runs.flush();
      return EXIT.ok;
    }
    const prompts = {
      vision: ['reply', 'abandon'], foundation: ['reply', 'abandon'], setup: ['retry', 'reply', 'abandon'], scaffold: ['reply', 'abandon'],
      'cp-vision': ['approve', 'reply', 'abandon'], 'cp-foundation': ['approve', 'reply', 'abandon'], 'cp-scaffold': ['retry', 'continue', 'reply', 'abandon'],
    }[ph] || ['abandon'];
    const lines = [`\n■ ${ph}${v.error ? ` · ${v.error}` : ''}`];
    if (ph === 'cp-vision' && v.vision) lines.push(`  ${v.vision.pitch}`, ...v.tickets.map((t) => `    ticket: ${t.title}`));
    if (ph === 'cp-foundation' && v.foundation) lines.push(`  ${v.foundation.summary}`, ...v.foundation.surfaces.map((s) => `    ${s.key}: ${s.stack} (${s.generate})`));
    const needsId = ['cp-foundation', 'cp-scaffold'].includes(ph) && v.identity && v.identity.status !== 'ok';
    if (needsId) lines.push(`  ! git identity: ${v.identity.reason} — cohorte commits here: set it first (github, or Name <email>)`);
    if (!interactive) {
      out.result({ founding: v, waiting: ph }, `${lines.join('\n')}\n  next: cohorte new-project --resume --project ${v.root} ${prompts[0]}${needsId ? ' --identity github' : ''}`);
      runs.flush();
      return EXIT.waiting;
    }
    if (needsId) {
      out.prompt(`${lines.join('\n')}\n  identity [github | Name <email>]: `);
      const l = await reader.next();
      if (l === null) { runs.flush(); return EXIT.waiting; }
      try { await setIdentity(fd, projectId, l.trim()); } catch (e) { out.line(`  ${e.message}`); }
      continue;
    }
    out.prompt(`${lines.join('\n')}\n  ${prompts.join(' | ')} [text]: `);
    const l = await reader.next();
    if (l === null) { runs.flush(); return EXIT.waiting; }
    const m = l.trim().match(/^(\S+)\s*([\s\S]*)$/);
    if (!m || !prompts.includes(m[1])) { out.line(`  one of: ${prompts.join(', ')}`); continue; }
    try { await fd.checkpoint(projectId, { action: m[1], text: m[2] }); } catch (e) { out.line(`  ${e.message}`); }
  }
}

/** `github` (the signed-in gh account) or `Name <email>` — git config in that repository only, as the page sets it. */
async function setIdentity(fd, projectId, spec) {
  if (spec === 'github') return fd.setIdentity(projectId, { source: 'github' });
  const m = String(spec).match(/^(.+?)\s*<([^>]+)>$/);
  if (!m) throw new UsageError('--identity is github or "Name <email>"');
  return fd.setIdentity(projectId, { source: 'manual', name: m[1].trim(), email: m[2].trim() });
}

async function main(argv, globalDir) {
  try {
    return await run(argv, globalDir);
  } catch (e) {
    process.stderr.write(`error: ${e && e.message ? e.message : e}\n`);
    if (e instanceof UsageError) process.stderr.write('\n' + usage() + '\n');
    return e && e.code === 409 && /being driven by/.test(e.message) ? EXIT.elsewhere : EXIT.error;
  }
}

module.exports = { main, VERBS, usage, EXIT };
