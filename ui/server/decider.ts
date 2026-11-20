// The decider — settles a question an agent asked mid-run, on the developer's behalf, only when what is already
// settled answers it. Same shape as a classifier (Jev-style): a STATE (the question, its options, the feature's
// settled context) in, a TYPED ANSWER out (one of the options, a category, a cited source), with a probability.
//
// The probability is not a number a model makes up: it is the agreement of N independent votes (`claude -p`,
// one turn, no tools, the context inlined). Unanimous on a light model ⇒ settled. Split ⇒ the same question goes
// to the next model up. Still split, or no source to cite, or a category a human must own ⇒ it goes to the
// developer, with the decider's best reading attached so they decide in one click.
//
// It NEVER settles: a behaviour or UX the business would see, a contract change, security, cost, or anything
// irreversible. Those are the developer's, whatever the votes say.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Autonomy, DecisionAdvice, DecisionSource, PendingQuestion, Plan } from '../shared/api';

export const CATEGORIES = ['reversible', 'visible', 'behavior', 'contract', 'cost', 'security', 'irreversible'] as const;
export type Category = (typeof CATEGORIES)[number];
const HUMAN_ONLY: readonly Category[] = ['behavior', 'contract', 'cost', 'security', 'irreversible'];
const SOURCE_KINDS: readonly DecisionSource['kind'][] = ['spec', 'plan', 'decision', 'convention', 'preference', 'code', 'none']; // a vote never claims `recommendation`
const SETTLED: readonly DecisionSource['kind'][] = ['spec', 'plan', 'decision', 'convention', 'preference'];

export interface Vote { choice: string | null; category: Category; source: DecisionSource; rationale: string }
export interface Tally { choice: string | null; agreement: number; votes: number; category: Category; source: DecisionSource; rationale: string }
export type Outcome =
  | { decided: true; choice: string; tally: Tally; model: string }
  | { decided: false; advice: DecisionAdvice };

const clip = (s: unknown, n: number): string => { const t = typeof s === 'string' ? s : ''; return t.length > n ? `${t.slice(0, n)}…` : t; };

/** The category a question's header already declares (the commands set it), if it is one. */
export function headerCategory(header: string): Category | null {
  const h = header.trim().toLowerCase();
  return (CATEGORIES as readonly string[]).includes(h) ? (h as Category) : null;
}

/** One vote from a model's reply text. Tolerant: the first JSON object in the text; anything malformed is a null vote. */
export function parseVote(text: string, options: string[]): Vote {
  const none: Vote = { choice: null, category: 'reversible', source: { kind: 'none', ref: '', quote: '' }, rationale: '' };
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return none;
  let o: any;
  try { o = JSON.parse(m[0]); } catch { return none; }
  const choice = typeof o.choice === 'string' ? options.find((x) => x.trim().toLowerCase() === o.choice.trim().toLowerCase()) ?? null : null;
  const category = (CATEGORIES as readonly string[]).includes(o.category) ? (o.category as Category) : 'behavior'; // unknown ⇒ the cautious reading
  const s = o.source && typeof o.source === 'object' ? o.source : {};
  const kind = (SOURCE_KINDS as readonly string[]).includes(s.kind) ? s.kind : 'none';
  return { choice, category, source: { kind, ref: clip(s.ref, 200), quote: clip(s.quote, 400) }, rationale: clip(o.rationale, 600) };
}

/** Majority choice, its share of the votes, and the MOST severe category any vote saw. */
export function tally(votes: Vote[]): Tally {
  const count = new Map<string, number>();
  for (const v of votes) if (v.choice) count.set(v.choice, (count.get(v.choice) || 0) + 1);
  let choice: string | null = null; let best = 0;
  for (const [c, n] of count) if (n > best) { best = n; choice = c; }
  const severity = (c: Category): number => CATEGORIES.indexOf(c);
  const category = votes.reduce<Category>((a, v) => (severity(v.category) > severity(a) ? v.category : a), 'reversible');
  const backing = votes.filter((v) => v.choice === choice);
  const cited = backing.find((v) => v.source.kind !== 'none') || backing[0];
  return { choice, agreement: votes.length ? best / votes.length : 0, votes: votes.length, category, source: cited?.source || { kind: 'none', ref: '', quote: '' }, rationale: cited?.rationale || '' };
}

