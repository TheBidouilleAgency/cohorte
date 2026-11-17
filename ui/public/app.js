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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const S = { projects: [], suggestions: [], sel: null, tab: 'health', detail: null, spec: null, metrics: null, error: null, busy: false };
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
const select = (id) => guard(async () => { S.sel = id; S.tab = 'health'; await loadDetail(); });
const addProject = (path) => guard(async () => {
  const r = await api('/projects', { method: 'POST', body: { path } });
  await refresh(); S.sel = r.project.id; S.tab = 'health'; await loadDetail();
});
const removeProject = (id) => guard(async () => { await api(`/projects/${id}`, { method: 'DELETE' }); S.sel = null; S.detail = null; await refresh(); await loadDetail(); });
const openSpec = (id) => guard(async () => { S.spec = await api(`/projects/${S.sel}/specs/${encodeURIComponent(id)}`); });
const setTab = (t) => guard(async () => {
  S.tab = t; S.spec = null;
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

function worktrees(d) {
  return h('table', {}, h('thead', {}, h('tr', {}, ['Path', 'Branch', 'HEAD'].map((t) => h('th', {}, t)))),
    h('tbody', {}, d.worktrees.map((w) => h('tr', {}, h('td', { class: 'mono' }, w.path), h('td', { class: 'mono' }, w.branch || (w.bare ? 'bare' : 'detached')), h('td', { class: 'mono' }, w.head || '')))));
}

function main() {
  if (!S.projects.length) return h('main', {}, h('div', { class: 'empty' }, h('h2', {}, 'No project yet'), 'Add a repo that has a PIPELINE.md using the field on the left.'));
  const sum = S.projects.find((p) => p.id === S.sel);
  const d = S.detail;
  const tabs = [['health', 'Health'], ['specs', 'Specs'], ['cost', 'Cost'], ['worktrees', 'Worktrees']];
  return h('main', {},
    S.error ? h('div', { class: 'err' }, S.error) : null,
    sum ? h('div', {}, h('h2', {}, sum.title || sum.name), h('div', { class: 'mute' }, sum.oneLiner), h('div', { class: 'mute mono' }, sum.root),
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'b', onclick: () => { if (confirm('Remove this project from the dashboard? Nothing on disk is touched.')) removeProject(sum.id); } }, 'Remove from dashboard'))) : null,
    h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: `tab${S.tab === k ? ' sel' : ''}`, onclick: () => setTab(k) }, l))),
    !d ? h('div', { class: 'empty' }, S.busy ? 'Loading…' : 'Nothing to show.')
      : S.tab === 'health' ? health(d) : S.tab === 'specs' ? specs(d) : S.tab === 'cost' ? cost() : worktrees(d));
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
