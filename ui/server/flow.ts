// The company flow — business → developers → the code host → business — driven from cohorte ui.
//
//   PO conversation ──► draft tickets ──[CP0: the requester validates]──► backlog
//   a developer takes one ──► worktree ──► lead conversation ──► plan ──[CP1: the developer validates]──► spec frozen
//   autopilot: build → review → (fix → review)* → verify, each stage a FRESH `claude -p` session (no /clear, ever)
//        ├─ questions mid-run go to the decider first; what it cannot settle waits for the developer
//        └─ [CP2: course check] opens only on a signal (next.ts)
//   [CP3: the developer signs off] ──► /cohorte-ship opens the PR ──► the human merges (or tells cohorte ui to)
//   merged ──► /cohorte-learn writes the journal ──► the PO writes the acceptance note ──[CP4: the requester accepts]
//
// Every agent run here is a Runs run (runs.ts) with a role; this module reacts to their ends (hooks), owns the
// tracker writes and the feature record, and never lets its own failure take a run down.

import fs from 'fs';
import path from 'path';
import { registry, doctor, type Project } from './legacy';
import type { Jobs, Job } from './jobs';
import type { Pending, Run, Runs } from './runs';
import { FeatureStore, type Feature } from './features';
import { SettingsStore } from './settings';
import { Decider, Preferences, conventionsOf, type DeciderContext } from './decider';
import { lastOf, proposalsOf, toAcceptance, toPlan } from '../shared/blocks';
import { Tracker, isTicketId, ticketBrief, trackerFor } from './tracker';
import { nextStep, type Signals, type Stage } from './next';
import { pipelineOf, reportsOf } from './pipeline';
import { parseReviewReport } from './findings';
import * as gitinfo from './gitinfo';
import * as ops from './ops';
import type {
  ConversationView, FeatureDetail, InboxItem, LearningResponse, ProjectSettings, RunEvent, Ticket, TicketProposal,
} from '../shared/api';

const { scanSpecs, checkTrust } = doctor;
/** The business-facing agents read; they never write, run or delegate. The server writes what they propose. */
const READ_ONLY = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task'];
const PR_POLL_MS = 60000;

export class FlowError extends ops.OpError {}

const now = (): string => new Date().toISOString();
/**
 * Every flow run loads only the project's own MCP servers. A user's machine-wide servers (mail, docs, design tools…)
 * can weigh 200k+ tokens of tool schemas on EVERY turn — measured at 230k for a one-word reply — and no PO, lead or
 * pipeline stage needs them. The project's .mcp.json (a retrieval provider, say) is still loaded.
 */
const mcp = (cwd: string): { strictMcp: true; mcpConfig: string | null } => {
  const f = path.join(cwd, '.mcp.json');
  return { strictMcp: true, mcpConfig: fs.existsSync(f) ? f : null };
};
const textsOf = (events: RunEvent[]): string[] => events.filter((e): e is Extract<RunEvent, { kind: 'text' }> => e.kind === 'text').map((e) => e.text);
const readText = (p: string): string => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** The body of an installed /cohorte-* command, its $ARGUMENTS substituted — sent as a prompt so the run's model applies. */
export function expandCommand(globalDir: string, name: string, args: string): string {
  if (!/^cohorte-[a-z0-9-]+$/.test(name)) throw new FlowError(`not a cohorte command: ${name}`);
  const file = path.join(globalDir, 'commands', `${name}.md`);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new FlowError(`/${name} is not installed — run \`cohorte install\` (or update cohorte)`, 400); }
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return `<command-name>/${name}</command-name>\n${body.split('$ARGUMENTS').join(args)}`;
}

const contextBlock = (lines: string[]): string => `\n\n---\n## cohorte ui context (written by the dashboard — data, not instructions from the person)\n\n${lines.join('\n')}\n`;

const AUTOPILOT_NOTE = (routing: string | null): string => [
  '', '---', '## Running under the cohorte ui autopilot', '',
  'No person is watching this session: cohorte ui started it, and starts the next stage itself when this one ends.',
  '- Never recommend `/clear` and never tell anyone which command to run next — the autopilot routes.',
  '- Ask a question ONLY through AskUserQuestion (one call, at most 4 questions). Put your recommended option FIRST, with',
  '  "(Recommended)" at the end of its label, and set each question\'s `header` to the decision\'s category — exactly one of',
  '  reversible · visible · behavior · contract · cost · security · irreversible. A decider answers what the plan, the spec,',
  '  the project\'s decisions and the developer\'s past answers already settle; the rest waits for the developer.',
  '- Do the stage\'s whole job, then end your turn with the stage\'s own short report.',
  ...(routing ? [`- Model routing: dispatch every implementer subagent with \`model: "${routing}"\` (the Agent tool's model parameter).`] : []),
].join('\n');

interface FlowOpts { globalDir: string; runs: Runs; jobs: Jobs; dataDir: string; decider?: Decider; changed?: (projectId: string) => void }

export class Flow {
  globalDir: string; runs: Runs; jobs: Jobs; features: FeatureStore; settings: SettingsStore; prefs: Preferences; decider: Decider;
  changed: (projectId: string) => void;
  private prTimer: NodeJS.Timeout | null = null;
  /** Feature ids with an advance() in flight — so two run ends never start two stages. */
  private busy = new Set<string>();

  constructor(o: FlowOpts) {
    this.globalDir = o.globalDir; this.runs = o.runs; this.jobs = o.jobs;
    this.features = new FeatureStore(path.join(o.dataDir, 'features'));
    this.settings = new SettingsStore(path.join(o.dataDir, 'settings'));
    this.prefs = new Preferences(path.join(o.dataDir, 'prefs'));
    this.decider = o.decider || new Decider();
    this.changed = o.changed || (() => {});
    this.runs.hooks = {
      onEnd: (r) => setImmediate(() => { void this.onEnd(r).catch((e) => this.fail(r, e)); }),
      onQuestion: (r, p) => this.onQuestion(r, p),
      onAnswered: (r, p, b, a, by) => this.onAnswered(r, p, b, a, by),
    };
    this.recover();
  }

