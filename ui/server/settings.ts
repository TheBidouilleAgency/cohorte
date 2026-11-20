// Per-project settings of the company flow, kept by cohorte ui on this machine:
// <globalDir>/cohorte-ui/settings/<projectId>.json. They are the dials a person sets from the page — how much the
// decider may settle alone, which model each role runs on, how many fix rounds the autopilot tries before it asks.
// Nothing here is committed to the project: two teammates may run different models.

import fs from 'fs';
import path from 'path';
import type { Autonomy, ModelRole, ProjectSettings } from '../shared/api';
import { MODEL } from './runs';

/**
 * Routing defaults. The strongest model where judgment is the product (talking to the business, framing with the
 * developer); the mid one where a frozen spec already did the thinking (build, fix, review); the light one where
 * the work is mechanical or is a vote (verify, the decider's first round). The decider escalates a split vote one
 * step up before it bothers anyone; a fix round that makes no progress escalates its model the same way.
 */
export const DEFAULTS: ProjectSettings = {
  autonomy: 'balanced',
  models: {
    po: 'opus', lead: 'opus', build: 'sonnet', implementer: 'sonnet', review: 'sonnet', fix: 'sonnet', verify: 'haiku',
    ship: 'sonnet', learn: 'sonnet', acceptance: 'sonnet', productMap: 'sonnet', scaffold: 'sonnet', setup: 'sonnet', decider: 'haiku', deciderEscalation: 'sonnet',
  },
  deciderVotes: 3, maxRounds: 3, mergeMethod: 'squash', autopilot: true, requester: '',
};
export const AUTONOMY: readonly Autonomy[] = ['prudent', 'balanced', 'autonomous'];
const ROLES = Object.keys(DEFAULTS.models) as ModelRole[];
/** The escalation ladder, by family. A model outside it (a full id) escalates to itself. */
const LADDER = ['haiku', 'sonnet', 'opus', 'fable'];
export const escalate = (model: string): string => {
  const i = LADDER.indexOf(model);
  return i >= 0 && i < LADDER.length - 1 ? LADDER[i + 1] : model;
};

export function normalize(v: unknown, base: ProjectSettings = DEFAULTS): ProjectSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const models = { ...base.models };
  for (const r of ROLES) if (typeof o.models?.[r] === 'string' && MODEL.test(o.models[r].trim())) models[r] = o.models[r].trim();
  const int = (x: unknown, lo: number, hi: number, d: number): number => (typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  return {
    autonomy: AUTONOMY.includes(o.autonomy) ? o.autonomy : base.autonomy,
    models,
    deciderVotes: int(o.deciderVotes, 1, 7, base.deciderVotes),
    maxRounds: int(o.maxRounds, 1, 8, base.maxRounds),
    mergeMethod: ['squash', 'merge', 'rebase'].includes(o.mergeMethod) ? o.mergeMethod : base.mergeMethod,
    autopilot: typeof o.autopilot === 'boolean' ? o.autopilot : base.autopilot,
    requester: typeof o.requester === 'string' ? o.requester.trim().slice(0, 80) : base.requester,
  };
}

export class SettingsStore {
  constructor(private dir: string) {}
  private file(projectId: string): string { return path.join(this.dir, `${projectId.replace(/[^A-Za-z0-9._-]/g, '')}.json`); }
  get(projectId: string): ProjectSettings {
    try { return normalize(JSON.parse(fs.readFileSync(this.file(projectId), 'utf8'))); } catch { return normalize({}); }
  }
  /** Merges a partial update (models merged per role) and returns what was stored. */
  set(projectId: string, patch: unknown): ProjectSettings {
    const cur = this.get(projectId);
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, any>;
    const next = normalize({ ...cur, ...p, models: { ...cur.models, ...(p.models && typeof p.models === 'object' ? p.models : {}) } }, cur);
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(projectId);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(next, null, 2));
    fs.renameSync(`${f}.tmp`, f);
    return next;
  }
}
