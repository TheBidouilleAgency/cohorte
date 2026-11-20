// The company flow's agents never write tickets, plans or acceptance notes themselves: they put them in a fenced
// block of their reply, and the server — which owns the tracker and the checkpoints — reads it. This keeps the
// business-facing agents read-only, and makes every artifact a human validates something the server parsed and
// can show as-is.
//
//   ```cohorte-ticket       one ticket proposal (PO)            → TicketProposal
//   ```cohorte-plan         the lead's plan, what CP1 validates → Plan
//   ```cohorte-acceptance   the PO's acceptance note (CP4)      → AcceptanceNote (minus `at`)
//   ```cohorte-vision       a new product's vision (PO)         → Vision
//   ```cohorte-foundation   a new project's stack (lead)        → Foundation
//   ```cohorte-scaffold     the skeleton's report               → ScaffoldReport
//
// Everything here is pure and total: malformed JSON or a missing field yields null or a default, never a throw.

import type { AcceptanceNote, Foundation, Plan, Priority, ScaffoldReport, Size, TicketProposal, TicketType, Vision } from './api';

export type BlockKind = 'cohorte-ticket' | 'cohorte-plan' | 'cohorte-acceptance' | 'cohorte-vision' | 'cohorte-foundation' | 'cohorte-scaffold';

/** Every ```<kind> block in `text`, parsed as JSON (blocks that do not parse are skipped). */
export function blocksOf(text: string, kind: BlockKind): unknown[] {
  const out: unknown[] = [];
  const re = new RegExp('```' + kind + '[^\\n]*\\n([\\s\\S]*?)\\n?```', 'g');
  for (const m of text.matchAll(re)) {
    try { out.push(JSON.parse(m[1])); } catch { /* skipped: the chat still shows the text */ }
  }
  return out;
}