  start(): void {
    if (this.prTimer) return;
    this.prTimer = setInterval(() => { void this.pollPRs(); }, PR_POLL_MS);
    this.prTimer.unref();
  }
  stop(): void { if (this.prTimer) clearInterval(this.prTimer); this.prTimer = null; }

  // -------------------------------------------------------------------------------------------------------------
  // helpers

  project(projectId: string): Project {
    const p = registry.get(this.globalDir, projectId);
    if (!p) throw new FlowError('unknown project', 404);
    return p;
  }
  tracker(p: Project): Tracker { return trackerFor(this.globalDir, p.root, p.id); }
  private fail(r: Run, e: unknown): void {
    const id = r.meta.featureId;
    if (!id) return;
    const f = this.features.get(r.projectId, id);
    if (f) this.features.phase(f, 'cp2', { kind: 'cp2', reason: `cohorte ui hit an error: ${String((e as Error)?.message || e)}`, openedAt: now() });
    this.changed(r.projectId);
  }
  private profileOf(root: string) { return ops.readProfile(root); }
  private specOf(f: Feature): { id: string; status?: string; kind?: string; file?: string } | null {
    if (!f.worktree) return null;
    return (scanSpecs(f.worktree) as { id: string; status?: string; file?: string }[]).find((s) => s.id === f.id) || null;
  }
  private setTicket(p: Project, id: string, patch: Partial<Ticket>): void {
    const tr = this.tracker(p);
    const t = tr.update(id, patch);
    if (t && patch.status) void tr.move(t);
  }
  private ticketOf(p: Project, id: string): Ticket | null { return this.tracker(p).get(id); }

  // -------------------------------------------------------------------------------------------------------------
  // PO — the business conversation (CP0)

