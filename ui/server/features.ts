// A feature is a ticket a developer took: its worktree, where it stands between checkpoints, every stage the
// autopilot ran (and on which model), every decision taken on the developer's behalf, every correction they asked
// for. Kept by cohorte ui on this machine: <globalDir>/cohorte-ui/features/<projectId>/<id>.json — the pipeline's
// own artifacts (spec, reports, contract) stay in the worktree, where the commands read them.
//
// Two processes share these files — `cohorte ui` and a `cohorte take|checkpoint|autopilot` in a terminal — so the
// cache is only a cache: a record whose file changed since this process last read or wrote it is read again, into
// the SAME object, so a reference the flow holds across an await sees the other process's write.
//
// The record is also mirrored into the worktree as specs/reports/<id>.decisions.md (gitignored report buffer), so
// /cohorte-learn — which runs in the worktree and cannot see this store — reads the decisions and corrections.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Checkpoint, DecisionRecord, FeaturePhase, FeatureView } from '../shared/api';

const SAFE = /^[A-Za-z0-9._-]+$/;
export type Feature = FeatureView & { v: 1; reservationsAck: boolean; lastBlocking: number | null; failures: Record<string, number> };

const stamp = (file: string): string | null => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return null; } };

export class FeatureStore {
  private cache = new Map<string, Feature>();
  /** The file's mtime:size when this process last read or wrote it. */
  private stamps = new Map<string, string | null>();
  constructor(private dir: string) {}

  private file(projectId: string, id: string): string | null {
    return SAFE.test(projectId) && SAFE.test(id) ? path.join(this.dir, projectId, `${id}.json`) : null;
  }

  create(projectId: string, ticketId: string, title: string): Feature {
    const now = new Date().toISOString();
    const f: Feature = {
      v: 1, id: ticketId, projectId, ticketId, title, worktree: null, branch: null, phase: 'provisioning', checkpoint: null,
      leadRunId: null, currentRunId: null, stages: [], rounds: 0, decisions: [], corrections: [], pr: null, plan: null, error: null, warning: null,
      createdAt: now, updatedAt: now, costUsd: 0, reservationsAck: false, lastBlocking: null, failures: {},
    };
    this.save(f);
    return f;
  }

  get(projectId: string, id: string): Feature | null {
    const key = `${projectId}/${id}`;
    const f = this.file(projectId, id);
    if (!f) return null;
    const hit = this.cache.get(key);
    const st = stamp(f);
    if (hit && (st === null || st === this.stamps.get(key))) return hit;
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (v.v !== 1 || v.id !== id) return hit || null;
      this.stamps.set(key, st);
      if (!hit) { this.cache.set(key, v); return v; }
      for (const k of Object.keys(hit)) if (!(k in v)) delete (hit as unknown as Record<string, unknown>)[k];
      return Object.assign(hit, v);
    } catch { return hit || null; }
  }

  list(projectId: string): Feature[] {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(this.dir, projectId)).filter((n) => n.endsWith('.json')); } catch { return []; }
    return names.map((n) => this.get(projectId, n.slice(0, -5))).filter((x): x is Feature => !!x).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  all(projectIds: string[]): Feature[] { return projectIds.flatMap((p) => this.list(p)); }

  save(f: Feature): void {
    f.updatedAt = new Date().toISOString();
    f.costUsd = Math.round(f.stages.reduce((s, x) => s + (x.costUsd || 0), 0) * 10000) / 10000;
    this.cache.set(`${f.projectId}/${f.id}`, f);
    const file = this.file(f.projectId, f.id);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(f, null, 1));
      fs.renameSync(tmp, file);
      this.stamps.set(`${f.projectId}/${f.id}`, stamp(file));
    } catch { /* a convenience record: never take the flow down */ }
    this.mirror(f);
  }

  phase(f: Feature, phase: FeaturePhase, checkpoint: Checkpoint | null = null, error: string | null = null): void {
    f.phase = phase; f.checkpoint = checkpoint; f.error = error;
    this.save(f);
  }

  addDecision(f: Feature, d: Omit<DecisionRecord, 'id' | 'at' | 'contested' | 'confirmed'>): DecisionRecord {
    const rec: DecisionRecord = { ...d, id: crypto.randomBytes(3).toString('hex'), at: new Date().toISOString(), contested: null, confirmed: false };
    f.decisions.push(rec);
    this.save(f);
    return rec;
  }

  /** specs/reports/<id>.decisions.md in the worktree — what /cohorte-learn reads. */
  private mirror(f: Feature): void {
    if (!f.worktree || !fs.existsSync(f.worktree)) return;
    const lines = [`# Decisions & corrections — ${f.id}`, '', '> Written by cohorte ui. Read by /cohorte-learn. Do not edit.', ''];
    if (f.decisions.length) {
      lines.push('## Decisions', '');
      for (const d of f.decisions) {
        const src = d.source && d.source.kind !== 'none' ? ` · source: ${d.source.kind}${d.source.ref ? ` (${d.source.ref})` : ''}` : '';
        const state = d.contested ? ` · CONTESTED by the developer: ${d.contested.note || '(no note)'}` : d.confirmed ? ' · confirmed at CP3' : '';
        lines.push(`- [${d.by}] ${d.stage} · ${d.header ? `${d.header} · ` : ''}${d.question} → **${d.chosen}**${src}${state}`);
      }
      lines.push('');
    }
    if (f.corrections.length) {
      lines.push('## Corrections asked by the developer', '');
      for (const c of f.corrections) lines.push(`- ${c.at.slice(0, 10)} · at ${c.checkpoint} · ${c.text.replace(/\n+/g, ' ')}`);
      lines.push('');
    }
    if (f.stages.length) {
      lines.push('## Stages', '');
      for (const s of f.stages) lines.push(`- ${s.stage} · ${s.model} · ${s.status}${s.note ? ` · ${s.note}` : ''}`);
      lines.push('');
    }
    try {
      const dir = path.join(f.worktree, 'specs', 'reports');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${f.id}.decisions.md`), lines.join('\n'));
    } catch { /* the worktree may be read-only or gone */ }
  }
}
