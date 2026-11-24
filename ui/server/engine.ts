// The company flow as a library: the stores, the runs and the Flow, wired together — without the HTTP server.
// `cohorte ui` (server.ts) builds one per server, every flow verb of the CLI (bin/flow.js) one per command; both
// read and write the same files under <globalDir>/cohorte-ui/ (and the project's tracker), so a ticket filed in a
// terminal is on the kanban page, and a CP1 approved on the page can be followed with `cohorte autopilot`.
//
// What keeps two processes from stepping on each other lives in the stores and the flow, not here: atomic writes,
// a feature cache that re-reads a file another process rewrote (features.ts), run files that carry their driver's
// pid (history.ts), and the lease on a feature with a run in flight (flow.ts). watchState is how the UI hears about
// a write it did not make: it has no hook for another process's run, so it polls the files.

import fs from 'fs';
import path from 'path';
import { Jobs, type Job } from './jobs';
import { Runs } from './runs';
import { RunStore } from './history';
import { Flow } from './flow';
import type { Decider } from './decider';
import { registry } from './legacy';
import { trackerOf } from './tracker';

export interface EngineOpts {
  globalDir: string; by: 'ui' | 'cli';
  changed?: (projectId: string) => void;
  /** Every job change, before the flow reacts to it (the server pushes it to the page). */
  onJob?: (job: Job) => void;
  decider?: Decider;
}
export interface Engine { dataDir: string; jobs: Jobs; runs: Runs; flow: Flow }

export function createEngine(o: EngineOpts): Engine {
  const dataDir = path.join(o.globalDir, 'cohorte-ui');
  const jobs = new Jobs();
  const runs = new Runs({ store: new RunStore(path.join(dataDir, 'runs')) });
  const flow = new Flow({ globalDir: o.globalDir, runs, jobs, dataDir, decider: o.decider, changed: o.changed, by: o.by });
  jobs.onChange = (j) => {
    o.onJob?.(j);
    try { flow.onJob(j); flow.onMergeJob(j); } catch { /* the flow never takes a job down */ }
  };
  return { dataDir, jobs, runs, flow };
}

/** Names and mtimes of a folder's files — what changes when any process writes one of them. */
function signature(dir: string): string {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return ''; }
  return names.filter((n) => !n.endsWith('.tmp')).sort().map((n) => { try { return `${n}@${fs.statSync(path.join(dir, n)).mtimeMs}`; } catch { return n; } }).join('|');
}

/**
 * Calls `changed(projectId)` when a project's features, tickets or runs change on disk — this process's own writes
 * included (a spurious notice costs one refetch). Polling, not fs.watch: portable, and a vault on a synced drive
 * does not always deliver events. Returns the stop function.
 */
export function watchState(globalDir: string, changed: (projectId: string) => void, everyMs = 1500): () => void {
  const dataDir = path.join(globalDir, 'cohorte-ui');
  const last = new Map<string, string>();
  const tick = (): void => {
    for (const p of registry.load(globalDir)) {
      let tickets = '';
      try { tickets = signature(trackerOf(globalDir, p.root, p.id).dir); } catch { /* no profile yet */ }
      const sig = [signature(path.join(dataDir, 'features', p.id)), tickets, signature(path.join(dataDir, 'runs', p.id))].join('\n');
      const prev = last.get(p.id);
      last.set(p.id, sig);
      if (prev !== undefined && prev !== sig) { try { changed(p.id); } catch { /* a listener never stops the watch */ } }
    }
  };
  tick();
  const t = setInterval(tick, everyMs);
  t.unref();
  return () => clearInterval(t);
}
