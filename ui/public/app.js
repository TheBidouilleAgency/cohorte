'use strict';
// Every string from a project (titles, check details, reports) goes in through textContent.
const app = document.getElementById('app');
let token = null;
try {
  const m = /token=([0-9a-f]+)/.exec(location.hash);
  if (m) { sessionStorage.setItem('cohorte-token', m[1]); history.replaceState(null, '', location.pathname); }
  token = sessionStorage.getItem('cohorte-token');
} catch { /* storage blocked */ }

const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.data = data; err.needs = data.needsConfirmation === true; err.command = data.command; err.reason = data.reason; throw err; }
  return data;
}

const S = { docker: null, preflight: null, form: null, run: null, commands: null, job: null, projects: [], suggestions: [], sel: null, tab: 'overview', detail: null, spec: null, metrics: null, error: null, busy: false };
const tone = (s) => (s && s.error ? 'bad' : !s || s.missing ? 'bad' : s.summary.bad ? 'bad' : s.summary.warn ? 'warn' : 'ok');
const STATUS_TONE = { shipped: 'ok', merged: 'ok', blocked: 'bad', abandoned: 'warn' };
const usd = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '–');
const num = (n) => (typeof n === 'number' ? n.toLocaleString() : '–');

async function refresh() {
  const [st, dis] = await Promise.all([api('/state'), api('/discover')]);
  S.projects = st.projects; S.version = st.version; S.suggestions = dis.suggestions;
  if (S.sel && !S.projects.some((p) => p.id === S.sel)) S.sel = null;
  if (!S.sel && S.projects.length) S.sel = S.projects[0].id;
}
async function loadDetail() {
  S.detail = null; S.spec = null; S.metrics = null;
  if (!S.sel) return;
  try { S.detail = await api(`/projects/${S.sel}`); S.error = null; } catch (e) { S.error = e.message; }
}
async function guard(fn) {
  S.busy = true; render();
  try { await fn(); S.error = null; } catch (e) { S.error = e.message; }
  S.busy = false; render();
}
const select = (id) => guard(async () => { S.sel = id; S.tab = 'overview'; S.job = null; S.docker = null; S.preflight = null; S.run = null; S.form = null; await loadDetail(); });
const addProject = (path) => guard(async () => {
  const r = await api('/projects', { method: 'POST', body: { path } });
  await refresh(); S.sel = r.project.id; S.tab = 'overview'; S.docker = null; await loadDetail();
});
const removeProject = (id) => guard(async () => { await api(`/projects/${id}`, { method: 'DELETE' }); S.sel = null; S.detail = null; await refresh(); await loadDetail(); });
const openSpec = (id) => guard(async () => { S.spec = await api(`/projects/${S.sel}/specs/${encodeURIComponent(id)}`); });
const setTab = (t) => guard(async () => {
  S.tab = t; S.spec = null; clearTimeout(dockerTimer);
  if (t === 'docker') { await loadDocker(); pollDocker(); }
  if (t === 'run' && !S.commands) { try { S.commands = (await api('/commands')).commands; } catch { S.commands = []; } }
  if (t === 'cost' && !S.metrics) { try { S.metrics = await api(`/projects/${S.sel}/metrics`); } catch (e) { S.metrics = { error: e.message }; } }
});

function sidebar() {
  const input = h('input', { placeholder: '/path/to/project', 'aria-label': 'Project path' });
  return h('aside', {},
    h('h1', {}, 'Cohorte ', h('span', { class: 'mute mono' }, S.version ? `v${S.version}` : '')),
    h('form', { class: 'add', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) addProject(input.value.trim()); } },
      input, h('button', { class: 'b', type: 'submit' }, 'Add')),
    S.projects.map((p) => h('button', { class: `proj${p.id === S.sel ? ' sel' : ''}`, onclick: () => select(p.id) },
      h('div', { class: 'n' }, h('span', { class: `dot ${tone(p)}` }), p.title || p.name),
      h('div', { class: 'mute mono' }, p.missing ? 'folder missing' : `${p.specTotal || 0} specs`))),
    S.suggestions.length ? h('h3', {}, 'Found on this machine') : null,
    S.suggestions.map((s) => h('div', { class: 'sug' },
      h('span', {}, h('div', {}, s.name), h('div', { class: 'mute mono' }, s.root)),
      h('button', { class: 'b', onclick: () => addProject(s.root) }, 'Add'))));
}