/** The text with its machine blocks removed — what a person reads in the chat. */
export function stripBlocks(text: string): string {
  return text.replace(/```cohorte-(ticket|plan|acceptance|vision|foundation|scaffold)[^\n]*\n[\s\S]*?\n?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max = 40): string[] => (Array.isArray(v) ? v.map((x) => str(x, 1000)).filter(Boolean).slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, all: readonly T[], dflt: T): T => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : dflt);
export const TYPES: readonly TicketType[] = ['feature', 'bug', 'tech'];
export const PRIORITIES: readonly Priority[] = ['high', 'medium', 'low'];
export const SIZES: readonly Size[] = ['S', 'M', 'L', '?'];

export function slug(s: string, max = 48): string {
  const out = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out.slice(0, max).replace(/-+$/, '') || 'ticket';
}

export function toProposal(v: unknown): TicketProposal | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const title = str(o.title, 200);
  if (!title) return null;
  return {
    ref: slug(str(o.ref, 60) || title, 60), title, type: oneOf(o.type, TYPES, 'feature'),
    need: str(o.need), value: str(o.value), criteria: list(o.criteria), outOfScope: list(o.outOfScope ?? o.out_of_scope),
    priority: oneOf(o.priority, PRIORITIES, 'medium'), size: oneOf(o.size, SIZES, '?'), parent: str(o.parent, 100) || null,
  };
}

export function toPlan(v: unknown): Plan | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const summary = str(o.summary);
  if (!summary) return null;
  const criteria = (Array.isArray(o.criteria) ? o.criteria : []).map((c, i) => {
    if (typeof c === 'string') return { id: `C${i + 1}`, text: c.trim() };
    const r = (c || {}) as Record<string, unknown>;
    return { id: str(r.id, 12) || `C${i + 1}`, text: str(r.text, 1000) };
  }).filter((c) => c.text).slice(0, 40);
  const surfaces = (Array.isArray(o.surfaces) ? o.surfaces : []).map((x) => {
    const r = (x || {}) as Record<string, unknown>;
    return { key: str(r.key, 60), tasks: list(r.tasks) };
  }).filter((x) => x.key).slice(0, 20);
  return { summary, criteria, contract: str(o.contract), surfaces, risks: list(o.risks), assumptions: list(o.assumptions), questions: list(o.questions), size: oneOf(o.size, SIZES, '?') };
}

export function toAcceptance(v: unknown): Omit<AcceptanceNote, 'at'> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const summary = str(o.summary);
  if (!summary) return null;
  return { summary, changes: list(o.changes), howToTest: list(o.howToTest ?? o.how_to_test), outOfScope: list(o.outOfScope ?? o.out_of_scope) };
}

export function toVision(v: unknown): Vision | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const pitch = str(o.pitch, 1000);
  const firstVersion = list(o.firstVersion ?? o.first_version);
  if (!pitch || !firstVersion.length) return null;
  return { name: str(o.name, 120), pitch, users: list(o.users), problem: str(o.problem), today: str(o.today), firstVersion, later: list(o.later),
    success: str(o.success, 1000), constraints: list(o.constraints), language: str(o.language, 60) };
}

const cmd = (v: unknown): string => str(v, 400).replace(/[\r\n]+/g, ' ');
export function toFoundation(v: unknown): Foundation | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const summary = str(o.summary);
  const surfaces = (Array.isArray(o.surfaces) ? o.surfaces : []).map((x) => {
    const r = (x || {}) as Record<string, unknown>;
    const raw = str(r.key, 40);
    const key = raw ? slug(raw, 40) : '';
    return { key, path: str(r.path, 120).replace(/^\.?\/+/, '') || key, stack: str(r.stack, 300), generate: cmd(r.generate) || null,
      packageManager: str(r.packageManager ?? r.package_manager, 20), test: cmd(r.test), lint: cmd(r.lint), build: cmd(r.build) };
  }).filter((x) => x.key).slice(0, 12);
  if (!summary || !surfaces.length) return null;
  return { summary, surfaces, data: str(o.data, 1000), auth: str(o.auth, 1000), hosting: str(o.hosting, 1000), devCommand: cmd(o.devCommand ?? o.dev_command), ci: str(o.ci, 1000),
    basedOn: str(o.basedOn ?? o.based_on, 200) || null, conventions: list(o.conventions), skeleton: str(o.skeleton, 1000), decisions: list(o.decisions),
    assumptions: list(o.assumptions), questions: list(o.questions) };
}

export function toScaffold(v: unknown): ScaffoldReport | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.status !== 'ok' && o.status !== 'failed') return null;
  const surfaces = (Array.isArray(o.surfaces) ? o.surfaces : []).map((x) => {
    const r = (x || {}) as Record<string, unknown>;
    return { key: str(r.key, 40), path: str(r.path, 120), test: cmd(r.test), lint: cmd(r.lint), build: cmd(r.build), ok: r.ok === true };
  }).filter((x) => x.key).slice(0, 12);
  const checks = (Array.isArray(o.checks) ? o.checks : []).map((x) => {
    const r = (x || {}) as Record<string, unknown>;
    return { command: cmd(r.command), ok: r.ok === true, note: str(r.note, 500) };
  }).filter((x) => x.command).slice(0, 40);
  return { status: o.status, surfaces, devCommand: cmd(o.devCommand ?? o.dev_command), checks, assumptions: list(o.assumptions), notes: str(o.notes, 2000) };
}

/** The last parseable block of `kind` across a run's text events, in order. */
export function lastOf<T>(texts: string[], kind: BlockKind, conv: (v: unknown) => T | null): T | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const bs = blocksOf(texts[i], kind);
    for (let j = bs.length - 1; j >= 0; j--) { const t = conv(bs[j]); if (t) return t; }
  }
  return null;
}

/** Every proposal across texts, the LAST revision of each ref winning. */
export function proposalsOf(texts: string[]): TicketProposal[] {
  const by = new Map<string, TicketProposal>();
  for (const t of texts) for (const b of blocksOf(t, 'cohorte-ticket')) { const p = toProposal(b); if (p) { by.delete(p.ref); by.set(p.ref, p); } }
  return [...by.values()];
}
