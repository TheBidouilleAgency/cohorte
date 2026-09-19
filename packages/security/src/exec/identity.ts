// Kill-tree, orphan sweep and cross-restart identity verification (DESIGN 2.6.6, 4.4 step 5). Two mechanisms, and
// NEITHER of them ever signals a bare pid:
//
//  - an in-run TRACKER (`trackDescendants` + `sweepTracked`): while the leader is alive, its process tree is
//    polled by PPID, because a `setsid()` escapee keeps its PPID even after it leaves the process GROUP (S-22).
//    Every descendant ever seen is remembered — a later reparent to pid 1 (the leader exits before we look again)
//    cannot make an escapee invisible — and it is remembered WITH the start time it had when first seen. Over a
//    command of minutes (`pnpm test`, a build) most of that set is long dead by the end, and the OS is free to
//    hand those numbers to unrelated processes of the same user; the sweep therefore re-reads each pid's current
//    start time and touches only the ones that are still the very process that was tracked.
//  - a STATELESS, cross-restart entry point (`sweepGroupByToken`, DESIGN 4.4 step 5, "callable on demand by the
//    Resumer"): after a host restart there is no in-memory tracker left, so a bare pgid is never enough — the OS
//    may have recycled it for an unrelated process. Identity is verified against the process's own START TIME
//    (`processStartToken`), the same technique `pids/*.json` files are meant to support (I1, I4: "never kills on
//    a bare pid").
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { sha256Hex } from '@cohorte/base';

const execFileAsync = promisify(execFile);

interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** when this pid started, as the process table reports it — what tells a recycled number from the real process */
  start: string;
}

/**
 * One `ps` fork, four columns. `lstart=` is the last one on purpose: it is the only field with embedded spaces
 * (`Tue Sep 15 09:09:30 2026`), so everything after the third column is its value. A row that cannot produce all
 * four is DROPPED rather than tracked without an identity — a pid with no start time is a bare pid, and this file
 * does not kill those.
 */
async function processTable(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,pgid=,lstart=']);
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [pidText, ppidText, pgidText] = fields;
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const pgid = Number(pgidText);
    const start = fields.slice(3).join(' ');
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid) && start !== '') {
      rows.push({ pid, ppid, pgid, start });
    }
  }
  return rows;
}

/** Every row transitively parented by `rootPid`, whatever its CURRENT pgid (so a `setsid()` escapee still shows). */
function descendantsOf(rootPid: number, table: readonly ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const row of table) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const found: ProcRow[] = [];
  const queue = [...(byParent.get(rootPid) ?? [])];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    found.push(next);
    queue.push(...(byParent.get(next.pid) ?? []));
  }
  return found;
}

/**
 * Is `pgid` a real process group we may address? On POSIX `kill(-0, …)` signals the CALLER's own process group —
 * the run host itself — and `kill(-1, …)` every process the user may signal. `ExecResult.pgid` is `0` on every
 * early return (nothing was spawned), so a dependant that feeds a result back into a sweep must find a closed door
 * here rather than one missing guard between it and a TERM of the run host.
 */
function isAddressableGroup(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `true` when the signal was actually delivered; `false` when the target was gone or refused us. */
function trySignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // Already gone, or never existed: sweeping is always best-effort.
    return false;
  }
}

/** TERM the pids that are still alive, wait `graceMs`, KILL the survivors. Returns how many were signalled. */
async function terminatePids(
  pids: readonly number[],
  wait: (ms: number) => Promise<void>,
  graceMs: number,
): Promise<number> {
  const alive = pids.filter((pid) => isAlive(pid));
  if (alive.length === 0) return 0;
  for (const pid of alive) trySignal(pid, 'SIGTERM');
  await wait(graceMs);
  for (const pid of alive) if (isAlive(pid)) trySignal(pid, 'SIGKILL');
  return alive.length;
}

/**
 * How often the tracker forks `ps`. Every poll is a fork plus a full process-table scan, and this executor is the
 * path that runs `pnpm test` / `pnpm build`, where a run of minutes is ordinary — a fixed fast period would cost
 * tens of thousands of forks for one check command. The period is therefore fast only while it buys something: an
 * escapee that `setsid()`s immediately must be seen before the leader is reaped, which is a matter of milliseconds,
 * whereas after the first second the tracker is merely keeping an already-known set fresh. The final snapshot at
 * exit (below) is taken at full resolution whatever the period has grown to, so the last moment is never sampled
 * coarsely.
 */
export interface TrackInterval {
  /** the period during the fast window */
  initialMs: number;
  /** the period never grows past this */
  maxMs: number;
  /** total polled time after which the period starts doubling */
  rampAfterMs: number;
}

/** What the tracker remembers about a descendant: the pid, and the start time it had the first time it was seen. */
export type TrackedDescendants = Map<number, string>;

