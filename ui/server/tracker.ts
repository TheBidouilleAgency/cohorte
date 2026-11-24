// The ticket tracker of the company flow. Obsidian first: when the project has a kanban board in the user's
// cohorte.config.yaml, every ticket is a note in a `Tickets/` folder next to that board, and its card on the board
// links to it. Without a board, tickets live on this machine under <globalDir>/cohorte-ui/tickets/<projectId>/.
// Either way the format is the same markdown note, so a person can open and edit it by hand (Obsidian or not),
// and the agents only ever see its content inlined in their prompt — they never need to know where it lives.
//
// The board is moved through scripts/kanban-move.sh (its lock, its layout candidates) with the board path
// resolved here, so a ticket card and a spec card are the same card: the `#<id>` tag is the ticket id, which is
// also the feature id the pipeline commands move.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { AcceptanceNote, Ticket, TicketProposal, TicketStatus, TrackerInfo } from '../shared/api';
import { repo } from './legacy';
import { PRIORITIES, SIZES, TYPES, slug } from '../shared/blocks';
import { readProfile } from './ops';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml: { parse(text: string): any } = require(path.join(repo, 'lib', 'yaml.js'));

export const STATUSES: readonly TicketStatus[] = ['discussion', 'validate', 'backlog', 'framing', 'building', 'checkpoint', 'pr', 'acceptance', 'done', 'rejected'];
/** The company layout, in board order: stage key → heading. kanban-move.sh knows the same keys. */
export const COMPANY_COLUMNS: [string, string][] = [
  ['ideas', 'Ideas'], ['discussion', 'Discussion'], ['validate', 'To validate · business'], ['backlog', 'Backlog'], ['framing', 'Framing'],
  ['building', 'In progress'], ['checkpoint', 'To validate · dev'], ['pr', 'PR open'], ['acceptance', 'Acceptance'], ['done', 'Done'],
];
const QUEUE = new Map<string, Promise<string>>();
/** Resolves once every card move asked so far has landed — a CLI verb waits for it before it exits. */
export const settleMoves = async (): Promise<void> => { while (QUEUE.size) await Promise.allSettled([...QUEUE.values()]); };
const STAGE_OF: Record<TicketStatus, string> = {
  discussion: 'discussion', validate: 'validate', backlog: 'backlog', framing: 'framing', building: 'building', checkpoint: 'checkpoint',
  pr: 'pr', acceptance: 'acceptance', done: 'done', rejected: 'done',
};

export const configPath = (globalDir: string): string => process.env.COHORTE_CONFIG || path.join(globalDir, 'cohorte.config.yaml');
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const isTicketId = (s: unknown): s is string => typeof s === 'string' && ID.test(s);

// ---------------------------------------------------------------------------------------------------------------
// Resolution

/** Where a project's tickets live when no board is connected — and, once one is, the backup of what was migrated. */
export const localDir = (globalDir: string, projectId: string): string => path.join(globalDir, 'cohorte-ui', 'tickets', projectId);

export function trackerOf(globalDir: string, root: string, projectId: string): TrackerInfo {
  const projectName = readProfile(root).name || null;
  const local = (reason: string): TrackerInfo => ({ kind: 'local', dir: localDir(globalDir, projectId), board: null, reason, projectName });
  let cfg: any = null;
  try { cfg = yaml.parse(fs.readFileSync(configPath(globalDir), 'utf8')); } catch { return local('no cohorte.config.yaml — connect Obsidian in Settings to keep tickets in your vault'); }
  if (cfg?.enabled === false) return local('cohorte capabilities are disabled in cohorte.config.yaml (enabled: false)');
  if (cfg?.kanban?.enabled !== true) return local('the kanban mirror is off (kanban.enabled is not true)');
  const vault = typeof cfg?.obsidian?.vault_path === 'string' ? cfg.obsidian.vault_path : '';
  if (!vault) return local('obsidian.vault_path is not set');
  if (!projectName) return local('this project has no `name` in its PIPELINE.md profile');
  const rel = cfg?.kanban?.boards?.[projectName]?.board;
  if (typeof rel !== 'string' || !rel) return local(`no board for "${projectName}" in cohorte.config.yaml`);
  const board = path.join(vault, rel);
  if (!fs.existsSync(board)) return local(`the board file is missing: ${board}`);
  return { kind: 'obsidian', dir: path.join(path.dirname(board), 'Tickets'), board, reason: '', projectName };
}

