// Founding a project from cohorte ui (New project) — the company flow's first ticket, before there is a repo.
//
//   an idea ──► PO conversation (/cohorte-vision) ──► vision + first-version tickets ──[Vision: the requester validates]
//   (or a developer who knows what to build starts here)
//   ──► lead conversation (/cohorte-foundation) ──► stack plan ──[Foundations: the developer validates]
//   ──► /cohorte-scaffold: official generators, a walking skeleton, its checks green, committed
//   ──► /cohorte-init-pipeline (answers from the approved plan) ──► PIPELINE.md, gate, agents — committed
//   ──► done: the project is an ordinary cohorte project, its first-version tickets in the backlog.
//
// An existing folder without cohorte goes straight to the pipeline set-up step.
// The code host is never required: `remote()` / `connectRemote()` add one when the developer wants it.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { project as projectLib, registry, type Project } from './legacy';
import type { Run, Runs } from './runs';
import type { Job, Jobs } from './jobs';
import type { SettingsStore } from './settings';
import { escalate } from './settings';
import { conventionsOf } from './decider';
import { trackerFor } from './tracker';
import { AUTOPILOT_NOTE, FlowError, READ_ONLY, contextBlock, expandCommand, mcp, now, readText, textsOf } from './agents';
import { lastOf, proposalsOf, toFoundation, toScaffold, toVision } from '../shared/blocks';
import * as gitinfo from './gitinfo';
import * as ops from './ops';
import type { Foundation, FoundingMode, FoundingPhase, FoundingStage, FoundingView, NewProjectBody, RemoteInfo, RunRole, Vision } from '../shared/api';

export const FOUNDING_ROLES: readonly RunRole[] = ['vision', 'foundation', 'scaffold', 'setup'];
type Founding = FoundingView & { visionRunId: string | null; foundationRunId: string | null; setupRunId: string | null; scaffoldRuns: number; ticketIds: string[] };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: 30000 });
const expand = (p: string): string => p.trim().replace(/^~(?=$|[\\/])/, os.homedir());
const isCohorte = (root: string): boolean => fs.existsSync(path.join(root, 'PIPELINE.md')) && fs.existsSync(path.join(root, '.claude', 'pipeline.json'));
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.venv', 'venv', '__pycache__', 'target', '.idea', '.vscode', '.DS_Store', 'vendor', '.dart_tool']);

class FoundingStore {
  constructor(private dir: string) {}
  private file(id: string): string { return path.join(this.dir, `${id.replace(/[^A-Za-z0-9._-]/g, '')}.json`); }
  get(id: string): Founding | null { try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as Founding; } catch { return null; } }
  save(f: Founding): void {
    f.updatedAt = now();
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(f.projectId)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n');
    fs.renameSync(tmp, this.file(f.projectId));
  }
  list(): Founding[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    return names.map((n) => this.get(n.slice(0, -5))).filter((f): f is Founding => !!f);
  }
}

/** The vision as the product map's first version: what the product is FOR, before there is any code to describe. */
export function visionMarkdown(v: Vision, name: string): string {
  const ul = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
  return [
    `# ${v.name || name}`, '', `> ${v.pitch}`, '',
    '_Written from the vision validated when the project was founded. `/cohorte-product-map` rewrites this file from the code once the product exists._', '',
    '## Who it is for', '', ul(v.users), '', '## The problem', '', v.problem, '',
    ...(v.today ? ['## What they do today', '', v.today, ''] : []),
    '## The first version', '', ul(v.firstVersion), '',
    ...(v.later.length ? ['## Later — deliberately not in the first version', '', ul(v.later), ''] : []),
    ...(v.success ? ['## How we will know it works', '', v.success, ''] : []),
    ...(v.constraints.length ? ['## Constraints', '', ul(v.constraints), ''] : []),
    ...(v.language ? [`Users' language: ${v.language}`, ''] : []),
  ].join('\n');
}