function health(d) {
  const s = d.doctor.summary;
  return h('div', {},
    h('div', { class: 'cards' }, ['ok', 'warn', 'bad', 'skip'].map((k) => h('div', { class: 'card' }, h('div', { class: 'v' }, s[k]), h('div', { class: 'mute' }, k)))),
    h('h3', {}, 'Checks'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Check'), h('th', {}, 'Status'), h('th', {}, 'Detail'))),
      h('tbody', {}, d.doctor.checks.map((c) => h('tr', {},
        h('td', {}, c.label),
        h('td', {}, h('span', { class: `pill ${c.status}` }, c.status)),
        h('td', {}, c.detail, c.fix ? h('div', { class: 'fix' }, `fix: ${c.fix}`) : null))))));
}

function specs(d) {
  if (S.spec) {
    const r = S.spec.reports;
    return h('div', {},
      h('button', { class: 'b', onclick: () => { S.spec = null; render(); } }, '← Specs'),
      h('h2', { style: 'margin-top:12px' }, S.spec.spec.title || S.spec.spec.id),
      h('div', { class: 'mute mono' }, `${S.spec.spec.id} · ${S.spec.spec.status || 'unknown'}${S.spec.spec.branch ? ` · ${S.spec.spec.branch}` : ''}`),
      Object.entries(r).filter(([, v]) => v).map(([k, v]) => [h('h3', {}, k), h('pre', {}, JSON.stringify(v, null, 2))]),
      h('h3', {}, 'Spec'), h('pre', {}, S.spec.body));
  }
  if (!d.specs.length) return h('div', { class: 'empty' }, 'No specs yet. Run /cohorte-brainstorm in Claude Code.');
  return h('table', {}, h('thead', {}, h('tr', {}, ['Spec', 'Title', 'Status', 'Branch'].map((t) => h('th', {}, t)))),
    h('tbody', {}, d.specs.map((s) => h('tr', { class: 'click', onclick: () => openSpec(s.id) },
      h('td', { class: 'mono' }, s.id), h('td', {}, s.title),
      h('td', {}, h('span', { class: `pill ${STATUS_TONE[s.status] || (s.tone === 'warn' ? 'warn' : '')}` }, s.status)),
      h('td', { class: 'mono' }, s.branch)))));
}

function cost() {
  const m = S.metrics;
  if (!m) return h('div', { class: 'empty' }, 'Loading…');
  if (m.error) return h('div', { class: 'err' }, m.error);
  const t = m.totals || {};
  return h('div', {},
    h('div', { class: 'cards' },
      [['Total', usd(t.cost)], ['Runs', num(t.runs)], ['Sessions', num(t.sessions)], ['Subagents', num(t.agents)]]
        .map(([l, v]) => h('div', { class: 'card' }, h('div', { class: 'v' }, v), h('div', { class: 'mute' }, l)))),
    h('h3', {}, 'By command (last 30 days)'),
    h('table', {}, h('thead', {}, h('tr', {}, ['Command', 'Runs', 'Cost'].map((x) => h('th', {}, x)))),
      h('tbody', {}, (m.commands || []).map((c) => h('tr', {}, h('td', { class: 'mono' }, c.command), h('td', {}, num(c.runs)),
        h('td', {}, usd(c.cost && typeof c.cost === 'object' ? c.cost.total : c.cost)))))));
}

