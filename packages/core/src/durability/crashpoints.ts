// DESIGN 4.3 — crash points: a named registry, a recorded golden run, a meta-test. `crashpoint(name)` is inert
// unless `COHORTE_CRASH_AT=<name>[#n]` is set (a REAL `SIGKILL`, no `finally`) or an in-process fault injector is
// armed for `name` (a `SimulatedCrash`, for fast in-process crash tests that never fork a process). Both paths are
// no-ops for a point that is not, right now, the one asked for — which is what makes an unhit declared point a test
// failure elsewhere (the harness asserts the golden run's recorded `(point, occurrence)` pairs were all hit) and a
// new transition's crash cases free (it only has to hit points this registry already names).
/** DESIGN 4.3, table rows 1-21 (row 22, SQLite's own WAL durability, calls no `crashpoint()`); a row whose name
 * contains "/" in the table's prose is two independent named points, each hit and recorded separately. */
export const CRASHPOINTS = [
  'start.after-run-row',
  'host.after-lease',
  'snapshot.mid-materialize',
  'transition.before-commit',
  'transition.after-commit',
  'transition-effect.after-intent',
  'transition-effect.after-external',
  'plan.after-commit',
  'provision.after-worktree-add',
  'provision.after-install',
  'spawn.after-intent',
  'spawn.after-ready',
  'tool.after-requested',
  'approval.after-requested',
  'tool.after-intent',
  'tool.after-effect',
  'tool.after-done',
  'agent.after-exit-before-collect',
  'commit.after-git-commit',
  'merge.after-update-ref',
  'phase.before-completed-commit',
  'checkpoint.after-events-before-snapshot',
  'command.external.after-accepted',
  'ship.after-approval',
  'locks.after-release',
  'reset.after-git-reset',
] as const;
export type Crashpoint = (typeof CRASHPOINTS)[number];

const CRASHPOINT_SET: ReadonlySet<string> = new Set(CRASHPOINTS);
export const isCrashpoint = (value: string): value is Crashpoint => CRASHPOINT_SET.has(value);

export interface FaultInjector {
  /** true = crash HERE, on this occurrence (1-based) of this named point */
  shouldFail(point: Crashpoint, occurrence: number): boolean;
}

let injector: FaultInjector | null = null;

/** Test-only wiring point: `@cohorte/testkit`'s `FaultInjector` calls this, never a direct import in either
 * direction (core may not depend on testkit from `src/**`, and testkit never re-implements this registry). */
export function setFaultInjector(next: FaultInjector | null): void {
  injector = next;
}

export class SimulatedCrash extends Error {
  readonly point: Crashpoint;
  readonly occurrence: number;
  constructor(point: Crashpoint, occurrence: number) {
    super(`simulated crash at ${point}#${occurrence}`);
    this.name = 'SimulatedCrash';
    this.point = point;
    this.occurrence = occurrence;
  }
}

const occurrences = new Map<Crashpoint, number>();

/** Resets the per-process occurrence counters; called between golden-run recordings and between test cases. */
export function resetCrashpointOccurrences(): void {
  occurrences.clear();
}

interface EnvTarget {
  point: string;
  occurrence?: number;
}

function parseCrashAtEnv(raw: string | undefined): EnvTarget | null {
  if (!raw) return null;
  const hash = raw.indexOf('#');
  if (hash === -1) return { point: raw };
  const occurrence = Number.parseInt(raw.slice(hash + 1), 10);
  const point = raw.slice(0, hash);
  return Number.isFinite(occurrence) && occurrence > 0 ? { point, occurrence } : { point };
}

/**
 * Marks a named crash point. Bumps the point's occurrence counter first (so a `#n` target sees the SAME numbering
 * whichever mechanism is armed), then: `COHORTE_CRASH_AT` matching this point (and this occurrence, when `#n` is
 * given) kills the process for real; otherwise an armed `FaultInjector` may throw `SimulatedCrash`. Both checks are
 * skipped, and this is a true no-op, when neither is configured.
 */
export function crashpoint(name: Crashpoint): void {
  if (!isCrashpoint(name)) throw new TypeError(`crashpoint: ${JSON.stringify(name)} is not in CRASHPOINTS`);
  const occurrence = (occurrences.get(name) ?? 0) + 1;
  occurrences.set(name, occurrence);

  const target = parseCrashAtEnv(process.env.COHORTE_CRASH_AT);
  if (target && target.point === name && (target.occurrence === undefined || target.occurrence === occurrence)) {
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (injector?.shouldFail(name, occurrence)) throw new SimulatedCrash(name, occurrence);
}