/** The tools the approved plan names, as permission rules the scaffold may use without asking. Never a shell, a fetcher or a remover. */
const NEVER = new Set(['rm', 'sudo', 'su', 'curl', 'wget', 'sh', 'bash', 'zsh', 'fish', 'chmod', 'chown', 'dd', 'mv', 'eval', 'exec', 'ssh', 'scp', 'git', 'docker', 'kill', 'pkill', 'open', 'xargs', 'env', 'cd', 'source', 'export', 'set']);
export function scaffoldTools(plan: Foundation): string[] {
  const out = new Set<string>(['Bash(git init:*)', 'Bash(git status:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git log:*)', 'Bash(git diff:*)',
    'Bash(git rev-parse:*)', 'Bash(git branch:*)', 'Bash(cd:*)', 'Bash(mkdir:*)', 'Bash(ls:*)', 'Bash(pwd)', 'Bash(which:*)', 'Bash(cat:*)', 'Bash(echo:*)', 'Bash(test:*)', 'Bash(node --version)']);
  const cmds = [plan.devCommand, ...plan.surfaces.flatMap((s) => [s.generate || '', s.test, s.lint, s.build, s.packageManager])];
  for (const c of cmds) {
    for (const seg of c.split(/&&|\|\||;|\|/)) {
      const words = seg.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      const w = words[0];
      if (!w || !/^[a-z][a-z0-9._-]{0,30}$/.test(w)) continue;
      if (w === 'docker' && words[1] === 'compose') { out.add('Bash(docker compose:*)'); continue; }
      if (NEVER.has(w)) continue;
      out.add(`Bash(${w}:*)`);
      // A generator run with CI=1 (the skill's answer to one that prompts) is still that tool.
      out.add(`Bash(CI=1 ${w}:*)`);
      if (['npm', 'pnpm', 'yarn', 'bun'].includes(w)) { out.add('Bash(npx:*)'); out.add('Bash(CI=1 npx:*)'); out.add('Bash(node:*)'); }
      if (w === 'uv') out.add('Bash(uvx:*)');
    }
  }
  if (/docker|compose/i.test(`${plan.data} ${plan.devCommand}`)) out.add('Bash(docker compose:*)');
  return [...out];
}

/** A shallow listing of a project, for "start from one of my projects": the SHAPE, never the code. */
function tree(root: string, depth = 2, prefix = ''): string[] {
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(path.join(root, prefix), { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(d.name) || (d.name.startsWith('.') && !['.github', '.claude', '.env.example', '.editorconfig'].includes(d.name))) continue;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    out.push(d.isDirectory() ? `${rel}/` : rel);
    if (d.isDirectory() && depth > 1 && out.length < 150) out.push(...tree(root, depth - 1, rel));
    if (out.length >= 150) break;
  }
  return out;
}
function manifests(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of ['', ...dirs]) {
    const pkg = path.join(root, d, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(readText(pkg));
        out.push(`${d || '.'}/package.json — scripts: ${Object.keys(j.scripts || {}).join(', ') || '(none)'}; dependencies: ${Object.keys(j.dependencies || {}).join(', ') || '(none)'}; devDependencies: ${Object.keys(j.devDependencies || {}).join(', ') || '(none)'}${j.packageManager ? `; packageManager: ${j.packageManager}` : ''}`);
      } catch { /* unreadable manifest: skipped */ }
    }
    for (const f of ['pyproject.toml', 'go.mod', 'Cargo.toml', 'pubspec.yaml', 'composer.json', 'Gemfile']) {
      const t = readText(path.join(root, d, f));
      if (t) out.push(`${d || '.'}/${f}:\n${t.split('\n').slice(0, 40).join('\n')}`);
    }
  }
  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].map((f) => readText(path.join(root, f))).find(Boolean);
  if (compose) out.push(`docker compose:\n${compose.split('\n').slice(0, 60).join('\n')}`);
  return out;
}

/**
 * The profile's `vcs.host` / `vcs.remote`, rewritten in place in PIPELINE.md's machine block — so /cohorte-ship opens
 * PRs on the host the developer just connected. Only those two lines change; null when the block has no `vcs:` key.
 */