/**
 * Polls the process table until `until` settles, folding every descendant ever seen under `rootPid` into `sink`
 * AS `pid -> start time`. The start time is what makes the record an identity instead of a number: by the end of a
 * long command most of these pids are gone, and the sweep must be able to tell the process it tracked from whatever
 * the OS has since given that number to. It is kept as FIRST SEEN and never overwritten — a differing later reading
 * means the number was recycled, which is exactly what the sweep needs to notice.
 *
 * Run concurrently with the leader's own lifetime (DESIGN 2.6.6 "post-run SWEEP ... also callable on demand by the
 * Resumer"); its own errors (no `ps` on the machine, a transient failure) are swallowed — sweeping is advisory,
 * never a reason to fail the call it is watching.
 */
export async function trackDescendants(
  rootPid: number,
  sink: TrackedDescendants,
  until: Promise<unknown>,
  wait: (ms: number) => Promise<void>,
  interval: TrackInterval,
): Promise<void> {
  let settled = false;
  const stop = (): void => {
    settled = true;
  };
  void until.then(stop, stop);
  const poll = async (): Promise<void> => {
    try {
      for (const row of descendantsOf(rootPid, await processTable())) {
        if (!sink.has(row.pid)) sink.set(row.pid, row.start);
      }
    } catch {
      // best-effort
    }
  };
  let period = interval.initialMs;
  let polledMs = 0;
  for (;;) {
    await poll();
    if (settled) return;
    try {
      await wait(period);
    } catch {
      return;
    }
    polledMs += period;
    if (polledMs >= interval.rampAfterMs) period = Math.min(interval.maxMs, period * 2);
    if (settled) {
      // One last snapshot, taken as close as possible to the moment the leader actually exited.
      await poll();
      return;
    }
  }
}

/**
 * TERM every tracked descendant that is STILL THAT DESCENDANT, wait `graceMs`, then KILL the survivors (`leaderPid`
 * itself is excluded: the caller already handled the group leader through its own `-pgid` kill).
 *
 * Identity first, always. One process-table snapshot is taken before anything is signalled, and a tracked pid takes
 * part only when its CURRENT start time still equals the one recorded when it was first seen. A `pnpm test` that
 * forks hundreds of short-lived children leaves a set whose pids are mostly dead by the end; without this check the
 * sweep would TERM+KILL whatever unrelated process of the same user the OS had meanwhile given one of those numbers
 * to — a bare-pid kill, which DESIGN 4.4 step 5 forbids here exactly as it does across a restart — and would count
 * it as an escapee on top. A pid that is gone, or whose start time has moved, is neither signalled nor counted.
 *
 * Of the survivors that ARE ours, the KILL is total — every tracked descendant, whatever its group. The COUNT is
 * not: DESIGN 2.6.6 defines `ExecResult.escapees` as "processes that LEFT the group". A tracked pid whose current
 * pgid still equals `leaderPid` is an ordinary grandchild outliving its parent — routine, and counting it would
 * raise a false escapee on DESIGN 4.4's resume diagnostics and on any `escapees > 0` alerting; a pid that
 * `setsid()`ed away has its own pgid and IS one (S-22). When the snapshot cannot be taken at all, nothing is
 * signalled and nothing is claimed: an unverifiable pid is not a target.
 */
export async function sweepTracked(
  seen: ReadonlyMap<number, string>,
  leaderPid: number,
  wait: (ms: number) => Promise<void>,
  graceMs: number,
): Promise<number> {
  if (seen.size === 0) return 0;
  let table: ProcRow[];
  try {
    table = await processTable();
  } catch {
    // No snapshot, no identity, no kill: best-effort never means "signal a number and hope".
    return 0;
  }
  const current = new Map(table.map((row) => [row.pid, row]));
  let escapees = 0;
  const targets: number[] = [];
  for (const [pid, start] of seen) {
    if (pid === leaderPid) continue;
    const row = current.get(pid);
    // Gone (the common case at the end of a run), or the number has been recycled since: not ours to touch.
    if (row === undefined || row.start !== start) continue;
    targets.push(pid);
    if (row.pgid !== leaderPid) escapees += 1;
  }
  await terminatePids(targets, wait, graceMs);
  return escapees;
}

/**
 * The post-exit safety net, and a BEST-EFFORT net, not an identity-verified kill — be precise about what it is:
 * once the leader has been reaped (Node emits `'exit'` AFTER `waitpid`) its pid is free for reuse, and this
 * function keys on that same bare pgid NUMBER. It is narrower than `kill(-pgid)` in one respect only — it signals
 * members one pid at a time, sparing a recycled leader (`row.pid !== pgid`) — and it does NOT verify a start token,
 * so a group that has taken over the recycled number would be signalled with its members. The window is the few
 * milliseconds between the leader's reap and this call, and pids are allocated sequentially, so a recycle inside it
 * is not realistic. The identity-verified path is `sweepGroupByToken`, which is what the Resumer (DESIGN 4.4
 * step 5, "never kills on a bare pid") uses across restarts, where the window is unbounded and the guarantee must
 * be real. Returns how many were signalled.
 */