// --- jobs: worktree provisioning and dev servers ---------------------------------
let pollTimer = null;
const LIVE = ['starting', 'running', 'ready'];
async function postJob(path, body) {
  try { return await api(path, { method: 'POST', body }); } catch (e) {
    if (e.needs) {
      if (!confirm(`The project's gate asks before running:\n\n${e.command}\n\n${e.reason || ''}\n\nRun it?`)) throw new Error('cancelled');
      return await api(path, { method: 'POST', body: { ...body, confirmed: true } });
    }
    throw e;
  }
}
function watch(job) { S.job = { ...job, lines: [], cursor: 0 }; poll(); }
function poll() {
  clearTimeout(pollTimer);
  if (!S.job) return;
  pollTimer = setTimeout(async () => {
    const j = S.job;
    if (!j || !['worktrees', 'docker'].includes(S.tab)) return poll();
    try {
      const v = await api(`/projects/${S.sel}/jobs/${j.id}/logs?since=${j.cursor}`);
      const was = j.status;
      S.job = { ...v, lines: j.lines.concat(v.lines).slice(-1500), cursor: v.cursor };
      const pre = document.getElementById('joblog');
      if (pre) { pre.textContent = S.job.lines.join('\n'); pre.scrollTop = pre.scrollHeight; }
      const st = document.getElementById('jobstatus');
      if (st) st.textContent = S.job.status;
      if (was !== S.job.status) { await loadDetail(); render(); }
      if (!LIVE.includes(S.job.status) && was === S.job.status) { await loadDetail(); render(); return; }
    } catch (e) { S.error = e.message; }
    poll();
  }, 1200);
}
const act = (fn) => guard(async () => { await fn(); await loadDetail(); });
const startDev = (w) => act(async () => { const r = await postJob(`/projects/${S.sel}/dev`, { worktree: w.path }); watch(r.job); });
const stopJobBtn = (id) => act(async () => { await api(`/projects/${S.sel}/jobs/${id}/stop`, { method: 'POST', body: {} }); });
const createWt = (feature, skipDockerCheck) => act(async () => {
  S.preflight = null;
  try { const r = await postJob(`/projects/${S.sel}/worktrees`, { feature, skipDockerCheck }); watch(r.job); } catch (e) {
    if (!(e.data && e.data.dockerPreflight)) throw e;
    S.preflight = { feature, ...e.data.dockerPreflight, message: e.message };
  }
});
const removeWt = (w) => act(async () => {
  if (!confirm(`Remove the worktree ${w.path}?\n\nGit refuses if it has uncommitted changes. The branch is kept.`)) return;
  const r = await postJob(`/projects/${S.sel}/worktrees/remove`, { path: w.path }); watch(r.job);
});