export function withVcs(md: string, host: string, remote: string): string | null {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => /^vcs:\s*(#.*)?$/.test(l));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || lines[end].trim() === '')) end++;
  const indent = (lines.slice(at + 1, end).find((l) => l.trim()) || '  x').match(/^(\s+)/)?.[1] || '  ';
  const set = (key: string, value: string): void => {
    const i = lines.slice(at + 1, end).findIndex((l) => new RegExp(`^\\s+${key}:`).test(l));
    if (i >= 0) lines[at + 1 + i] = `${indent}${key}: ${value}`;
    else { lines.splice(at + 1, 0, `${indent}${key}: ${value}`); end++; }
  };
  set('remote', remote);
  set('host', host);
  return lines.join('\n');
}
/** `owner/repo` and the host kind of a remote URL (https, ssh or scp-like). */
export function parseRemote(url: string): { host: 'github' | 'gitlab' | 'none'; remote: string } {
  const m = url.match(/^(?:https:\/\/|ssh:\/\/(?:[^@/]+@)?|[^@\s]+@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
  const server = m ? m[1].toLowerCase() : '';
  return { host: /(^|\.)github\.com$/.test(server) ? 'github' : /gitlab/.test(server) ? 'gitlab' : 'none', remote: m ? m[2] : '' };
}

interface FoundingDeps { globalDir: string; runs: Runs; jobs: Jobs; settings: SettingsStore; changed: (projectId: string) => void }

export class FoundingFlow {
  store: FoundingStore;
  constructor(private d: FoundingDeps, dir: string) { this.store = new FoundingStore(dir); }

  // -------------------------------------------------------------------------------------------------------------
  // reads

  phaseOf(projectId: string): FoundingPhase | null {
    const f = this.store.get(projectId);
    return f && f.phase !== 'done' && f.phase !== 'abandoned' ? f.phase : null;
  }
  view(projectId: string): FoundingView {
    const f = this.store.get(projectId);
    if (!f) throw new FlowError('this project is not being founded', 404);
    return this.toView(f);
  }
  private toView(f: Founding): FoundingView {
    const { visionRunId: _v, foundationRunId: _f, setupRunId: _s, scaffoldRuns: _n, ticketIds: _t, ...v } = f;
    return { ...v, costUsd: Math.round(f.stages.reduce((a, s) => a + (s.costUsd || 0), 0) * 10000) / 10000 };
  }
  private project(projectId: string): Project {
    const p = registry.get(this.d.globalDir, projectId);
    if (!p) throw new FlowError('unknown project', 404);
    return p;
  }
  private must(projectId: string): Founding {
    const f = this.store.get(projectId);
    if (!f) throw new FlowError('this project is not being founded', 404);
    return f;
  }
  private phase(f: Founding, phase: FoundingPhase, error: string | null = null): void {
    f.phase = phase; f.error = error;
    this.store.save(f);
  }

  // -------------------------------------------------------------------------------------------------------------
  // start

  /** New project: a folder (created, `git init`), registered as founding, and its first conversation started. */
  async create(body: NewProjectBody): Promise<{ project: Project; founding: FoundingView }> {
    const mode: FoundingMode = body.mode === 'idea' || body.mode === 'stack' || body.mode === 'existing' ? body.mode : (() => { throw new FlowError('mode must be idea, stack or existing'); })();
    const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
    if (brief.length > 8000) throw new FlowError('the brief is at most 8000 characters');
    if (mode === 'idea' && !brief) throw new FlowError('say what the idea is — the product owner starts from it');
    const requester = typeof body.requester === 'string' ? body.requester.trim().slice(0, 80) : '';
    const basedOn = typeof body.basedOn === 'string' && body.basedOn ? body.basedOn : null;
    if (basedOn && !registry.get(this.d.globalDir, basedOn)) throw new FlowError('the project to start from is not registered', 400);
    // Every command this path needs must be installed before anything is created.
    for (const c of mode === 'existing' ? ['cohorte-init-pipeline'] : mode === 'stack' ? ['cohorte-foundation', 'cohorte-scaffold', 'cohorte-init-pipeline'] : ['cohorte-vision', 'cohorte-foundation', 'cohorte-scaffold', 'cohorte-init-pipeline']) {
      expandCommand(this.d.globalDir, c, '');
    }

    let root: string;
    if (mode === 'existing') {
      const want = typeof body.path === 'string' ? expand(body.path) : '';
      if (!want || !path.isAbsolute(want)) throw new FlowError('an absolute folder path is required');
      if (!fs.existsSync(want) || !fs.statSync(want).isDirectory()) throw new FlowError(`${want} is not a folder`);
      root = want;
      if (isCohorte(root)) throw new FlowError('this folder already uses cohorte — add it instead', 409);
      if (!git(root, 'rev-parse', '--show-toplevel').stdout?.trim()) throw new FlowError('this folder is not a git repository — cohorte works on git repositories (run `git init` in it first)');
    } else {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!NAME.test(name)) throw new FlowError('the folder name is letters, digits, dot, dash or underscore (at most 64)');
      const parent = typeof body.parent === 'string' ? expand(body.parent) : '';
      if (!parent || !path.isAbsolute(parent)) throw new FlowError('the parent folder must be an absolute path');
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new FlowError(`${parent} is not a folder`);
      root = path.join(parent, name);
      if (fs.existsSync(root) && fs.readdirSync(root).length) throw new FlowError(`${root} already exists and is not empty`, 409);
      fs.mkdirSync(root, { recursive: true });
      if (git(root, 'init', '-q', '-b', 'main').status !== 0) {
        if (git(root, 'init', '-q').status !== 0) throw new FlowError('git init failed — is git installed?', 500);
        git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      }
    }
    const { project } = registry.add(this.d.globalDir, root, { founding: true });
    const s = this.d.settings.get(project.id);
    if (requester && !s.requester) this.d.settings.set(project.id, { requester });
    const f: Founding = {
      projectId: project.id, root: project.root, name: path.basename(project.root), mode, phase: mode === 'idea' ? 'vision' : mode === 'stack' ? 'foundation' : 'setup',
      brief, basedOn, requester, vision: null, tickets: [], foundation: null, scaffold: null, currentRunId: null, stages: [], error: null, warning: null,
      createdAt: now(), updatedAt: now(), costUsd: 0, visionRunId: null, foundationRunId: null, setupRunId: null, scaffoldRuns: 0, ticketIds: [],
    };
    this.store.save(f);
    if (mode === 'idea') this.startVision(f);
    else if (mode === 'stack') await this.startFoundation(f);
    else this.startSetup(f);
    this.d.changed(project.id);
    return { project, founding: this.toView(f) };
  }

  private track(f: Founding, stage: FoundingStage['stage'], run: Run): void {
    f.stages.push({ stage, runId: run.id, model: run.model || '', status: 'running', costUsd: null, startedAt: run.startedAt, endedAt: null });
    f.currentRunId = run.id;
    this.store.save(f);
  }

  private startVision(f: Founding): void {
    const s = this.d.settings.get(f.projectId);
    const prompt = expandCommand(this.d.globalDir, 'cohorte-vision', f.brief) + contextBlock([
      `Project: ${f.name} (a new product — there is no code yet)`, 'Talk in: the language the person writes in',
      `The person: ${f.requester || s.requester || 'the person with the idea'}`,
    ]);
    const run = this.d.runs.start({ ...mcp(f.root), projectId: f.projectId, cwd: f.root, command: '/cohorte-vision', prompt, model: s.models.po, disallowedTools: READ_ONLY, echo: f.brief,
      meta: { role: 'vision', title: `Vision · ${f.name}` } });
    f.visionRunId = run.id;
    this.track(f, 'vision', run);
    this.phase(f, 'vision');
  }

  private async machine(): Promise<string[]> {
    const tools: [string, string[]][] = [['node', ['--version']], ['npm', ['--version']], ['pnpm', ['--version']], ['yarn', ['--version']], ['bun', ['--version']],
      ['python3', ['--version']], ['uv', ['--version']], ['docker', ['--version']], ['go', ['version']], ['cargo', ['--version']], ['java', ['-version']], ['flutter', ['--version']],
      [process.env.COHORTE_GH_BIN || 'gh', ['--version']]];
    const rs = await Promise.all(tools.map(([t, a]) => gitinfo.probe(t, a, os.homedir(), 5000)));
    return tools.map(([t], i) => {
      const r = rs[i];
      const v = `${r.out}\n${r.err}`.split('\n').map((x) => x.trim()).find(Boolean) || '';
      return `- ${path.basename(t)}: ${r.code === 0 ? v.slice(0, 80) : 'not installed'}`;
    });
  }

  private others(f: Founding): string[] {
    const out: string[] = [];
    for (const p of registry.load(this.d.globalDir)) {
      if (p.id === f.projectId || !fs.existsSync(p.root) || this.phaseOf(p.id)) continue;
      const prof = ops.readProfile(p.root) as Record<string, any>;
      const surf = Array.isArray(prof.surfaces) ? prof.surfaces.map((x: any) => `${x.key}${x.label ? ` (${x.label})` : ''} at ${x.path}${x.test_cmd ? `, tests: ${x.test_cmd}` : ''}`).join('; ') : '';
      out.push(`- ${prof.name || path.basename(p.root)} [id ${p.id}]${prof.project?.kind ? ` · ${prof.project.kind}` : ''}${prof.package_manager ? ` · ${prof.package_manager}` : ''}${surf ? ` — ${surf}` : ''}`);
      if (out.length >= 15) break;
    }
    return out;
  }

  private basedOnBlock(f: Founding): string[] {
    if (!f.basedOn) return [];
    const p = registry.get(this.d.globalDir, f.basedOn);
    if (!p || !fs.existsSync(p.root)) return [];
    const prof = ops.readProfile(p.root) as Record<string, any>;
    const dirs = Array.isArray(prof.surfaces) ? prof.surfaces.map((x: any) => String(x.path || '')).filter((x: string) => x && !x.includes('..')) : [];
    const surfaces = Array.isArray(prof.surfaces) ? prof.surfaces.map((x: any) => {
      const cmds = Object.entries(x).filter(([k]) => k.endsWith('_cmd')).map(([k, v]) => `${k}=${v}`).join(', ');
      return `- ${x.key} at ${x.path}${x.label ? ` — ${x.label}` : ''}${cmds ? ` (${cmds})` : ''}`;
    }) : [];
    const conventions = conventionsOf(readText(path.join(p.root, 'PIPELINE.md')));
    return [
      '', `START FROM THIS PROJECT — the developer asked for the same shape: "${prof.name || path.basename(p.root)}". Follow its structure, tooling and conventions; copy none of its business code.`,
      `Kind: ${prof.project?.kind || '?'} · package manager: ${prof.package_manager || '?'} · layout: ${prof.repo?.layout || '?'}`,
      'Its surfaces:', ...(surfaces.length ? surfaces : ['(none declared)']),
      'Its files (two levels):', ...tree(p.root).map((x) => `  ${x}`),
      'Its manifests:', ...manifests(p.root, dirs).map((x) => x.slice(0, 3000)),
      'Its conventions (PIPELINE.md §Conventions):', conventions ? conventions.slice(0, 8000) : '(none)',
    ];
  }

  private async startFoundation(f: Founding): Promise<void> {
    const s = this.d.settings.get(f.projectId);
    const vision = f.vision ? JSON.stringify(f.vision, null, 2) : null;
    const prompt = expandCommand(this.d.globalDir, 'cohorte-foundation', f.brief || (f.vision ? '(see the vision below)' : '(no brief — ask the developer what they want to build)')) + contextBlock([
      `Project: ${f.name} — folder ${f.root} (empty but for PRODUCT.md when there is a vision)`,
      'Talk in: the language the developer writes in',
      '', vision ? 'THE VISION (validated by the business):' : 'No vision: the developer starts from the brief above.', ...(vision ? [vision] : []),
      ...(f.tickets.length ? ['', 'The first version\'s tickets (built later, one at a time — NOT by the skeleton):', ...f.tickets.map((t) => `- ${t.title}`)] : []),
      '', 'Installed on this machine:', ...(await this.machine()),
      '', "The developer's other projects (default to what they already use):", ...(this.others(f).length ? this.others(f) : ['(none registered)']),
      ...this.basedOnBlock(f),
    ]);
    const run = this.d.runs.start({ ...mcp(f.root), projectId: f.projectId, cwd: f.root, command: '/cohorte-foundation', prompt, model: s.models.lead, disallowedTools: READ_ONLY,
      echo: f.brief && !f.vision ? f.brief : undefined, meta: { role: 'foundation', title: `Foundations · ${f.name}` } });
    f.foundationRunId = run.id;
    this.track(f, 'foundation', run);
    this.phase(f, 'foundation');
  }

  private startScaffold(f: Founding, note = ''): void {
    if (!f.foundation) throw new FlowError('there is no approved foundations plan');
    const s = this.d.settings.get(f.projectId);
    let model = s.models.scaffold;
    for (let i = 0; i < f.scaffoldRuns; i++) model = escalate(model); // a retry climbs one model per attempt
    const prompt = expandCommand(this.d.globalDir, 'cohorte-scaffold', '') + contextBlock([
      `Project root: ${f.root} (git initialised, branch main)${fs.existsSync(path.join(f.root, 'PRODUCT.md')) ? ' — PRODUCT.md holds the validated vision' : ''}`,
      '', 'THE APPROVED FOUNDATIONS PLAN:', JSON.stringify(f.foundation, null, 2),
      ...this.basedOnBlock(f),
      ...(note ? ['', `The developer adds: ${note}`] : []),
      ...(f.scaffoldRuns > 0 ? ['', 'A previous scaffold attempt stopped in this folder: read what is already there, keep what works, finish the job.'] : []),
    ]) + AUTOPILOT_NOTE(null);
    const run = this.d.runs.start({ ...mcp(f.root), projectId: f.projectId, cwd: f.root, command: '/cohorte-scaffold', prompt, model, permissionMode: 'acceptEdits',
      allowedTools: scaffoldTools(f.foundation), meta: { role: 'scaffold', title: `Skeleton · ${f.name}` } });
    f.scaffoldRuns += 1;
    this.track(f, 'scaffold', run);
    this.phase(f, 'scaffold');
  }

  private startSetup(f: Founding): void {
    const s = this.d.settings.get(f.projectId);
    const founded = f.mode !== 'existing';
    const lines = founded ? [
      `This project was founded in cohorte ui a moment ago: ${f.root}. The developer APPROVED its foundations (the plan below) and the skeleton is committed.`,
      '- Detect as usual, but treat everything the plan settles as already confirmed: do not re-ask the project kind, the surfaces, their paths or their commands.',
      '- Ask (AskUserQuestion, recommended option first) only what neither the plan nor the code settles.',
      '- The Phase 3 go-ahead: the developer gave it by approving the plan. Show the draft in your reply and go on to Phase 4 in the same turn.',
      "- Carry the plan's `conventions` into PIPELINE.md §Conventions.",
      fs.existsSync(path.join(f.root, 'PRODUCT.md')) ? '- PRODUCT.md exists (the validated vision): use it for the one-liner; leave it as it is.' : '',
      '', 'THE APPROVED FOUNDATIONS PLAN:', JSON.stringify(f.foundation, null, 2),
      ...(f.scaffold ? ['', 'THE SKELETON REPORT:', JSON.stringify(f.scaffold, null, 2)] : []),
    ] : [
      `Running inside cohorte ui for an existing repository that does not use cohorte yet: ${f.root}.`,
      '- Ask through AskUserQuestion (recommended option first). A free-text question ends your turn: the developer answers in the dashboard.',
    ];
    const prompt = expandCommand(this.d.globalDir, 'cohorte-init-pipeline', '') + contextBlock([
      ...lines.filter((x) => x !== ''),
      '- Read the pipeline core\'s files (templates, schema, steps) with the Read tool — the folder is readable — never with cat/ls through Bash: every Bash call outside the allowed ones stops for the developer\'s permission. Run <sync> exactly as written, alone, from the repo root. Never write inside the core folder.',
      '- Never recommend `/clear`, and never tell anyone to run a command next: cohorte ui takes over when you end.',
    ]);
    const run = this.d.runs.start({ ...mcp(f.root), projectId: f.projectId, cwd: f.root, command: '/cohorte-init-pipeline', prompt, model: s.models.setup, permissionMode: 'acceptEdits',
      allowedTools: [...this.syncRule(), 'Bash(git status:*)', 'Bash(git ls-files:*)', 'Bash(git log:*)', 'Bash(git remote:*)', 'Bash(ls:*)', 'Bash(cat:*)'],
      addDirs: [path.join(this.d.globalDir, 'cohorte')], meta: { role: 'setup', title: `Pipeline set-up · ${f.name}` } });
    f.setupRunId = run.id;
    this.track(f, 'setup', run);
    this.phase(f, 'setup');
  }

  /** `<sync>` exactly as the installed /cohorte-init-pipeline spells it (it depends on where cohorte is installed). */
  private syncRule(): string[] {
    const m = readText(path.join(this.d.globalDir, 'commands', 'cohorte-init-pipeline.md')).match(/`<sync>` = `([^`]+)`/);
    const cmd = m ? m[1].trim().replace(/\s+\.$/, '') : '';
    return cmd && !/[(),\r\n]/.test(cmd) ? [`Bash(${cmd}:*)`] : [];
  }

  // -------------------------------------------------------------------------------------------------------------
  // the person's moves

  /** A message to whichever agent the founding is talking with. */
  reply(projectId: string, text: unknown): FoundingView {
    const f = this.must(projectId);
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) throw new FlowError('a message is required');
    const target: Record<string, [string | null, FoundingPhase]> = {
      vision: [f.visionRunId, 'vision'], 'cp-vision': [f.visionRunId, 'vision'], foundation: [f.foundationRunId, 'foundation'], 'cp-foundation': [f.foundationRunId, 'foundation'],
      setup: [f.setupRunId, 'setup'], scaffold: [f.currentRunId, 'scaffold'], 'cp-scaffold': [f.currentRunId, 'scaffold'],
    };
    const [runId, next] = target[f.phase] || [null, f.phase];
    const run = runId ? this.d.runs.get(runId) : null;
    if (!run) throw new FlowError(`nothing to answer in this step (${f.phase})`, 409);
    const err = this.d.runs.reply(run, t);
    if (err) throw new FlowError(err, 409);
    const st = f.stages.find((x) => x.runId === run.id);
    if (st) { st.status = 'running'; st.endedAt = null; }
    f.currentRunId = run.id;
    this.phase(f, next);
    this.d.changed(projectId);
    return this.toView(f);
  }

  async checkpoint(projectId: string, body: { action?: unknown; text?: unknown }): Promise<FoundingView> {
    const f = this.must(projectId);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
    const action = body.action;
    if (action === 'abandon') {
      const run = f.currentRunId ? this.d.runs.get(f.currentRunId) : null;
      if (run && run.status === 'running') this.d.runs.stop(run);
      this.phase(f, 'abandoned');
      this.d.changed(projectId);
      return this.toView(f);
    }
    if (action === 'reply') return this.reply(projectId, text);
    if (f.phase === 'cp-vision' && action === 'approve') {
      if (!f.vision) throw new FlowError('there is no vision to approve', 409);
      fs.writeFileSync(path.join(f.root, 'PRODUCT.md'), visionMarkdown(f.vision, f.name));
      await this.startFoundation(f);
    } else if (f.phase === 'cp-foundation' && action === 'approve') {
      if (!f.foundation) throw new FlowError('there is no plan to approve', 409);
      this.startScaffold(f, text);
    } else if (f.phase === 'cp-scaffold' && action === 'retry') {
      this.startScaffold(f, text);
    } else if (f.phase === 'cp-scaffold' && action === 'continue') {
      if (git(f.root, 'rev-parse', '--verify', '-q', 'HEAD').status !== 0) throw new FlowError('nothing is committed yet — retry the skeleton, or commit it yourself first', 409);
      this.startSetup(f);
    } else if (f.phase === 'setup' && action === 'retry') {
      this.startSetup(f);
    } else {
      throw new FlowError(`"${String(action)}" is not possible while the project is in ${f.phase}`, 409);
    }
    this.d.changed(projectId);
    return this.toView(f);
  }

  // -------------------------------------------------------------------------------------------------------------
  // run ends

  async onEnd(r: Run): Promise<void> {
    const f = this.store.get(r.projectId);
    if (!f || f.phase === 'abandoned' || f.phase === 'done') return;
    const st = f.stages.find((x) => x.runId === r.id);
    if (st) { st.status = r.status; st.costUsd = (st.costUsd || 0) + (r.result?.costUsd ?? 0); st.endedAt = r.endedAt; }
    if (f.currentRunId === r.id) f.currentRunId = null;
    const failed = r.status !== 'done' ? `the ${r.meta.role} run ${r.status}${r.result?.text ? `: ${r.result.text.slice(0, 300)}` : ''}` : null;
    const texts = textsOf(r.events);
    if (r.meta.role === 'vision') {
      const v = lastOf(texts, 'cohorte-vision', toVision);
      if (v) { f.vision = v; f.tickets = proposalsOf(texts); }
      this.phase(f, v && !failed ? 'cp-vision' : 'vision', failed);
    } else if (r.meta.role === 'foundation') {
      const plan = lastOf(texts, 'cohorte-foundation', toFoundation);
      if (plan) f.foundation = plan;
      this.phase(f, plan && !plan.questions.length && !failed ? 'cp-foundation' : 'foundation', failed);
    } else if (r.meta.role === 'scaffold') {
      const rep = lastOf(texts, 'cohorte-scaffold', toScaffold);
      if (rep) f.scaffold = rep;
      const committed = git(f.root, 'rev-parse', '--verify', '-q', 'HEAD').status === 0;
      if (!failed && rep?.status === 'ok' && committed) {
        this.store.save(f);
        try { this.startSetup(f); } catch (e) { this.phase(f, 'cp-scaffold', `the pipeline set-up could not start: ${String((e as Error).message || e)}`); }
      }
      else {
        const why = failed || (!rep ? 'the skeleton run ended without its report — answer it, or retry' : rep.status !== 'ok' ? `the skeleton's checks failed${rep.notes ? `: ${rep.notes.slice(0, 300)}` : ''}` : 'the skeleton was not committed');
        this.phase(f, 'cp-scaffold', why);
      }
    } else if (r.meta.role === 'setup') {
      if (!failed && isCohorte(f.root)) await this.finish(f);
      else this.phase(f, 'setup', failed);
    }
    this.d.changed(r.projectId);
  }

  /** The pipeline is set up: commit it (a new project only), file the first version's tickets, and hand over to the company flow. */
  private async finish(f: Founding): Promise<void> {
    if (f.mode !== 'existing' && (git(f.root, 'status', '--porcelain').stdout || '').trim()) {
      git(f.root, 'add', '-A');
      const c = git(f.root, 'commit', '-q', '-m', 'chore: set up the cohorte pipeline');
      if (c.status !== 0) f.warning = `the pipeline files could not be committed: ${(c.stderr || '').trim().slice(0, 300)}`;
    } else if (f.mode === 'existing') {
      f.warning = 'The pipeline files are written but not committed — review them and commit them with your own message.';
    }
    if (f.tickets.length && !f.ticketIds.length) {
      try {
        const p = this.project(f.projectId);
        const tr = trackerFor(this.d.globalDir, p.root, p.id);
        const requester = f.requester || this.d.settings.get(p.id).requester;
        for (const prop of f.tickets) {
          const t = tr.create(prop, { status: 'backlog', requester, conversation: f.visionRunId, parent: null });
          f.ticketIds.push(t.id);
          await tr.move(t);
        }
      } catch (e) { f.warning = `${f.warning ? `${f.warning}\n` : ''}the first version's tickets could not be filed: ${String((e as Error).message || e)}`; }
    }
    this.phase(f, 'done');
  }

  /** After a restart nothing is running: a founding mid-run waits for the developer instead of guessing. */
  recover(): void {
    for (const f of this.store.list()) {
      if (!['vision', 'foundation', 'scaffold', 'setup'].includes(f.phase)) continue;
      const r = f.currentRunId ? this.d.runs.get(f.currentRunId) : null;
      if (r && r.status === 'running') continue;
      for (const s of f.stages) if (s.status === 'running') s.status = 'stopped';
      f.currentRunId = null;
      if (f.phase === 'scaffold') this.phase(f, 'cp-scaffold', 'cohorte ui restarted while the skeleton was being generated — retry to resume');
      else { f.error = 'cohorte ui restarted during this step — send a message to resume the conversation'; this.store.save(f); }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // the code host — never required, one click when wanted

  async remote(projectId: string): Promise<RemoteInfo> { return gitinfo.remoteInfo(this.project(projectId).root); }

  /**
   * `github`: `gh repo create <name> --private|--public --source . --remote origin --push`.
   * `url`: an existing empty repository anywhere (GitLab, Gitea…): `git remote add origin <url>`, then push.
   */
  async connectRemote(projectId: string, body: { kind?: unknown; name?: unknown; visibility?: unknown; url?: unknown }): Promise<Job> {
    const p = this.project(projectId);
    const info = await gitinfo.remoteInfo(p.root);
    if (info.origin) throw new FlowError(`this project already has a remote: ${info.origin}`, 409);
    if (git(p.root, 'rev-parse', '--verify', '-q', 'HEAD').status !== 0) throw new FlowError('there is no commit to push yet', 409);
    if (body.kind === 'github') {
      if (!info.gh.installed) throw new FlowError('the GitHub CLI (gh) is not installed — install it from https://cli.github.com, or paste the URL of a repository you created yourself', 400);
      if (!info.gh.authed) throw new FlowError('gh is not signed in — run `gh auth login` in a terminal once, then try again', 400);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!/^([A-Za-z0-9_.-]{1,100}\/)?[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new FlowError('the repository name is [owner/]name (letters, digits, . _ -)');
      const vis = body.visibility === 'public' ? '--public' : body.visibility === 'internal' ? '--internal' : '--private';
      this.pointProfile(p, 'github', name.includes('/') ? name : `${info.gh.user}/${name}`);
      return this.d.jobs.start({ projectId: p.id, kind: 'remote', tag: 'github', label: `GitHub · ${name}`, cwd: p.root, file: process.env.COHORTE_GH_BIN || 'gh',
        args: ['repo', 'create', name, vis, '--source', '.', '--remote', 'origin', '--push'] });
    }
    if (body.kind === 'url') {
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!/^(https:\/\/[^\s'"`]+|ssh:\/\/[^\s'"`]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s'"`]+)$/.test(url) || url.length > 300) throw new FlowError('paste the repository URL (https://…, ssh://… or git@host:owner/repo.git)');
      const add = git(p.root, 'remote', 'add', 'origin', url);
      if (add.status !== 0) throw new FlowError(`git remote add failed: ${(add.stderr || '').trim()}`, 400);
      const r = parseRemote(url);
      if (r.remote) this.pointProfile(p, r.host, r.remote);
      const branch = info.branch && info.branch !== 'HEAD' ? info.branch : 'main';
      return this.d.jobs.start({ projectId: p.id, kind: 'remote', tag: 'url', label: `push · ${url}`, cwd: p.root, file: 'git', args: ['push', '-u', 'origin', branch] });
    }
    throw new FlowError('kind must be github or url');
  }

  /** Before the first push: the profile names the new host, `cohorte sync` refreshes profile.json, and both are committed. */
  private pointProfile(p: Project, host: string, remote: string): void {
    const file = path.join(p.root, 'PIPELINE.md');
    const md = readText(file);
    const next = md ? withVcs(md, host, remote) : null;
    if (!next || next === md) return;
    fs.writeFileSync(file, next);
    try { projectLib.sync(p.root); } catch { /* the doctor reports a stale profile.json */ }
    const dirty = (git(p.root, 'status', '--porcelain').stdout || '').trim();
    if (dirty && git(p.root, 'diff', '--cached', '--quiet').status === 0) {
      git(p.root, 'add', 'PIPELINE.md', '.claude/profile.json');
      git(p.root, 'commit', '-q', '-m', `chore: point the pipeline at ${remote}`);
    }
  }
}