export async function killGroupMembers(
  pgid: number,
  wait: (ms: number) => Promise<void>,
  graceMs: number,
): Promise<number> {
  if (!isAddressableGroup(pgid)) return 0;
  let members: number[];
  try {
    members = (await processTable()).filter((row) => row.pgid === pgid && row.pid !== pgid).map((row) => row.pid);
  } catch {
    return 0;
  }
  return terminatePids(members, wait, graceMs);
}

/**
 * A string that identifies WHEN `pid` started, not just its number — the "start token" of DESIGN 4.4 step 5.
 * `undefined` when the pid is gone or the platform's process table cannot be read.
 *
 * The token must be EXEC-STABLE: it is minted at the `'spawn'` event, while the leader's process image is still
 * `/bin/sh -c '<ulimit script>'`, and every later reading of it — which is all the Resumer ever has — sees the image
 * the wrapper `exec`ed into. Anything image-dependent in the hash (a command line, an argv) therefore cannot round
 * trip, and `sweepGroupByToken` would never verify a group this executor recorded. Only start TIME qualifies.
 *
 * Resolution differs per platform, and it decides how narrow the pid-reuse window is. Linux reads `starttime` from
 * `/proc/<pid>/stat`, in clock ticks since boot: two processes can share a pid only if one started long after the
 * other died, so the token is effectively unique. macOS has no such counter; `ps -o lstart=` has ONE-SECOND
 * resolution, so the residual risk there is a pid recycled by a process that started in the SAME SECOND. That is
 * why nothing but a kill-tree cleanup is ever driven from this token, and why the program's identity is carried
 * separately, by `PidRegistry.record({ label: req.file })` (contract/exec.ts).
 */
export async function processStartToken(pid: number, platform: string = process.platform): Promise<string | undefined> {
  try {
    if (platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // `(comm)` may itself contain spaces or parentheses: skip to the LAST ')', then count fields from `state`.
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // state(3) ppid(4) pgrp(5) session(6) tty_nr(7) tpgid(8) flags(9) minflt..cstime(10-17) priority nice(18-19)
      // num_threads(20) itrealvalue(21) starttime(22) -> index 19 (0-based, starting at field 3) of `afterComm`.
      const starttime = afterComm[19];
      return starttime === undefined || starttime === '' ? undefined : `linux:${starttime}`;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const identity = stdout.trim();
    return identity === '' ? undefined : `lstart:${sha256Hex(identity)}`;
  } catch {
    return undefined;
  }
}

export interface SweepByTokenOptions {
  wait: (ms: number) => Promise<void>;
  graceMs: number;
  platform?: string;
}

export interface SweepByTokenResult {
  /** `false` when `pgid` is dead, or alive but its start token does not match: nothing was signalled. */
  verified: boolean;
  /** `true` only when a signal was actually DELIVERED to the group — never merely "we tried". */
  killed: boolean;
}

/**
 * The Resumer's stateless, on-demand entry point (DESIGN 4.4 step 5): kills the process group `pgid` ONLY when its
 * CURRENT start token still equals `startToken`. After a host restart the in-memory tracker above is gone and the
 * OS may have reused `pgid` for an unrelated process since this run's host died (I1, I4) — a bare pid is never
 * enough. No match ⇒ nothing is signalled.
 */
export async function sweepGroupByToken(
  pgid: number,
  startToken: string,
  options: SweepByTokenOptions,
): Promise<SweepByTokenResult> {
  if (!isAddressableGroup(pgid) || !isAlive(pgid)) return { verified: false, killed: false };
  const platform = options.platform ?? process.platform;
  const current = await processStartToken(pgid, platform);
  if (current === undefined || current !== startToken) return { verified: false, killed: false };
  const termed = trySignal(-pgid, 'SIGTERM');
  await options.wait(options.graceMs);
  const killed = isAlive(pgid) ? trySignal(-pgid, 'SIGKILL') : false;
  // `verified` says the group we found is this run's; `killed` says a signal really landed. A group that had
  // already exited between `isAlive` and here, or one every `kill` refused, reports `killed: false` — so the
  // Resumer can tell "I stopped it" from "there was nothing left to stop".
  return { verified: true, killed: termed || killed };
}

/**
 * Best-effort TERM -> grace -> KILL of the whole process group, addressed as `-pgid`. Never throws: a dead group
 * is not an error. Only ever called while the group LEADER is known alive (an escalation during the run): once the
 * leader has been reaped its pid can be recycled, and the post-exit cleanup uses `killGroupMembers` instead.
 */
export async function killGroup(pgid: number, wait: (ms: number) => Promise<void>, graceMs: number): Promise<void> {
  if (!isAddressableGroup(pgid)) return;
  trySignal(-pgid, 'SIGTERM');
  await wait(graceMs);
  trySignal(-pgid, 'SIGKILL');
}