/** Whether a tally may be acted on at this autonomy. `null` = yes; otherwise why not. */
export function refusal(t: Tally, autonomy: Autonomy): string | null {
  if (!t.choice) return 'no option was picked';
  if (HUMAN_ONLY.includes(t.category)) return `a ${t.category} decision is yours`;
  if (autonomy === 'prudent' && t.category !== 'reversible') return `prudent: only reversible choices are settled alone (this one is ${t.category})`;
  if (t.source.kind === 'none') return 'nothing settled answers it (no source)';
  if (t.source.kind === 'code' && autonomy !== 'autonomous' && t.category !== 'reversible') return 'only a precedent in the code backs it';
  if (autonomy === 'prudent' && !SETTLED.includes(t.source.kind)) return 'prudent: needs a written decision, not a code precedent';
  const need = autonomy === 'autonomous' ? 2 / 3 : 1;
  if (t.agreement + 1e-9 < need) return `the votes split (${Math.round(t.agreement * t.votes)}/${t.votes})`;
  return null;
}

/**
 * A reversible choice nothing written settles (every vote said `reversible`, none could cite a source): not worth a
 * person's attention. Outside `prudent`, the asking agent's own recommended option is taken — and listed at CP3 like
 * any other decision, so it can still be contested.
 */
export function reversibleDefault(t: Tally, q: PendingQuestion, autonomy: Autonomy): Outcome | null {
  if (autonomy === 'prudent' || t.category !== 'reversible' || t.votes === 0) return null;
  const rec = q.options.find((o) => /\(recommended\)\s*$/i.test(o.label));
  if (!rec) return null;
  return { decided: true, choice: rec.label, model: 'recommendation',
    tally: { ...t, choice: rec.label, source: { kind: 'recommendation', ref: '', quote: '' }, rationale: 'reversible, and nothing written settles it — took the agent\'s recommendation' } };
}

// ---------------------------------------------------------------------------------------------------------------
// The developer's preferences: every answer they gave, every decider choice they confirmed or contested.

export interface Preference { at: string; feature: string; question: string; header: string; answer: string; kind: 'answer' | 'confirmed' | 'contested'; note?: string }
export class Preferences {
  constructor(private dir: string) {}
  private file(projectId: string): string { return path.join(this.dir, `${projectId.replace(/[^A-Za-z0-9._-]/g, '')}.jsonl`); }
  add(projectId: string, p: Omit<Preference, 'at'>): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file(projectId), `${JSON.stringify({ at: new Date().toISOString(), ...p, question: clip(p.question, 500), answer: clip(p.answer, 300), note: p.note ? clip(p.note, 500) : undefined })}\n`);
    } catch { /* a convenience */ }
  }
  list(projectId: string, limit = 60): Preference[] {
    try {
      return fs.readFileSync(this.file(projectId), 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l) as Preference);
    } catch { return []; }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The prompt

export interface DeciderContext { plan: Plan | null; spec: string; decisions: string; conventions: string; preferences: Preference[]; stage: string; feature: string }

export function promptFor(q: PendingQuestion, ctx: DeciderContext): string {
  const prefs = ctx.preferences.map((p) => `- Q: ${p.question} → ${p.answer} (${p.kind === 'answer' ? 'the developer answered' : p.kind === 'confirmed' ? 'decided for them, they confirmed' : `decided for them, they CONTESTED${p.note ? `: ${p.note}` : ''}`})`).join('\n');
  const plan = ctx.plan ? [ctx.plan.summary, ...ctx.plan.criteria.map((c) => `${c.id} ${c.text}`), ...ctx.plan.assumptions.map((a) => `assumed: ${a}`)].join('\n') : '';
  return [
    'You are the DECIDER of a software team. An agent of an automated pipeline asked the question below while working on',
    `feature "${ctx.feature}" (stage: ${ctx.stage}). You answer on the developer's behalf ONLY when what is already settled`,
    'for this project answers it — the plan and spec they validated, the project\'s written decisions and conventions, their',
    'past answers. You never invent a preference. When nothing settled answers it, say so (choice null, source none).',
    '',
    'Categories (pick the one that fits the CONSEQUENCE of the answer, the most severe when unsure):',
    '  reversible   — internal, invisible outside the code, cheap to change later (naming, structure, a helper)',
    '  visible      — visible to the developer but not the business (a library, a file layout, a test approach)',
    '  behavior     — changes what a user or the business sees or experiences (UX, copy, an edge case\'s outcome)',
    '  contract     — changes an interface other code depends on (API shape, schema, events)',
    '  cost         — spends money or paid resources',
    '  security     — authentication, authorization, data exposure, secrets',
    '  irreversible — data loss, destructive migration, publishing, anything that cannot be undone',
    '',
    'Reply with ONLY this JSON object, nothing else:',
    '{"choice": "<one option label, exactly as written, or null>", "category": "<one category>",',
    ' "source": {"kind": "plan|spec|decision|convention|preference|code|none", "ref": "<section, line or id>", "quote": "<the words that settle it>"},',
    ' "rationale": "<one sentence>"}',
    '',
    `QUESTION${q.header ? ` [${q.header}]` : ''}: ${q.question}`,
    'OPTIONS:',
    ...q.options.map((o) => `- ${o.label}${o.description ? ` — ${o.description}` : ''}`),
    '',
    '=== PLAN (validated by the developer at CP1) ===', plan || '(none)',
    '', '=== SPEC ===', clip(ctx.spec, 24000) || '(none)',
    '', '=== PROJECT DECISIONS (specs/_decisions.md) ===', clip(ctx.decisions, 6000) || '(none)',
    '', '=== CONVENTIONS (PIPELINE.md) ===', clip(ctx.conventions, 6000) || '(none)',
    '', '=== THE DEVELOPER\'S PAST ANSWERS ===', prefs || '(none yet)',
  ].join('\n');
}