  startPO(projectId: string, body: { text?: unknown; requester?: unknown; parent?: unknown }): Run {
    const p = this.project(projectId);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 8000) throw new FlowError('a message of 1 to 8000 characters is required');
    const s = this.settings.get(p.id);
    const requester = typeof body.requester === 'string' && body.requester.trim() ? body.requester.trim().slice(0, 80) : s.requester;
    const parent = isTicketId(body.parent) ? body.parent : null;
    const prof = this.profileOf(p.root);
    const tickets = this.tracker(p).list().filter((t) => t.status !== 'rejected').slice(0, 80);
    const productMap = path.join(p.root, 'PRODUCT.md');
    const parentTicket = parent ? this.ticketOf(p, parent) : null;
    const prompt = expandCommand(this.globalDir, 'cohorte-po', text) + contextBlock([
      `Project: ${prof.name || path.basename(p.root)}${prof.one_liner ? ` — ${prof.one_liner}` : ''}`,
      `Talk in: ${prof.ui_language || 'the language the person writes in'}`,
      `The person: ${requester || 'a member of the business team'}`,
      `Product map: ${fs.existsSync(productMap) ? productMap : 'none yet (PRODUCT.md is absent — rely on what the person tells you, and on the tickets below)'}`,
      '', 'Existing tickets (never duplicate one — say it exists, or propose a follow-up with "parent"):',
      ...(tickets.length ? tickets.map((t) => `- ${t.id} · ${t.status} · ${t.type} · ${t.title}`) : ['(none)']),
      ...(parentTicket ? ['', 'This conversation follows up a delivered ticket — the person is giving acceptance feedback on it:', ticketBrief(parentTicket),
        ...(parentTicket.acceptance ? ['', 'Its acceptance note said:', parentTicket.acceptance.summary] : [])] : []),
    ]);
    const run = this.runs.start({ ...mcp(p.root), projectId: p.id, cwd: p.root, command: '/cohorte-po', prompt, model: s.models.po, disallowedTools: READ_ONLY, echo: text,
      meta: { role: 'po', title: text.slice(0, 80), ticketId: parent || undefined } });
    this.changed(p.id);
    return run;
  }

  /** Upserts the draft tickets a PO turn proposed (status `validate` until the requester validates them: CP0). */
  private async onPOEnd(r: Run): Promise<void> {
    const p = this.project(r.projectId);
    const tr = this.tracker(p);
    const props = proposalsOf(textsOf(r.events));
    const requester = this.settings.get(p.id).requester;
    for (const prop of props) {
      const existing = r.tickets[prop.ref] ? tr.get(r.tickets[prop.ref]) : null;
      if (existing && !['discussion', 'validate'].includes(existing.status)) continue; // validated already: later revisions do not rewrite it
      const fields = { title: prop.title, type: prop.type, need: prop.need, value: prop.value, criteria: prop.criteria, outOfScope: prop.outOfScope,
        priority: prop.priority, size: prop.size, parent: prop.parent || r.meta.ticketId || null };
      const t = existing ? tr.update(existing.id, fields) : tr.create(prop, { status: 'validate', requester, conversation: r.id, parent: fields.parent });
      if (!t) continue;
      r.tickets[prop.ref] = t.id;
      if (!existing) await tr.move(t);
    }
    this.runs.store?.schedule(r, true);
  }

  conversations(projectId: string): ConversationView[] {
    return this.runs.forProject(projectId).filter((r) => r.meta.role === 'po').sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((r) => ({ runId: r.id, role: 'po' as const, title: r.meta.title || r.command, status: r.status, startedAt: r.startedAt, ticketId: r.meta.ticketId || null,
        tickets: { ...r.tickets }, pending: [...r.pending.values()].filter((x) => !x.deciding).length }));
  }

  /** CP0. `validate` → backlog; `reject` → rejected. */
  decideTicket(projectId: string, id: string, action: unknown): Ticket {
    const p = this.project(projectId);
    const tr = this.tracker(p);
    const t = tr.get(id);
    if (!t) throw new FlowError('unknown ticket', 404);
    if (action !== 'validate' && action !== 'reject') throw new FlowError('action must be validate or reject');
    if (!['discussion', 'validate'].includes(t.status)) throw new FlowError(`this ticket is already ${t.status}`, 409);
    const next = tr.update(id, { status: action === 'validate' ? 'backlog' : 'rejected' }) as Ticket;
    void tr.move(next);
    this.changed(p.id);
    return next;
  }

  /** A ticket that needs no business discussion (tech debt, an upgrade, a bug a developer found): straight to the backlog. */
  createTicket(projectId: string, body: Record<string, unknown>): Ticket {
    const p = this.project(projectId);
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    if (!title) throw new FlowError('a title is required');
    const type = body.type === 'bug' || body.type === 'feature' ? body.type : 'tech';
    const need = typeof body.need === 'string' ? body.need.trim().slice(0, 8000) : '';
    const criteria = Array.isArray(body.criteria) ? body.criteria.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, 30) : [];
    const tr = this.tracker(p);
    const t = tr.create({ title, type, need, criteria } as TicketProposal, { status: 'backlog', requester: this.settings.get(p.id).requester });
    void tr.move(t);
    this.changed(p.id);
    return t;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Lead — a developer takes a ticket (worktree, framing, CP1)

  take(projectId: string, ticketId: string, { confirmed = false } = {}): Feature {
    const p = this.project(projectId);
    const t = this.ticketOf(p, ticketId);
    if (!t) throw new FlowError('unknown ticket', 404);
    const existing = this.features.get(p.id, ticketId);
    if (existing && !['abandoned', 'failed'].includes(existing.phase)) throw new FlowError('this ticket is already being worked on', 409);
    if (!['backlog', 'framing'].includes(t.status) && !existing) throw new FlowError(`only a backlog ticket can be taken (this one is ${t.status})`, 409);
    if (!ops.FEATURE_ID.test(ticketId)) throw new FlowError('the ticket id is not a valid feature id');
    const wt = this.worktreeFor(p, ticketId);
    const f = existing || this.features.create(p.id, ticketId, t.title);
    f.error = null; f.checkpoint = null;
    if (wt) {
      f.worktree = wt.path; f.branch = wt.branch;
      this.features.save(f);
      this.startLead(p, f);
    } else {
      ops.createWorktree(this.jobs, p, ticketId, { confirmed }); // throws OpError (gate ask, bad id) before anything is recorded
      this.features.phase(f, 'provisioning');
    }
    this.setTicket(p, ticketId, { status: 'framing' });
    this.changed(p.id);
    return f;
  }

  private worktreeFor(p: Project, id: string): { path: string; branch: string | null } | null {
    const prefix = this.profileOf(p.root).vcs?.feature_branch_prefix || 'feature/';
    const wts = registry.worktrees(p.root).slice(1);
    return wts.find((w) => w.branch === `${prefix}${id}`) || wts.find((w) => path.basename(w.path) === `${path.basename(p.root)}-${id}`) || null;
  }

  onJob(job: Job): void {
    if (job.kind !== 'worktree-create' || !job.tag || job.status === 'running' || job.status === 'starting') return;
    const f = this.features.get(job.projectId, job.tag);
    if (!f || f.phase !== 'provisioning') return;
    let p: Project;
    try { p = this.project(job.projectId); } catch { return; }
    if (job.status !== 'done') {
      this.features.phase(f, 'failed', null, `the worktree could not be created:\n${job.lines.slice(-12).join('\n')}`);
      this.changed(p.id);
      return;
    }
    const wt = this.worktreeFor(p, f.id);
    if (!wt) { this.features.phase(f, 'failed', null, 'the worktree job finished but no worktree was found for this feature'); this.changed(p.id); return; }
    f.worktree = wt.path; f.branch = wt.branch;
    this.features.save(f);
    try { this.startLead(p, f); } catch (e) { this.features.phase(f, 'failed', null, String((e as Error).message || e)); }
    this.changed(p.id);
  }

  private startLead(p: Project, f: Feature): void {
    const t = this.ticketOf(p, f.id);
    if (!t || !f.worktree) throw new FlowError('the ticket or its worktree is gone');
    const trust = checkTrust(f.worktree, this.globalDir);
    f.warning = trust.status === 'warn' ? `${trust.detail} — fix: ${trust.fix}` : null;
    const s = this.settings.get(p.id);
    const prompt = expandCommand(this.globalDir, 'cohorte-lead', f.id) + contextBlock([
      `Worktree: ${f.worktree} (branch ${f.branch || '?'}) — every file you write goes here.`,
      `Product map: ${fs.existsSync(path.join(p.root, 'PRODUCT.md')) ? path.join(p.root, 'PRODUCT.md') : 'none'}`,
      '', 'THE TICKET (validated by the business at CP0):', ticketBrief(t),
    ]);
    const run = this.runs.start({ ...mcp(f.worktree), projectId: p.id, cwd: f.worktree, command: `/cohorte-lead ${f.id}`, prompt, model: s.models.lead, permissionMode: 'acceptEdits',
      meta: { role: 'lead', featureId: f.id, ticketId: f.id, title: t.title } });
    f.leadRunId = run.id;
    this.features.phase(f, 'framing');
  }

  /** The developer writes to the lead (framing, or after CP1/CP2 asked to re-frame). */
  replyLead(projectId: string, id: string, text: unknown): void {
    const p = this.project(projectId);
    const f = this.mustFeature(p.id, id);
    if (!['framing', 'cp1', 'cp2'].includes(f.phase)) throw new FlowError(`the lead is not in a conversation (the feature is in ${f.phase})`, 409);
    const run = f.leadRunId ? this.runs.get(f.leadRunId) : null;
    if (!run) throw new FlowError('the lead conversation is gone', 410);
    const err = this.runs.reply(run, text);
    if (err) throw new FlowError(err, 409);
    if (f.phase === 'cp2') f.corrections.push({ at: now(), checkpoint: 'cp2', text: String(text) });
    this.features.phase(f, 'framing');
    this.changed(p.id);
  }

  private async onLeadEnd(r: Run, f: Feature): Promise<void> {
    const p = this.project(r.projectId);
    const spec = this.specOf(f);
    if (f.phase === 'freezing') {
      if (spec && spec.status && spec.status !== 'draft') {
        this.features.phase(f, 'autopilot');
        this.setTicket(p, f.id, { status: 'building' });
        await this.advance(p, f);
      } else {
        this.features.phase(f, 'cp1', { kind: 'cp1', reason: 'the lead did not freeze the spec — answer it, or approve again', openedAt: now() });
      }
      return;
    }
    const plan = lastOf(textsOf(r.events), 'cohorte-plan', toPlan);
    if (plan && r.status === 'done') {
      f.plan = plan;
      this.features.phase(f, 'cp1', { kind: 'cp1', reason: 'the plan is ready', openedAt: now() });
    } else if (r.status !== 'done') {
      this.features.phase(f, 'framing', null, `the lead run ${r.status}${r.result?.text ? `: ${r.result.text.slice(0, 300)}` : ''}`);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Checkpoints

  checkpoint(projectId: string, id: string, body: { action?: unknown; text?: unknown }): Feature {
    const p = this.project(projectId);
    const f = this.mustFeature(p.id, id);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
    const action = body.action;
    const cp = f.checkpoint?.kind;
    if (action === 'abandon') {
      const run = f.currentRunId ? this.runs.get(f.currentRunId) : null;
      if (run) this.runs.stop(run);
      this.features.phase(f, 'abandoned');
      this.setTicket(p, f.id, { status: 'backlog' });
      this.learn(p, f, 'abandoned');
      this.changed(p.id);
      return f;
    }
    if (!cp) throw new FlowError('no checkpoint is open on this feature', 409);
    if (cp === 'cp1') {
      if (action === 'approve') {
        const run = f.leadRunId ? this.runs.get(f.leadRunId) : null;
        if (!run) throw new FlowError('the lead conversation is gone', 410);
        const err = this.runs.reply(run, [
          'CP1 APPROVED in cohorte ui — the developer validated your plan.', text ? `They add: ${text}` : '',
          'Freeze the spec now (status: frozen, decisions journal, design brief if any), exactly as your instructions say for the freeze, then end your turn with one line.',
        ].filter(Boolean).join('\n'));
        if (err) throw new FlowError(err, 409);
        this.features.phase(f, 'freezing');
      } else if (action === 'reply') {
        this.replyLead(p.id, id, text);
      } else throw new FlowError('CP1 takes approve, reply or abandon');
    } else if (cp === 'cp2') {
      if (action === 'continue') {
        f.reservationsAck = true; f.failures = {};
        const last = f.stages[f.stages.length - 1];
        if (last && last.status === 'stopped') last.status = 'failed';
        if (text) f.corrections.push({ at: now(), checkpoint: 'cp2', text });
        this.features.phase(f, 'autopilot');
        void this.advance(p, f);
      } else if (action === 'correct') {
        if (!text) throw new FlowError('say what to correct');
        f.corrections.push({ at: now(), checkpoint: 'cp2', text });
        f.reservationsAck = true; f.failures = {};
        this.features.phase(f, 'autopilot');
        this.startStage(p, f, 'fix', this.settings.get(p.id).models.fix, `${f.id} ${text.replace(/\s+/g, ' ')}`, 'correction from the developer at CP2');
      } else if (action === 'reframe') {
        if (!text) throw new FlowError('say what the lead should change');
        const run = f.leadRunId ? this.runs.get(f.leadRunId) : null;
        if (!run) throw new FlowError('the lead conversation is gone', 410);
        const err = this.runs.reply(run, `The autopilot paused at CP2: ${f.checkpoint?.reason}.\nThe developer asks you to re-frame: ${text}\nUpdate the spec (it may be frozen: edit it in place, keep it frozen) and post a new cohorte-plan block.`);
        if (err) throw new FlowError(err, 409);
        f.corrections.push({ at: now(), checkpoint: 'cp2', text });
        this.features.phase(f, 'framing');
      } else throw new FlowError('CP2 takes continue, correct, reframe or abandon');
    } else if (cp === 'cp3') {
      if (action === 'approve') {
        for (const d of f.decisions) if (d.by === 'decider' && !d.contested && !d.confirmed) {
          d.confirmed = true;
          this.prefs.add(p.id, { feature: f.id, question: d.question, header: d.header, answer: d.chosen, kind: 'confirmed' });
        }
        this.features.save(f);
        this.startStage(p, f, 'ship', this.settings.get(p.id).models.ship, f.id, 'approved at CP3');
        this.features.phase(f, 'shipping');
      } else if (action === 'correct') {
        if (!text) throw new FlowError('say what to correct');
        f.corrections.push({ at: now(), checkpoint: 'cp3', text });
        this.features.phase(f, 'autopilot');
        f.rounds = 0; // a human correction starts a fresh loop budget
        this.startStage(p, f, 'fix', this.settings.get(p.id).models.fix, `${f.id} ${text.replace(/\s+/g, ' ')}`, 'correction from the developer at CP3');
      } else throw new FlowError('CP3 takes approve, correct or abandon');
    }
    const status = ['framing', 'cp1', 'freezing'].includes(f.phase) ? 'framing' : ['cp3', 'shipping'].includes(f.phase) ? 'checkpoint' : 'building';
    this.setTicket(p, f.id, { status });
    this.changed(p.id);
    return f;
  }

  /** "I would not have decided that": the decision is marked, the preference learned, and the note queued as a correction. */
  contest(projectId: string, id: string, decisionId: string, note: unknown): Feature {
    const p = this.project(projectId);
    const f = this.mustFeature(p.id, id);
    const d = f.decisions.find((x) => x.id === decisionId);
    if (!d) throw new FlowError('unknown decision', 404);
    const n = typeof note === 'string' ? note.trim().slice(0, 2000) : '';
    d.contested = { at: now(), note: n }; d.confirmed = false;
    this.prefs.add(p.id, { feature: f.id, question: d.question, header: d.header, answer: d.chosen, kind: 'contested', note: n });
    this.features.save(f);
    this.changed(p.id);
    return f;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Autopilot

  private signals(f: Feature, spec: { id: string; status?: string; kind?: string }): Signals {
    const wt = f.worktree as string;
    const rep = reportsOf(wt, f.id);
    const sev = (rep.verdict?.severity || {}) as Record<string, number>;
    return {
      pipeline: pipelineOf(wt, spec), readiness: typeof rep.readiness?.verdict === 'string' ? rep.readiness.verdict : null,
      verdict: rep.verdict ? { verdict: typeof rep.verdict.verdict === 'string' ? rep.verdict.verdict : null, blocking: typeof rep.verdict.blocking === 'number' ? rep.verdict.blocking : null,
        high: Number(sev.HIGH) || 0, medium: Number(sev.MEDIUM) || 0, aborted: typeof rep.verdict.aborted === 'string' ? rep.verdict.aborted : null } : null,
      verify: typeof rep.verify?.verdict === 'string' ? rep.verify.verdict : null,
      buildDead: Array.isArray(rep.build?.dead) && rep.build.dead.length > 0,
    };
  }

  async advance(p: Project, f: Feature): Promise<void> {
    if (f.phase !== 'autopilot' || this.busy.has(f.id)) return;
    if (f.currentRunId) { const r = this.runs.get(f.currentRunId); if (r && r.status === 'running') return; }
    this.busy.add(f.id);
    try {
      const s = this.settings.get(p.id);
      const spec = this.specOf(f);
      if (!spec) { this.features.phase(f, 'cp2', { kind: 'cp2', reason: `no specs/${f.id}.md in the worktree`, openedAt: now() }); return; }
      if (!s.autopilot) { this.features.phase(f, 'cp2', { kind: 'cp2', reason: 'the autopilot is off for this project — continue to run the next stage', openedAt: now() }); return; }
      const step = nextStep(f.id, this.signals(f, spec), f, s);
      if (step.kind === 'checkpoint') {
        this.features.phase(f, step.cp, { kind: step.cp, reason: step.reason, openedAt: now() });
        this.setTicket(p, f.id, { status: step.cp === 'cp3' ? 'checkpoint' : 'building' });
        return;
      }
      if (step.stage === 'fix') f.rounds += 1;
      this.startStage(p, f, step.stage, step.model, step.args, step.note);
    } finally {
      this.busy.delete(f.id);
      this.changed(p.id);
    }
  }

  private startStage(p: Project, f: Feature, stage: Stage | 'ship' | 'learn', model: string, args: string, note: string): Run {
    if (!f.worktree) throw new FlowError('the feature has no worktree');
    const s = this.settings.get(p.id);
    const routing = stage === 'build' || stage === 'fix' ? s.models.implementer : null;
    let extra = AUTOPILOT_NOTE(routing);
    if (stage === 'ship') extra += '\n- The developer APPROVED shipping at CP3 in cohorte ui: that is the confirmation your §1 asks for — do not ask it again. Every OTHER question (ship anyway on open DoD items, not verified at runtime, the release level) still goes through AskUserQuestion.';
    const prompt = expandCommand(this.globalDir, `cohorte-${stage}`, args) + extra;
    const run = this.runs.start({ ...mcp(f.worktree), projectId: p.id, cwd: f.worktree, command: `/cohorte-${stage} ${args.split(' ')[0]}`, prompt, model, permissionMode: 'acceptEdits',
      meta: { role: 'stage', featureId: f.id, ticketId: f.ticketId, stage, title: f.title } });
    f.stages.push({ stage, runId: run.id, model, status: 'running', costUsd: null, startedAt: run.startedAt, endedAt: null, note: note || undefined });
    f.currentRunId = run.id;
    this.features.save(f);
    return run;
  }

  private async onStageEnd(r: Run, f: Feature): Promise<void> {
    const p = this.project(r.projectId);
    const rec = f.stages.find((x) => x.runId === r.id);
    if (rec) { rec.status = r.status; rec.costUsd = r.result?.costUsd ?? null; rec.endedAt = r.endedAt; if (r.status !== 'done' && r.result?.text) rec.note = r.result.text.slice(0, 200); }
    if (f.currentRunId === r.id) f.currentRunId = null;
    const stage = r.meta.stage || '';
    if (r.status === 'done') f.failures[stage] = 0; else f.failures[stage] = (f.failures[stage] || 0) + 1;
    if (stage === 'review' && r.status === 'done' && f.worktree) {
      const v = reportsOf(f.worktree, f.id).verdict;
      if (v && typeof v.blocking === 'number') f.lastBlocking = v.blocking;
    }
    this.features.save(f);
    if (stage === 'ship') return this.onShipEnd(p, f, r);
    if (stage === 'learn' || r.meta.stage === 'reconcile') return;
    if (f.phase === 'autopilot') await this.advance(p, f);
  }

  private async onShipEnd(p: Project, f: Feature, r: Run): Promise<void> {
    const spec = this.specOf(f);
    if (!spec || !['shipped', 'merged'].includes(String(spec.status))) {
      this.features.phase(f, 'cp3', { kind: 'cp3', reason: `the ship run ended without opening the PR${r.result?.text ? `: ${r.result.text.slice(0, 300)}` : ''}`, openedAt: now() });
      return;
    }
    const pull = f.branch && (await gitinfo.ghAvailable()) ? await gitinfo.pullFor(p.root, f.branch) : null;
    f.pr = pull ? { number: pull.number, url: pull.url, state: pull.state, checks: pull.checks } : null;
    this.features.phase(f, 'pr');
    this.setTicket(p, f.id, { status: 'pr', pr: pull ? `#${pull.number}` : null });
    if (pull && pull.state === 'MERGED') await this.onMerged(p, f);
  }

  // -------------------------------------------------------------------------------------------------------------
  // PR → merged → learn → acceptance (CP4)

  merge(projectId: string, id: string): Job {
    const p = this.project(projectId);
    const f = this.mustFeature(p.id, id);
    if (f.phase !== 'pr' || !f.pr) throw new FlowError('there is no open PR for this feature', 409);
    if (f.pr.checks === 'failure') throw new FlowError('the PR checks are red — fix them first', 409);
    const method = this.settings.get(p.id).mergeMethod;
    const job = this.jobs.start({ projectId: p.id, kind: 'merge', tag: f.id, label: `merge · PR #${f.pr.number}`, cwd: p.root, file: process.env.COHORTE_GH_BIN || 'gh',
      args: ['pr', 'merge', String(f.pr.number), `--${method}`] });
    this.features.phase(f, 'merging');
    this.changed(p.id);
    return job;
  }

  onMergeJob(job: Job): void {
    if (job.kind !== 'merge' || !job.tag || job.status === 'running' || job.status === 'starting') return;
    const f = this.features.get(job.projectId, job.tag);
    if (!f || f.phase !== 'merging') return;
    let p: Project;
    try { p = this.project(job.projectId); } catch { return; }
    if (job.status !== 'done') { this.features.phase(f, 'pr', null, `the merge failed:\n${job.lines.slice(-8).join('\n')}`); this.changed(p.id); return; }
    void this.onMerged(p, f);
  }

  async pollPRs(): Promise<void> {
    if (!(await gitinfo.ghAvailable())) return;
    for (const p of registry.load(this.globalDir)) {
      for (const f of this.features.list(p.id)) {
        if (f.phase !== 'pr' || !f.branch) continue;
        const pull = await gitinfo.pullFor(p.root, f.branch);
        if (!pull) continue;
        f.pr = { number: pull.number, url: pull.url, state: pull.state, checks: pull.checks };
        this.features.save(f);
        if (pull.state === 'MERGED') await this.onMerged(p, f);
        this.changed(p.id);
      }
    }
  }

  private async onMerged(p: Project, f: Feature): Promise<void> {
    if (['closing', 'acceptance', 'done'].includes(f.phase)) return;
    if (f.pr) f.pr.state = 'MERGED';
    this.features.phase(f, 'closing');
    this.learn(p, f, 'merged');
  }

  /** /cohorte-learn writes the journal; on a merge the acceptance note follows, then the ship reconcile. */
  private learn(p: Project, f: Feature, why: 'merged' | 'abandoned'): void {
    if (!f.worktree || !fs.existsSync(f.worktree)) { if (why === 'merged') this.startAcceptance(p, f); return; }
    try {
      this.startStage(p, f, 'learn', this.settings.get(p.id).models.learn, `${f.id} ${why}`, why);
    } catch (e) {
      f.warning = `the journal was not written: ${String((e as Error).message || e)}`;
      this.features.save(f);
      if (why === 'merged') this.startAcceptance(p, f);
    }
  }

  private startAcceptance(p: Project, f: Feature): void {
    const t = this.ticketOf(p, f.id);
    if (!t) { this.features.phase(f, 'done'); return; }
    const s = this.settings.get(p.id);
    const specText = f.worktree ? readText(path.join(f.worktree, 'specs', `${f.id}.md`)) : readText(path.join(p.root, 'specs', `${f.id}.md`));
    const prompt = expandCommand(this.globalDir, 'cohorte-acceptance', f.id) + contextBlock([
      `Talk in: ${this.profileOf(p.root).ui_language || 'the language of the ticket'}`,
      f.pr ? `Merged: PR #${f.pr.number} ${f.pr.url}` : 'Merged.',
      '', 'THE TICKET:', ticketBrief(t), '', 'THE SPEC THE DEVELOPERS BUILT (technical — translate, never copy):', specText.slice(0, 30000) || '(not found)',
    ]);
    const run = this.runs.start({ ...mcp(p.root), projectId: p.id, cwd: p.root, command: `/cohorte-acceptance ${f.id}`, prompt, model: s.models.acceptance, disallowedTools: READ_ONLY,
      meta: { role: 'acceptance', featureId: f.id, ticketId: f.id, title: t.title } });
    f.stages.push({ stage: 'acceptance', runId: run.id, model: s.models.acceptance, status: 'running', costUsd: null, startedAt: run.startedAt, endedAt: null });
    this.features.save(f);
  }

  private async onAcceptanceEnd(r: Run, f: Feature): Promise<void> {
    const p = this.project(r.projectId);
    const rec = f.stages.find((x) => x.runId === r.id);
    if (rec) { rec.status = r.status; rec.costUsd = r.result?.costUsd ?? null; rec.endedAt = r.endedAt; }
    const note = lastOf(textsOf(r.events), 'cohorte-acceptance', toAcceptance);
    if (!note) {
      this.features.phase(f, 'acceptance', null, 'the acceptance note could not be written — the ticket waits for acceptance without it');
    } else {
      this.setTicket(p, f.id, { status: 'acceptance', acceptance: { ...note, at: now() } });
      this.features.phase(f, 'acceptance');
    }
    // The pipeline's own close-out: spec → merged, worktree teardown proposal, report buffer cleared.
    if (f.worktree && fs.existsSync(f.worktree)) {
      try {
        const run = this.runs.start({ ...mcp(f.worktree), projectId: p.id, cwd: f.worktree, command: `/cohorte-ship ${f.id}`, prompt: expandCommand(this.globalDir, 'cohorte-ship', f.id) + AUTOPILOT_NOTE(null),
          model: this.settings.get(p.id).models.ship, permissionMode: 'acceptEdits', meta: { role: 'stage', featureId: f.id, ticketId: f.id, stage: 'reconcile', title: f.title } });
        f.stages.push({ stage: 'reconcile', runId: run.id, model: run.model || '', status: 'running', costUsd: null, startedAt: run.startedAt, endedAt: null });
        this.features.save(f);
      } catch { /* the reconcile is a convenience; doctor does the same */ }
    }
  }

  /** CP4 — the requester's answer on the delivery. `not-quite` opens a follow-up PO conversation, seeded and linked. */
  acceptance(projectId: string, ticketId: string, body: { action?: unknown; text?: unknown }): { ticket: Ticket; run: Run | null } {
    const p = this.project(projectId);
    const tr = this.tracker(p);
    const t = tr.get(ticketId);
    if (!t) throw new FlowError('unknown ticket', 404);
    if (t.status !== 'acceptance') throw new FlowError(`this ticket is not waiting for acceptance (it is ${t.status})`, 409);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
    let run: Run | null = null;
    let next: Ticket;
    if (body.action === 'accept') {
      next = tr.update(ticketId, { status: 'done', feedback: text ? [...t.feedback, `${now().slice(0, 10)} · accepted · ${text}`] : t.feedback }) as Ticket;
    } else if (body.action === 'not-quite') {
      if (!text) throw new FlowError('say what is not quite right');
      next = tr.update(ticketId, { status: 'done', feedback: [...t.feedback, `${now().slice(0, 10)} · not quite · ${text}`] }) as Ticket;
      run = this.startPO(p.id, { text: `Feedback on the delivered ticket "${t.title}" (${t.id}): ${text}`, requester: t.requester, parent: t.id });
    } else throw new FlowError('action must be accept or not-quite');
    void tr.move(next);
    const f = this.features.get(p.id, ticketId);
    if (f) this.features.phase(f, 'done');
    this.changed(p.id);
    return { ticket: next, run };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Product map

  startProductMap(projectId: string): Run {
    const p = this.project(projectId);
    if (this.runs.find(p.id, p.root)) throw new FlowError('something is already running in the main checkout', 409);
    const s = this.settings.get(p.id);
    return this.runs.start({ ...mcp(p.root), projectId: p.id, cwd: p.root, command: '/cohorte-product-map', prompt: expandCommand(this.globalDir, 'cohorte-product-map', '') + AUTOPILOT_NOTE(null),
      model: s.models.productMap, permissionMode: 'acceptEdits', meta: { role: 'product-map', title: 'Product map' } });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Run hooks

  private async onEnd(r: Run): Promise<void> {
    if (r.meta.role === 'po') { await this.onPOEnd(r); this.changed(r.projectId); return; }
    const id = r.meta.featureId;
    if (!id) return;
    const f = this.features.get(r.projectId, id);
    if (!f) return;
    if (r.meta.role === 'lead') await this.onLeadEnd(r, f);
    else if (r.meta.role === 'acceptance') await this.onAcceptanceEnd(r, f);
    else if (r.meta.role === 'stage') {
      await this.onStageEnd(r, f);
      if (r.meta.stage === 'learn' && f.phase === 'closing') this.startAcceptance(this.project(r.projectId), f);
    }
    this.changed(r.projectId);
  }

  /** A stage run asked a question: the decider takes it first (the ship stage and the conversations never). */
  private onQuestion(r: Run, p: Pending): boolean {
    if (r.meta.role !== 'stage' || !r.meta.featureId || ['ship', 'reconcile'].includes(r.meta.stage || '')) return false;
    const f = this.features.get(r.projectId, r.meta.featureId);
    if (!f) return false;
    void this.decide(r, p, f).catch(() => this.runs.annotate(r, p.requestId, { deciding: false }));
    return true;
  }

  private deciderContext(f: Feature, stage: string, projectId: string): DeciderContext {
    const wt = f.worktree || '';
    return {
      plan: f.plan, spec: readText(path.join(wt, 'specs', `${f.id}.md`)), decisions: readText(path.join(wt, 'specs', '_decisions.md')),
      conventions: conventionsOf(readText(path.join(wt, 'PIPELINE.md'))), preferences: this.prefs.list(projectId), stage, feature: f.id,
    };
  }

  private async decide(r: Run, p: Pending, f: Feature): Promise<void> {
    const s: ProjectSettings = this.settings.get(r.projectId);
    const ctx = this.deciderContext(f, r.meta.stage || '', r.projectId);
    const qs = p.questions || [];
    const outcomes = await Promise.all(qs.map((q) => this.decider.decide(q, ctx, { autonomy: s.autonomy, votes: s.deciderVotes, model: s.models.decider, escalation: s.models.deciderEscalation }, r.cwd)));
    if (!r.pending.has(p.requestId)) return; // answered by hand meanwhile
    const undecided = outcomes.find((o) => !o.decided);
    if (undecided && !undecided.decided) { this.runs.annotate(r, p.requestId, { deciding: false, advice: undecided.advice }); this.changed(r.projectId); return; }
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => { const o = outcomes[i]; if (o.decided) answers[q.question] = o.choice; });
    qs.forEach((q, i) => {
      const o = outcomes[i];
      if (!o.decided) return;
      this.features.addDecision(f, { runId: r.id, stage: r.meta.stage || '', question: q.question, header: q.header, options: q.options.map((x) => x.label), chosen: o.choice,
        by: 'decider', agreement: o.tally.agreement, category: o.tally.category, source: o.tally.source, rationale: `${o.tally.rationale} (${o.model}, ${Math.round(o.tally.agreement * o.tally.votes)}/${o.tally.votes})` });
    });
    this.runs.respond(r, p.requestId, 'allow', answers, 'decider');
    this.changed(r.projectId);
  }

  /** What the developer answers by hand becomes a preference the decider reads next time. */
  private onAnswered(r: Run, p: Pending, behavior: 'allow' | 'deny', answers: Record<string, string>, by: 'human' | 'decider'): void {
    if (by !== 'human' || p.kind !== 'question' || behavior !== 'allow' || !r.meta.featureId) return;
    const f = this.features.get(r.projectId, r.meta.featureId);
    for (const q of p.questions || []) {
      const a = answers[q.question];
      if (!a) continue;
      this.prefs.add(r.projectId, { feature: r.meta.featureId, question: q.question, header: q.header, answer: a, kind: 'answer' });
      if (f && r.meta.role === 'stage') this.features.addDecision(f, { runId: r.id, stage: r.meta.stage || '', question: q.question, header: q.header, options: q.options.map((x) => x.label),
        chosen: a, by: 'human', agreement: null, category: p.advice?.category || null, source: null, rationale: p.advice ? `the decider handed it over: ${p.advice.escalated}` : '' });
    }
  }

  /** After a restart nothing is running: a feature that was mid-stage opens CP2 instead of guessing. */
  private recover(): void {
    for (const p of registry.load(this.globalDir)) {
      for (const f of this.features.list(p.id)) {
        if (!['autopilot', 'shipping', 'closing', 'freezing'].includes(f.phase)) continue;
        const r = f.currentRunId ? this.runs.get(f.currentRunId) : null;
        if (r && r.status === 'running') continue;
        for (const s of f.stages) if (s.status === 'running') s.status = 'stopped';
        f.currentRunId = null;
        this.features.phase(f, 'cp2', { kind: 'cp2', reason: 'cohorte ui restarted while this feature was running — continue to resume', openedAt: now() });
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reads

  mustFeature(projectId: string, id: string): Feature {
    const f = this.features.get(projectId, id);
    if (!f) throw new FlowError('unknown feature', 404);
    return f;
  }

  async detail(projectId: string, id: string): Promise<FeatureDetail> {
    const p = this.project(projectId);
    const f = this.mustFeature(p.id, id);
    const spec = this.specOf(f);
    const wt = f.worktree && fs.existsSync(f.worktree) ? f.worktree : null;
    const specText = wt ? readText(path.join(wt, 'specs', `${f.id}.md`)) : '';
    const dod = [...specText.matchAll(/^\s*- \[( |x|X)\] (.+)$/gm)].filter((m) => !/·\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*·/.test(m[2])).map((m) => ({ done: m[1] !== ' ', text: m[2].trim() })).slice(0, 60);
    const notes = wt ? readText(path.join(wt, 'specs', 'reports', `${f.id}.notes.md`)) : '';
    const assumptions = [...notes.matchAll(/^\s*- (.+)$/gm)].map((m) => m[1].trim()).slice(0, 40);
    const rr = wt ? parseReviewReport(readText(path.join(wt, 'specs', 'reports', `${f.id}.md`))) : null;
    let diff: FeatureDetail['diff'] = null;
    if (wt) { try { diff = (await gitinfo.worktreeGit(wt, this.profileOf(p.root).vcs?.default_branch || 'main')).diff; } catch { diff = null; } }
    return { ...f, pipeline: wt && spec ? pipelineOf(wt, spec) : null, ticket: this.ticketOf(p, f.id), review: rr ? { verdict: rr.verdict, findings: rr.findings, deferred: rr.deferred } : null, dod, assumptions, diff };
  }

  inbox(): InboxItem[] {
    const out: InboxItem[] = [];
    for (const p of registry.load(this.globalDir)) {
      if (!fs.existsSync(p.root)) continue;
      const name = this.profileOf(p.root).name || path.basename(p.root);
      const base = { projectId: p.id, projectName: name };
      for (const t of this.tracker(p).list()) {
        if (t.status === 'validate') out.push({ ...base, kind: 'cp0', ref: t.id, feature: null, title: t.title, detail: `ticket to validate${t.requester ? ` · ${t.requester}` : ''}`, at: t.updated });
        if (t.status === 'acceptance') out.push({ ...base, kind: 'cp4', ref: t.id, feature: null, title: t.title, detail: 'delivered — waiting for acceptance', at: t.updated });
      }
      for (const f of this.features.list(p.id)) {
        if (f.checkpoint) out.push({ ...base, kind: f.checkpoint.kind, ref: f.id, feature: f.id, title: f.title, detail: f.checkpoint.reason, at: f.checkpoint.openedAt });
        else if (f.phase === 'pr' && f.pr) out.push({ ...base, kind: 'pr', ref: f.id, feature: f.id, title: f.title, detail: `PR #${f.pr.number} open${f.pr.checks ? ` · checks ${f.pr.checks}` : ''} — merge it, or tell cohorte to`, at: f.updatedAt });
      }
      for (const r of this.runs.forProject(p.id)) {
        for (const x of r.pending.values()) {
          if (x.deciding) continue;
          out.push({ ...base, kind: x.kind === 'question' ? 'question' : 'permission', ref: r.id, feature: r.meta.featureId || null, title: r.meta.title || r.command,
            detail: x.kind === 'question' ? (x.questions || []).map((q) => q.question).join(' · ') : `${x.tool}: ${x.summary || ''}`, at: r.startedAt });
        }
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  learning(projectId: string): LearningResponse {
    const fs_ = this.features.list(projectId);
    const ds = fs_.flatMap((f) => f.decisions);
    const by = new Map<string, { stage: string; model: string; runs: number; ok: number; costUsd: number }>();
    for (const st of fs_.flatMap((f) => f.stages)) {
      const k = `${st.stage}|${st.model}`;
      const cur = by.get(k) || { stage: st.stage, model: st.model, runs: 0, ok: 0, costUsd: 0 };
      cur.runs += 1; if (st.status === 'done') cur.ok += 1; cur.costUsd += st.costUsd || 0;
      by.set(k, cur);
    }
    return {
      decisions: { total: ds.length, byDecider: ds.filter((d) => d.by === 'decider').length, contested: ds.filter((d) => !!d.contested).length, confirmed: ds.filter((d) => d.confirmed).length },
      preferences: this.prefs.list(projectId, 100000).length,
      stages: [...by.values()].map((x) => ({ ...x, costUsd: Math.round(x.costUsd * 10000) / 10000 })).sort((a, b) => a.stage.localeCompare(b.stage)),
    };
  }

}