function worktrees(d) {
  const feature = h('input', { placeholder: 'feature-id (kebab-case)', 'aria-label': 'Feature id' });
  const live = (w) => w.dev && LIVE.includes(w.dev.status);
  return h('div', {},
    h('div', { class: 'mute' }, d.dev.command ? ['Dev command: ', h('span', { class: 'mono' }, d.dev.command)] : 'No commands.dev in this project’s profile — dev servers cannot be started from here.'),
    h('table', {}, h('thead', {}, h('tr', {}, ['Worktree', 'Branch', 'Dev server', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.worktrees.map((w) => h('tr', {},
        h('td', { class: 'mono' }, w.path, w.main ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'main') : null),
        h('td', { class: 'mono' }, w.branch || (w.bare ? 'bare' : 'detached')),
        h('td', {}, w.dev ? h('span', { class: `pill ${w.dev.status === 'ready' ? 'ok' : w.dev.status === 'failed' ? 'bad' : ''}` }, w.dev.status) : h('span', { class: 'mute' }, 'stopped')),
        h('td', {},
          live(w) ? h('button', { class: 'b', onclick: () => stopJobBtn(w.dev.id) }, 'Stop')
            : (d.dev.command && !w.bare ? h('button', { class: 'b', onclick: () => startDev(w) }, 'Start dev') : null),
          ' ',
          w.dev ? h('button', { class: 'b', onclick: () => watch(w.dev) }, 'Logs') : null,
          ' ',
          !w.main ? h('button', { class: 'b', onclick: () => removeWt(w) }, 'Remove') : null))))),
    h('h3', {}, 'New worktree'),
    h('form', { class: 'add', onsubmit: (e) => { e.preventDefault(); if (feature.value.trim()) createWt(feature.value.trim()); } },
      feature, h('button', { class: 'b', type: 'submit' }, 'Create')),
    h('div', { class: 'mute' }, d.isolation.create ? 'Uses scripts/new-feature.sh (own DB and ports).' : 'Plain git worktree next to the repo, on a new branch.'),
    S.preflight ? h('div', { class: 'card gate' }, h('div', { class: 'pill warn' }, 'Docker is not ready'), h('div', { style: 'margin:6px 0' }, S.preflight.message),
      S.preflight.daemonUp ? h('button', { class: 'b', onclick: () => act(async () => { S.preflight = null; const r = await postJob(`/projects/${S.sel}/docker`, { action: 'up' }); watch(r.job); }) }, 'Start the stack')
        : h('button', { class: 'b', onclick: () => setTab('docker') }, 'Open the Docker tab'), ' ',
      h('button', { class: 'b', onclick: () => { const f = S.preflight.feature; createWt(f, true); } }, 'Create anyway'), ' ',
      h('button', { class: 'b', onclick: () => { S.preflight = null; render(); } }, 'Cancel'),
      S.preflight.daemonUp ? null : h('div', { class: 'fix' }, 'Start Docker Desktop (or the docker service), then try again.')) : null,
    S.job ? [h('h3', {}, `${S.job.label} · `, h('span', { id: 'jobstatus' }, S.job.status),
      LIVE.includes(S.job.status) ? [' ', h('button', { class: 'b', onclick: () => stopJobBtn(S.job.id) }, 'Stop')] : null),
      h('div', { class: 'mute mono' }, S.job.command), h('pre', { id: 'joblog' }, (S.job.lines || []).join('\n'))] : null);
}


// --- docker: the project's compose stack ----------------------------------------------
let dockerTimer = null;
async function loadDocker() { try { S.docker = await api(`/projects/${S.sel}/docker`); } catch (e) { S.docker = { error: e.message }; } }
function pollDocker() {
  clearTimeout(dockerTimer);
  dockerTimer = setTimeout(async () => {
    if (S.tab !== 'docker') return;
    const before = JSON.stringify(S.docker);
    await loadDocker();
    if (S.tab === 'docker' && before !== JSON.stringify(S.docker)) render();
    pollDocker();
  }, 4000);
}
const dockerAct = (action, service) => act(async () => {
  if (action === 'down' && !confirm('Stop and remove the stack’s containers?\n\nVolumes (your data) are kept.')) return;
  const r = await postJob(`/projects/${S.sel}/docker`, { action, service });
  watch(r.job);
  setTimeout(async () => { if (S.tab === 'docker') { await loadDocker(); render(); } }, 2500);
});
const STATE_TONE = { running: 'ok', exited: 'warn', dead: 'bad', restarting: 'warn' };
function dockerTab(d) {
  const k = S.docker;
  if (!d.docker) return h('div', { class: 'empty' }, 'No compose file here. Declare isolation.compose_file in PIPELINE.md, or add a docker-compose.yml at the repo root.');
  if (!k) return h('div', { class: 'empty' }, 'Loading…');
  if (k.error) return h('div', { class: 'err' }, k.error);
  const live = S.job && LIVE.includes(S.job.status) && /^docker/.test(S.job.label || '');
  return h('div', {},
    h('div', { class: 'cards' },
      h('div', { class: 'card' }, h('div', { class: 'v' }, h('span', { class: `dot ${k.daemon.up ? 'ok' : 'bad'}`, style: 'display:inline-block;margin-right:8px' }), k.daemon.up ? 'Docker up' : 'Docker down'),
        h('div', { class: 'mute' }, k.daemon.up ? `engine ${k.daemon.version || ''}` : k.daemon.error)),
      h('div', { class: 'card' }, h('div', { class: 'v' }, `${k.running || 0}/${k.services.length}`), h('div', { class: 'mute' }, 'services running')),
      h('div', { class: 'card' }, h('div', { class: 'v mono', style: 'font-size:14px' }, k.file), h('div', { class: 'mute' }, 'compose file'))),
    k.configError ? h('div', { class: 'err' }, `compose: ${k.configError}`) : null,
    !k.daemon.up ? h('div', { class: 'mute', style: 'margin:10px 0' }, 'Start Docker Desktop (or the docker service). scripts/new-feature.sh needs it to create a worktree’s database.') : null,
    h('div', { style: 'margin:12px 0' },
      h('button', { class: 'b', disabled: !k.daemon.up || live ? 'disabled' : null, onclick: () => dockerAct('up') }, 'Start stack'), ' ',
      h('button', { class: 'b', disabled: !k.daemon.up || live ? 'disabled' : null, onclick: () => dockerAct('restart') }, 'Restart all'), ' ',
      h('button', { class: 'b', disabled: !k.daemon.up || live ? 'disabled' : null, onclick: () => dockerAct('stop') }, 'Stop all'), ' ',
      h('button', { class: 'b', disabled: !k.daemon.up || live ? 'disabled' : null, onclick: () => dockerAct('down') }, 'Down (keeps volumes)')),
    h('table', {}, h('thead', {}, h('tr', {}, ['Service', 'State', 'Ports', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, k.services.map((v) => h('tr', {},
        h('td', { class: 'mono' }, v.name),
        h('td', {}, h('span', { class: `pill ${STATE_TONE[v.state] || ''}` }, v.state), v.health ? h('span', { class: `pill ${v.health === 'healthy' ? 'ok' : v.health === 'unhealthy' ? 'bad' : 'warn'}`, style: 'margin-left:6px' }, v.health) : null),
        h('td', { class: 'mono' }, v.ports.join(', ')), h('td', { class: 'mute' }, v.status),
        h('td', {}, k.daemon.up ? [
          v.state === 'running' ? h('button', { class: 'b', disabled: live ? 'disabled' : null, onclick: () => dockerAct('stop', v.name) }, 'Stop') : h('button', { class: 'b', disabled: live ? 'disabled' : null, onclick: () => dockerAct('up', v.name) }, 'Start'),
          ' ', h('button', { class: 'b', disabled: live ? 'disabled' : null, onclick: () => dockerAct('restart', v.name) }, 'Restart'),
          ' ', h('button', { class: 'b', onclick: () => dockerAct('logs', v.name) }, 'Logs')] : null))))),
    S.job && /^docker/.test(S.job.label || '') ? [h('h3', {}, `${S.job.label} · `, h('span', { id: 'jobstatus' }, S.job.status),
      LIVE.includes(S.job.status) ? [' ', h('button', { class: 'b', onclick: () => stopJobBtn(S.job.id) }, 'Stop')] : null),
      h('div', { class: 'mute mono' }, S.job.command), h('pre', { id: 'joblog' }, (S.job.lines || []).join('\n'))] : null);
}

// --- overview: the project at a glance --------------------------------------------------
function overview(d) {
  const s = d.doctor.summary;
  const counts = {};
  for (const sp of d.specs) counts[sp.status || 'unknown'] = (counts[sp.status || 'unknown'] || 0) + 1;
  const devs = d.worktrees.filter((w) => w.dev && LIVE.includes(w.dev.status));
  const runs = (d.runs || []).filter((r) => r.status === 'running');
  const todo = d.doctor.checks.filter((c) => c.status === 'bad' || c.status === 'warn');
  const card = (v, l, go, tone) => h('button', { class: `card link${tone ? ` ${tone}` : ''}`, onclick: () => setTab(go) }, h('div', { class: 'v' }, v), h('div', { class: 'mute' }, l));
  return h('div', {},
    h('div', { class: 'cards' },
      card(s.bad ? `${s.bad} failing` : s.warn ? `${s.warn} to review` : 'Healthy', 'pipeline health', 'health', s.bad ? 'bad' : s.warn ? 'warn' : 'ok'),
      card(d.specs.length, `specs${Object.keys(counts).length ? ` · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}`, 'specs'),
      card(d.worktrees.length, `worktree${d.worktrees.length === 1 ? '' : 's'} · ${devs.length} dev server${devs.length === 1 ? '' : 's'} up`, 'worktrees'),
      card(runs.length ? `${runs.length} running` : 'Idle', 'cohorte commands', 'run'),
      d.docker ? card('Docker', d.docker.file, 'docker') : null),
    h('h3', {}, 'Needs attention'),
    todo.length ? h('table', {}, h('tbody', {}, todo.map((c) => h('tr', {}, h('td', {}, h('span', { class: `pill ${c.status}` }, c.status)), h('td', {}, c.label),
      h('td', {}, c.detail, c.fix ? h('div', { class: 'fix' }, `fix: ${c.fix}`) : null))))) : h('div', { class: 'mute' }, 'Nothing — every check passes.'),
    devs.length ? [h('h3', {}, 'Running now'), h('table', {}, h('tbody', {}, devs.map((w) => h('tr', {}, h('td', { class: 'mono' }, w.branch || w.path),
      h('td', {}, h('span', { class: `pill ${w.dev.status === 'ready' ? 'ok' : ''}` }, `dev · ${w.dev.status}`)),
      h('td', {}, h('button', { class: 'b', onclick: () => { watch(w.dev); setTab('worktrees'); } }, 'Logs'))))))] : null,
    d.specs.length ? [h('h3', {}, 'Latest specs'), h('table', {}, h('tbody', {}, d.specs.slice(0, 5).map((sp) => h('tr', { class: 'click', onclick: () => { S.tab = 'specs'; openSpec(sp.id); } },
      h('td', { class: 'mono' }, sp.id), h('td', {}, sp.title), h('td', {}, h('span', { class: `pill ${STATUS_TONE[sp.status] || ''}` }, sp.status))))))] : null);
}

// --- runs: a pipeline command through `claude -p`, with its gates answered here --------------
let runTimer = null;
const RUN_LIVE = ['running'];
function watchRun(run) { S.run = { ...run, events: run.events || [], cursor: run.cursor || 0 }; pollRun(); }
function pollRun() {
  clearTimeout(runTimer);
  if (!S.run) return;
  runTimer = setTimeout(async () => {
    const r = S.run;
    if (!r || S.tab !== 'run') return pollRun();
    try {
      const v = await api(`/projects/${S.sel}/runs/${r.id}?since=${r.cursor}`);
      const before = JSON.stringify(r.pending) + r.status + (r.events.length);
      S.run = { ...v, events: r.events.concat(v.events).slice(-1500), cursor: v.cursor };
      if (before !== JSON.stringify(S.run.pending) + S.run.status + S.run.events.length) render();
      if (!RUN_LIVE.includes(S.run.status)) { await loadDetail(); render(); return; }
    } catch (e) { S.error = e.message; }
    pollRun();
  }, 1000);
}
async function startRun(form) {
  const c = (S.commands || []).find((x) => x.name === form.cmd.value);
  if (c && c.argumentHint && !form.args.value.trim() &&
      !confirm(`${c.name} usually takes an argument ${c.argumentHint}. Without one it may ask a free-text question this dashboard cannot answer.\n\nRun without?`)) return;
  const body = { worktree: form.wt.value, command: form.cmd.value, args: form.args.value, permissionMode: form.mode.value };
  await guard(async () => {
    let r;
    try { r = await api(`/projects/${S.sel}/runs`, { method: 'POST', body }); } catch (e) {
      if (!e.untrusted) throw e;
      if (!confirm(`${e.message}\n\nFix: ${e.fix || 'run claude once in this folder and accept the trust dialog'}\n\nRun anyway?`)) throw new Error('cancelled');
      r = await api(`/projects/${S.sel}/runs`, { method: 'POST', body: { ...body, acknowledgeUntrusted: true } });
    }
    watchRun(r.run);
  });
}
const sendReply = (text) => guard(async () => {
  const r = await api(`/projects/${S.sel}/runs/${S.run.id}/reply`, { method: 'POST', body: { text } });
  watchRun({ ...r.run, events: S.run.events.concat(r.run.events.slice(S.run.cursor)), cursor: r.run.cursor });
});
const respond = (requestId, behavior, answers) => api(`/projects/${S.sel}/runs/${S.run.id}/respond`, { method: 'POST', body: { requestId, behavior, answers } })
  .then(() => pollRun()).catch((e) => { S.error = e.message; render(); });

function pendingCard(p) {
  if (p.kind === 'question') {
    const picked = {};
    const blocks = p.questions.map((q) => {
      const free = h('input', { placeholder: 'Other…', 'aria-label': 'Other answer' });
      free.addEventListener('input', () => { picked[q.question] = free.value ? [free.value] : []; });
      return h('div', { style: 'margin:8px 0' }, h('strong', {}, q.header ? `${q.header} — ` : '', q.question),
        q.options.map((o) => h('label', { style: 'display:block' },
          h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: q.question, style: 'flex:none;margin-right:6px', onchange: (e) => {
            const cur = picked[q.question] || [];
            picked[q.question] = q.multiSelect ? (e.target.checked ? cur.concat(o.label) : cur.filter((x) => x !== o.label)) : [o.label];
          } }), o.label, o.description ? h('span', { class: 'mute' }, ` — ${o.description}`) : null)), free);
    });
    return h('div', { class: 'card gate' }, h('div', { class: 'pill warn' }, 'Question'), blocks,
      h('button', { class: 'b', onclick: () => respond(p.requestId, 'allow', Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, v]))) }, 'Answer'), ' ',
      h('button', { class: 'b', onclick: () => respond(p.requestId, 'deny') }, 'Skip'));
  }
  return h('div', { class: 'card gate' }, h('div', { class: 'pill warn' }, `Permission · ${p.tool}`, p.via ? ` · ${p.via}` : ''),
    h('pre', { style: 'max-height:140px' }, p.summary), p.reason ? h('div', { class: 'fix' }, p.reason) : null,
    h('button', { class: 'b', onclick: () => respond(p.requestId, 'allow') }, 'Allow'), ' ',
    h('button', { class: 'b', onclick: () => respond(p.requestId, 'deny') }, 'Deny'));
}
function eventRow(e, last) {
  if (e.kind === 'text') return h('div', { class: 'ev' }, e.text);
  if (e.kind === 'tool') return h('div', { class: 'ev mute mono' }, `▸ ${e.name}  ${e.summary}`);
  if (e.kind === 'tool_result') return e.error ? h('div', { class: 'ev err mono' }, `✗ ${e.text}`) : null;
  if (e.kind === 'reply') return h('div', { class: 'ev reply' }, h('span', { class: 'mute' }, 'you · '), e.text);
  if (e.kind === 'resolved') return h('div', { class: 'ev mute' }, `gate: ${e.decision}`);
  if (e.kind === 'result') return h('div', { class: `ev ${e.ok ? '' : 'err'}` }, h('strong', {}, e.ok ? 'Done' : 'Failed'), e.costUsd != null ? ` · ${usd(e.costUsd)}` : '', e.durationMs ? ` · ${Math.round(e.durationMs / 1000)}s` : '', e.text && e.text !== last ? h('div', {}, e.text) : null);
  if (e.kind === 'stderr' || e.kind === 'system') return h('div', { class: 'ev err mono' }, e.text);
  return null;
}
function replyBox(r) {
  const ta = h('textarea', { rows: '3', placeholder: `Reply to ${r.command.split(' ')[0]} (same session)…`, 'aria-label': 'Reply to the command' });
  return h('form', { class: 'reply-box', onsubmit: (e) => { e.preventDefault(); if (ta.value.trim()) sendReply(ta.value.trim()); } },
    ta, h('button', { class: 'b', type: 'submit' }, 'Send'),
    h('div', { class: 'mute' }, 'Goes to this Cohorte command only — it is not a general chat.'));
}
function runTab(d) {
  const form = {
    wt: h('select', {}, d.worktrees.filter((w) => !w.bare).map((w) => h('option', { value: w.path }, `${w.main ? '(main) ' : ''}${w.branch || w.path}`))),
    cmd: h('select', {}, (S.commands || []).map((c) => h('option', { value: c.name, title: c.description }, c.name))),
    args: h('input', { placeholder: 'argument (feature id, text…)' }),
    mode: h('select', {}, [['default', 'ask for edits'], ['acceptEdits', 'accept edits'], ['plan', 'plan only']].map(([v, l]) => h('option', { value: v }, l))),
  };
  S.form = S.form || {};
  for (const k of ['wt', 'cmd', 'args', 'mode']) {
    if (S.form[k] != null) form[k].value = S.form[k];
    form[k].addEventListener('input', () => { S.form[k] = form[k].value; });
  }
  const hint = () => { const c = (S.commands || []).find((x) => x.name === form.cmd.value); return c ? `${c.description}${c.argumentHint ? `  [${c.argumentHint}]` : ''}` : ''; };
  const hintEl = h('div', { class: 'mute' }, hint());
  form.cmd.addEventListener('change', () => { hintEl.textContent = hint(); });
  const r = S.run;
  return h('div', {},
    !(S.commands || []).length ? h('div', { class: 'mute' }, 'No /cohorte-* commands found in ~/.claude/commands — run `cohorte install`.') : null,
    h('form', { class: 'add', style: 'flex-wrap:wrap', onsubmit: (e) => { e.preventDefault(); startRun(form); } },
      form.wt, form.cmd, form.args, form.mode, h('button', { class: 'b', type: 'submit', disabled: r && r.status === 'running' ? 'disabled' : null }, 'Run')),
    hintEl,
    h('div', { class: 'mute' }, 'Headless run (claude -p): gates and questions appear below. Talking to the agent stays in Claude Code or Francois.'),
    r ? [h('h3', { style: 'text-transform:none' }, `${r.command} · ${r.status}`, r.status === 'running' ? [' ', h('button', { class: 'b', onclick: () => api(`/projects/${S.sel}/runs/${r.id}/stop`, { method: 'POST', body: {} }).then(pollRun) }, 'Stop')] : null),
      (r.pending || []).map(pendingCard), h('div', { class: 'feed' }, r.events.map((e, i) => eventRow(e, (r.events.slice(0, i).reverse().find((x) => x.kind === 'text') || {}).text))),
      r.status !== 'running' && r.sessionId ? replyBox(r) : null]
      : (d.runs || []).length ? [h('h3', {}, 'Earlier runs'), (d.runs || []).map((x) => h('div', { class: 'mono' }, `${x.command} · ${x.status}`))] : null);
}

function main() {
  if (!S.projects.length) return h('main', {}, h('div', { class: 'empty' }, h('h2', {}, 'No project yet'), 'Add a repo that has a PIPELINE.md using the field on the left.'));
  const sum = S.projects.find((p) => p.id === S.sel);
  const d = S.detail;
  const tabs = [['overview', 'Overview'], ['health', 'Health'], ['specs', 'Specs'], ['run', 'Run'], ['worktrees', 'Worktrees'], ['docker', 'Docker'], ['cost', 'Cost']];
  return h('main', {},
    S.error ? h('div', { class: 'err' }, S.error) : null,
    sum ? h('div', {}, h('h2', {}, sum.title || sum.name), h('div', { class: 'mute' }, sum.oneLiner), h('div', { class: 'mute mono' }, sum.root),
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'b', onclick: () => { if (confirm('Remove this project from the dashboard? Nothing on disk is touched.')) removeProject(sum.id); } }, 'Remove from dashboard'))) : null,
    h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: `tab${S.tab === k ? ' sel' : ''}`, onclick: () => setTab(k) }, l))),
    !d ? h('div', { class: 'empty' }, S.busy ? 'Loading…' : 'Nothing to show.')
      : S.tab === 'overview' ? overview(d) : S.tab === 'health' ? health(d) : S.tab === 'docker' ? dockerTab(d) : S.tab === 'specs' ? specs(d) : S.tab === 'cost' ? cost() : S.tab === 'run' ? runTab(d) : worktrees(d));
}

function render() {
  if (!token) { app.replaceChildren(h('div', { class: 'empty' }, 'Open the URL printed by `cohorte ui` — it carries this session’s token.')); return; }
  app.replaceChildren(h('div', { class: 'layout' }, sidebar(), main()));
}

(async () => {
  render();
  if (!token) return;
  await guard(async () => { await refresh(); await loadDetail(); });
})();