/** §Conventions of a PIPELINE.md (the prose section after the machine block). */
export function conventionsOf(pipelineMd: string): string {
  const m = pipelineMd.match(/^## Conventions\s*$([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------------------------------------------------------
// The votes

export class Decider {
  bin: string;
  constructor({ bin }: { bin?: string } = {}) { this.bin = bin || process.env.COHORTE_CLAUDE_BIN || 'claude'; }

  vote(prompt: string, model: string, cwd: string, options: string[]): Promise<Vote> {
    return new Promise((resolve) => {
      // A vote is one turn with no tools, no MCP servers, no settings and a one-line system prompt: measured at
      // ~700 input tokens ($0.0001 on haiku) where a default session costs 230k tokens before it says a word.
      const args = ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
        '--no-session-persistence', '--system-prompt', 'You are a careful decider. You reply with exactly one JSON object and nothing else.'];
      let out = '';
      let child;
      try { child = spawn(this.bin, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, COHORTE_DECIDER: '1' } }); } catch { resolve(parseVote('', options)); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 120000);
      child.stdout.on('data', (d: Buffer) => { out += d; });
      child.on('error', () => { clearTimeout(timer); resolve(parseVote('', options)); });
      child.on('close', () => {
        clearTimeout(timer);
        let text = out;
        try { const v = JSON.parse(out); if (typeof v.result === 'string') text = v.result; } catch { /* plain text */ }
        resolve(parseVote(text, options));
      });
      child.stdin.on('error', () => { /* closed early */ });
      child.stdin.end(prompt);
    });
  }

  async round(prompt: string, model: string, n: number, cwd: string, options: string[]): Promise<Tally> {
    return tally(await Promise.all(Array.from({ length: n }, () => this.vote(prompt, model, cwd, options))));
  }

  /** One question (single-select). Multi-select and free-text questions always go to the human. */
  async decide(q: PendingQuestion, ctx: DeciderContext, s: { autonomy: Autonomy; votes: number; model: string; escalation: string }, cwd: string): Promise<Outcome> {
    const declared = headerCategory(q.header);
    const advice = (t: Tally | null, why: string): Outcome => ({ decided: false, advice: { choice: t?.choice ?? null, rationale: t?.rationale || '', agreement: t?.agreement ?? 0, category: t?.category || declared || '', escalated: why } });
    if (q.multiSelect || !q.options.length) return advice(null, 'multi-select or open question');
    if (declared && HUMAN_ONLY.includes(declared)) return advice(null, `the agent marked it ${declared}`);
    const options = q.options.map((o) => o.label);
    const prompt = promptFor(q, ctx);
    const first = await this.round(prompt, s.model, s.votes, cwd, options);
    const why1 = refusal(first, s.autonomy);
    if (!why1) return { decided: true, choice: first.choice as string, tally: first, model: s.model };
    if (reversibleDefault(first, q, s.autonomy)) return reversibleDefault(first, q, s.autonomy) as Outcome;
    // Escalate only a split: a refusal on category or source would be the same on a bigger model.
    if (!/votes split|no option/.test(why1) || s.escalation === s.model) return advice(first, why1);
    const second = await this.round(prompt, s.escalation, s.votes, cwd, options);
    const why2 = refusal(second, s.autonomy);
    if (!why2) return { decided: true, choice: second.choice as string, tally: second, model: s.escalation };
    return reversibleDefault(second, q, s.autonomy) || advice(second, why2);
  }
}