// ---------------------------------------------------------------------------------------------------------------
// The note format

const q = (s: string): string => JSON.stringify(s);
const today = (): string => new Date().toISOString();

export function serialize(t: Ticket): string {
  const fm = [
    '---', `id: ${t.id}`, `title: ${q(t.title)}`, `type: ${t.type}`, `status: ${t.status}`, `requester: ${q(t.requester)}`,
    `priority: ${t.priority}`, `size: ${q(t.size)}`, `created: ${t.created}`, `updated: ${t.updated}`,
    `parent: ${t.parent ? t.parent : 'null'}`, `pr: ${t.pr ? q(t.pr) : 'null'}`, `conversation: ${t.conversation ? t.conversation : 'null'}`,
    'tags: [cohorte-ticket]', '---', '',
  ];
  const sec = (h: string, body: string): string[] => (body.trim() ? [`## ${h}`, '', body.trim(), ''] : []);
  const bullets = (xs: string[], num = false): string => xs.map((x, i) => (num ? `- C${i + 1} — ${x}` : `- ${x}`)).join('\n');
  const acc = t.acceptance
    ? [`_${t.acceptance.at.slice(0, 10)}_`, '', t.acceptance.summary, '',
      ...(t.acceptance.changes.length ? ['### What changed', '', bullets(t.acceptance.changes), ''] : []),
      ...(t.acceptance.howToTest.length ? ['### How to test', '', t.acceptance.howToTest.map((x, i) => `${i + 1}. ${x}`).join('\n'), ''] : []),
      ...(t.acceptance.outOfScope.length ? ['### Not in this delivery', '', bullets(t.acceptance.outOfScope), ''] : [])].join('\n')
    : '';
  return [
    ...fm, `# ${t.title}`, '',
    ...sec('Need', t.need), ...sec('Value', t.value), ...sec('Acceptance criteria', bullets(t.criteria, true)),
    ...sec('Out of scope', bullets(t.outOfScope)), ...sec('Notes', t.notes), ...sec('Acceptance note', acc), ...sec('Feedback', bullets(t.feedback)),
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

function scalar(v: string | undefined): string {
  if (v === undefined) return '';
  const s = v.trim();
  if (s === 'null' || s === '~') return '';
  if (s.startsWith('"')) { try { return String(JSON.parse(s)); } catch { return s.slice(1, -1); } }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
const bulletsOf = (body: string): string[] => body.split('\n').map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)?.[1] ?? '').filter(Boolean);

/** Parses a ticket note. Tolerant of hand edits: unknown sections go to notes, unknown values to defaults. */
export function parse(text: string, fallbackId: string): Ticket | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/); if (kv) fm[kv[1]] = kv[2]; }
  if (fm.tags !== undefined && !/cohorte-ticket/.test(fm.tags)) return null;
  const sections: Record<string, string> = {};
  let cur = '';
  for (const line of m[2].split(/\r?\n/)) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { cur = h[1].toLowerCase(); sections[cur] = ''; continue; }
    if (cur) sections[cur] += `${line}\n`;
  }
  const oneOf = <T extends string>(v: string, all: readonly T[], d: T): T => ((all as readonly string[]).includes(v) ? (v as T) : d);
  let acceptance: AcceptanceNote | null = null;
  const acc = sections['acceptance note'];
  if (acc && acc.trim()) {
    const parts: Record<string, string> = { '': '' };
    let sub = '';
    for (const line of acc.split('\n')) { const h = line.match(/^### (.+?)\s*$/); if (h) { sub = h[1].toLowerCase(); parts[sub] = ''; } else parts[sub] += `${line}\n`; }
    const head = parts[''].trim();
    const at = head.match(/^_(\d{4}-\d{2}-\d{2})[^_]*_/);
    acceptance = { at: at ? at[1] : '', summary: head.replace(/^_[^_]*_\s*/, '').trim(), changes: bulletsOf(parts['what changed'] || ''),
      howToTest: bulletsOf(parts['how to test'] || ''), outOfScope: bulletsOf(parts['not in this delivery'] || '') };
  }
  const id = scalar(fm.id) || fallbackId;
  if (!isTicketId(id)) return null;
  const known = ['need', 'value', 'acceptance criteria', 'out of scope', 'notes', 'acceptance note', 'feedback'];
  const extra = Object.entries(sections).filter(([k]) => !known.includes(k)).map(([k, v]) => `### ${k}\n${v.trim()}`).join('\n\n');
  return {
    id, title: scalar(fm.title) || id, type: oneOf(scalar(fm.type), TYPES, 'feature'), status: oneOf(scalar(fm.status), STATUSES, 'backlog'),
    requester: scalar(fm.requester), priority: oneOf(scalar(fm.priority), PRIORITIES, 'medium'), size: oneOf(scalar(fm.size), SIZES, '?'),
    created: scalar(fm.created), updated: scalar(fm.updated), parent: scalar(fm.parent) || null, pr: scalar(fm.pr) || null,
    conversation: scalar(fm.conversation) || null,
    need: (sections.need || '').trim(), value: (sections.value || '').trim(),
    criteria: bulletsOf(sections['acceptance criteria'] || '').map((c) => c.replace(/^C\d+\s*[—–-]\s*/, '')),
    outOfScope: bulletsOf(sections['out of scope'] || ''), notes: [(sections.notes || '').trim(), extra].filter(Boolean).join('\n\n'),
    acceptance, feedback: bulletsOf(sections.feedback || ''),
  };
}

/** Ticket text as an agent reads it in its prompt. */
export function ticketBrief(t: Ticket): string {
  return [
    `Ticket ${t.id} — ${t.title}`, `type: ${t.type} · priority: ${t.priority} · size: ${t.size} · requester: ${t.requester || 'unknown'}${t.parent ? ` · follows up ${t.parent}` : ''}`,
    '', 'Need:', t.need || '(not stated)', '', 'Value:', t.value || '(not stated)', '',
    'Acceptance criteria (business language):', ...(t.criteria.length ? t.criteria.map((c, i) => `- C${i + 1} — ${c}`) : ['(none)']),
    '', 'Out of scope:', ...(t.outOfScope.length ? t.outOfScope.map((c) => `- ${c}`) : ['(none)']),
    ...(t.notes ? ['', 'Notes:', t.notes] : []),
    ...(t.feedback.length ? ['', 'Feedback from acceptance:', ...t.feedback.map((f) => `- ${f}`)] : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The store

export class Tracker {
  constructor(readonly info: TrackerInfo, private vault: string | null = null) {}

  private file(id: string): string { return path.join(this.info.dir, `${id}.md`); }

  list(): Ticket[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.info.dir).filter((n) => n.endsWith('.md')); } catch { return []; }
    const out: Ticket[] = [];
    for (const n of names) {
      try { const t = parse(fs.readFileSync(path.join(this.info.dir, n), 'utf8'), n.slice(0, -3)); if (t) out.push(t); } catch { /* unreadable note */ }
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  get(id: string): Ticket | null {
    if (!isTicketId(id)) return null;
    try { return parse(fs.readFileSync(this.file(id), 'utf8'), id); } catch { return null; }
  }

  private freeId(title: string): string {
    const base = slug(title, 48);
    let id = base;
    for (let i = 2; fs.existsSync(this.file(id)); i++) id = `${base}-${i}`;
    return id;
  }

  write(t: Ticket): Ticket {
    fs.mkdirSync(this.info.dir, { recursive: true });
    const f = this.file(t.id);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serialize(t));
    fs.renameSync(tmp, f);
    return t;
  }

  create(p: Partial<TicketProposal> & { title: string }, extra: Partial<Ticket> = {}): Ticket {
    const now = today();
    const t: Ticket = {
      id: this.freeId(p.title), title: p.title, type: p.type || 'feature', status: 'backlog', requester: '', priority: p.priority || 'medium', size: p.size || '?',
      created: now.slice(0, 10), updated: now, parent: p.parent || null, pr: null, conversation: null,
      need: p.need || '', value: p.value || '', criteria: p.criteria || [], outOfScope: p.outOfScope || [], notes: '', acceptance: null, feedback: [], ...extra,
    };
    return this.write(t);
  }

  update(id: string, patch: Partial<Ticket>): Ticket | null {
    const cur = this.get(id);
    if (!cur) return null;
    return this.write({ ...cur, ...patch, id: cur.id, created: cur.created, updated: today() });
  }

  /**
   * Moves the ticket's card to the column of its status. Never throws: the board is a mirror.
   * Moves on one board run one after another IN THE ORDER they were asked: kanban-move.sh's lock serializes
   * writers but not their order, and two moves a few milliseconds apart (building, then checkpoint) would
   * otherwise land in either order.
   */
  move(t: Ticket): Promise<string> {
    if (this.info.kind !== 'obsidian' || !this.info.board) return Promise.resolve('');
    const key = this.info.board;
    const run = (QUEUE.get(key) || Promise.resolve('')).then(() => this.moveNow(t), () => this.moveNow(t));
    QUEUE.set(key, run);
    void run.finally(() => { if (QUEUE.get(key) === run) QUEUE.delete(key); });
    return run;
  }

  private moveNow(t: Ticket): Promise<string> {
    // the status at the time of the move, not of the call: a later write may have moved on already
    const cur = this.get(t.id) || t;
    t = cur;
    const stage = STAGE_OF[t.status];
    const rel = this.vault ? path.relative(this.vault, this.file(t.id)).replace(/\\/g, '/').replace(/\.md$/, '') : t.id;
    const label = t.title.replace(/[[\]|#\n]/g, ' ').replace(/\s+/g, ' ').trim();
    const title = `[[${rel}|${label}]]`;
    return new Promise((resolve) => {
      const child = spawn('sh', [path.join(repo, 'scripts', 'kanban-move.sh'), this.info.board as string, t.id, stage, '--title', title], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d; });
      child.stderr.on('data', (d: Buffer) => { out += d; });
      child.on('error', (e) => resolve(`kanban: ${e.message}`));
      child.on('close', () => resolve(out.trim()));
    });
  }
}

function openTracker(globalDir: string, root: string, projectId: string): Tracker {
  const info = trackerOf(globalDir, root, projectId);
  let vault: string | null = null;
  if (info.kind === 'obsidian') { try { vault = yaml.parse(fs.readFileSync(configPath(globalDir), 'utf8'))?.obsidian?.vault_path || null; } catch { vault = null; } }
  return new Tracker(info, vault);
}

/**
 * The project's ticket store. When it is a vault that this machine's local tickets were never migrated to (a
 * board connected before the migration existed, or by hand in cohorte.config.yaml), they are migrated now —
 * once: the marker in the local store keeps a ticket deleted from the vault on purpose from coming back.
 */
export function trackerFor(globalDir: string, root: string, projectId: string): Tracker {
  const tr = openTracker(globalDir, root, projectId);
  if (tr.info.kind === 'obsidian') { try { void migrateLocal(globalDir, projectId, tr).cards; } catch { /* the vault is unwritable: list what is there */ } }
  return tr;
}

// ---------------------------------------------------------------------------------------------------------------
// Local store → vault. Connecting Obsidian switches the store; the tickets already on this machine follow.

const MARKER = '.migrated.json';
function markers(dir: string): Record<string, string> {
  try { const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

/**
 * Copies the local tickets into the vault store and puts each card in the column of its status. Idempotent: a
 * ticket the vault already has — same id, or same title and creation date (a note renamed in the vault) — is
 * left alone, the vault's copy wins. The local notes stay where they are, as a backup. Once done for a vault
 * store, it is recorded in the local store and not done again for it (see trackerFor).
 */
export function migrateLocal(globalDir: string, projectId: string, tr: Tracker): { count: number; cards: Promise<string[]> } {
  const src = localDir(globalDir, projectId);
  const none = { count: 0, cards: Promise.resolve([] as string[]) };
  if (tr.info.kind !== 'obsidian' || path.resolve(src) === path.resolve(tr.info.dir)) return none;
  const done = markers(src);
  if (done[path.resolve(tr.info.dir)]) return none;
  let names: string[] = [];
  try { names = fs.readdirSync(src).filter((n) => n.endsWith('.md')); } catch { return none; }
  const there = tr.list();
  const same = new Set(there.map((t) => `${t.title}\u0000${t.created}`));
  const moved: Ticket[] = [];
  for (const n of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(src, n), 'utf8'); } catch { continue; }
    const t = parse(text, n.slice(0, -3));
    if (!t || tr.get(t.id) || fs.existsSync(path.join(tr.info.dir, `${t.id}.md`)) || same.has(`${t.title}\u0000${t.created}`)) continue;
    fs.mkdirSync(tr.info.dir, { recursive: true });
    const f = path.join(tr.info.dir, `${t.id}.md`);
    fs.writeFileSync(`${f}.${process.pid}.tmp`, text);
    fs.renameSync(`${f}.${process.pid}.tmp`, f);
    moved.push(t);
  }
  fs.writeFileSync(path.join(src, MARKER), `${JSON.stringify({ ...done, [path.resolve(tr.info.dir)]: today() }, null, 2)}\n`);
  // board order: oldest first, numbered ids in number order
  moved.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { count: moved.length, cards: Promise.all(moved.map((t) => tr.move(t))) };
}

// ---------------------------------------------------------------------------------------------------------------
// Connecting Obsidian from the page — targeted edits of the user's hand-written config (never a rewrite).

export class TrackerError extends Error {}
const lines = (t: string): string[] => t.split('\n');
const indentOf = (l: string): number => (l.match(/^ */) as RegExpMatchArray)[0].length;
const isKey = (l: string, key: string): boolean => new RegExp(`^\\s*${key}:(\\s|$)`).test(l);
/** [start, end) of the block owned by the key at line i (lines more indented than it, blanks included). */
function blockEnd(ls: string[], i: number): number {
  const ind = indentOf(ls[i]);
  let j = i + 1;
  while (j < ls.length && (ls[j].trim() === '' || ls[j].trim().startsWith('#') || indentOf(ls[j]) > ind)) j++;
  while (j > i + 1 && ls[j - 1].trim() === '') j--;
  return j;
}
function topKey(ls: string[], key: string): number { return ls.findIndex((l) => indentOf(l) === 0 && isKey(l, key)); }
function childKey(ls: string[], parent: number, key: string): number {
  const end = blockEnd(ls, parent);
  for (let i = parent + 1; i < end; i++) if (ls[i].trim() && !ls[i].trim().startsWith('#') && isKey(ls[i], key) && indentOf(ls[i]) > indentOf(ls[parent])) {
    // a direct child: the first non-comment line's indent under the parent
    return i;
  }
  return -1;
}
function setValue(line: string, value: string): string {
  const m = line.match(/^(\s*[\w.-]+:)\s*(?:"[^"]*"|'[^']*'|[^#]*?)?\s*(#.*)?$/);
  if (!m) return line;
  return `${m[1]} ${value}${m[2] ? `  ${m[2]}` : ''}`;
}

export function withVault(text: string, vault: string): string {
  const ls = lines(text);
  const ob = topKey(ls, 'obsidian');
  if (ob < 0) return `${text.replace(/\n*$/, '\n')}\nobsidian:\n  vault_path: ${q(vault)}\n`;
  const vp = childKey(ls, ob, 'vault_path');
  if (vp < 0) ls.splice(ob + 1, 0, `  vault_path: ${q(vault)}`);
  else ls[vp] = setValue(ls[vp], q(vault));
  return ls.join('\n');
}

export function withBoard(text: string, name: string, rel: string): string {
  let ls = lines(text);
  let kb = topKey(ls, 'kanban');
  if (kb < 0) { ls = lines(`${text.replace(/\n*$/, '\n')}\nkanban:\n  enabled: true\n  boards: {}\n`); kb = topKey(ls, 'kanban'); }
  const en = childKey(ls, kb, 'enabled');
  if (en < 0) ls.splice(kb + 1, 0, '  enabled: true');
  else ls[en] = setValue(ls[en], 'true');
  let bd = childKey(ls, kb, 'boards');
  if (bd < 0) { const end = blockEnd(ls, kb); ls.splice(end, 0, '  boards: {}'); bd = end; }
  const ind = ' '.repeat(indentOf(ls[bd]) + 2);
  if (/boards:\s*\{\s*\}/.test(ls[bd])) ls[bd] = ls[bd].replace(/boards:\s*\{\s*\}/, 'boards:');
  const entry = childKey(ls, bd, name.replace(/[.]/g, '\\.'));
  if (entry < 0) ls.splice(bd + 1, 0, `${ind}${name}:`, `${ind}  board: ${q(rel)}`);
  else {
    const b = childKey(ls, entry, 'board');
    if (b < 0) ls.splice(entry + 1, 0, `${ind}  board: ${q(rel)}`);
    else ls[b] = setValue(ls[b], q(rel));
  }
  return ls.join('\n');
}

export function companyBoard(): string {
  return [
    '---', '', 'kanban-plugin: board', '', '---', '',
    ...COMPANY_COLUMNS.flatMap(([, h]) => [`## ${h}`, '', '']),
    '%% kanban:settings', '```', JSON.stringify({ 'kanban-plugin': 'board', 'list-collapse': COMPANY_COLUMNS.map(() => false) }), '```', '%%', '',
  ].join('\n');
}

/**
 * Points this project at a board in an Obsidian vault: config edited, board created (company layout) if absent,
 * and the tickets of the local store migrated into the vault (`migrated` of them; see migrateLocal).
 */
export async function connectObsidian(globalDir: string, root: string, projectId: string, body: { vault?: unknown; board?: unknown }): Promise<{ created: boolean; board: string; migrated: number }> {
  const name = readProfile(root).name;
  if (!name) throw new TrackerError('this project has no `name` in its PIPELINE.md profile — run /cohorte-init-pipeline first');
  if (!/^[\w.-]+$/.test(name)) throw new TrackerError(`the project name "${name}" cannot be a config key (letters, digits, . _ - only)`);
  const vault = typeof body.vault === 'string' ? body.vault.trim() : '';
  if (!vault || !path.isAbsolute(vault)) throw new TrackerError('the vault must be an absolute path');
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) throw new TrackerError(`no folder at ${vault}`);
  const rel = (typeof body.board === 'string' && body.board.trim() ? body.board.trim() : `${name}/Tasks.md`).replace(/\\/g, '/');
  if (!rel.endsWith('.md') || rel.startsWith('/') || rel.split('/').includes('..')) throw new TrackerError('the board must be a .md path inside the vault');
  const cfg = configPath(globalDir);
  let text = '';
  try { text = fs.readFileSync(cfg, 'utf8'); } catch {
    try { text = fs.readFileSync(path.join(repo, 'profile', 'cohorte.config.template.yaml'), 'utf8'); } catch { text = 'enabled: true\n'; }
  }
  text = withBoard(withVault(text, vault), name, rel);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(`${cfg}.tmp`, text);
  fs.renameSync(`${cfg}.tmp`, cfg);
  const board = path.join(vault, rel);
  let created = false;
  if (!fs.existsSync(board)) { fs.mkdirSync(path.dirname(board), { recursive: true }); fs.writeFileSync(board, companyBoard()); created = true; }
  fs.mkdirSync(path.join(path.dirname(board), 'Tickets'), { recursive: true });
  const tr = openTracker(globalDir, root, projectId);
  const m = migrateLocal(globalDir, projectId, tr);
  await m.cards;
  return { created, board, migrated: m.count };
}
