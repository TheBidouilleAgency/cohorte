// Which process holds something — a run, a feature's lease — and whether it is still the SAME process.
//
// A pid alone is not an identity: after a reboot (or enough churn) it names someone else, and `kill -0` on another
// user's process answers EPERM — "alive" — forever. So every holder records its pid AND its start time, and a
// holder is alive only while a process with that pid exists and started then. The start time is read from the OS
// (`/proc` on Linux, `ps` on macOS/BSD, PowerShell's Get-Process on Windows), to the second. When it cannot be read
// for a process that exists (`ps` failed, timed out), the holder is taken as alive: a stolen live lease is worse than
// a stuck one, which `cohorte take-over` clears.

import fs from 'fs';
import { spawnSync } from 'child_process';

export interface ProcId { pid: number; start: number | null }

/** This process: its pid and its start, in epoch seconds. */
export const self: ProcId = { pid: process.pid, start: Math.round(Date.now() / 1000 - process.uptime()) };

const SLACK_S = 3; // the OS reports seconds (ps) or clock ticks since boot (/proc): a little rounding either way
const cache = new Map<number, { at: number; start: number | null }>();

let bootS: number | null | undefined;
function linuxStart(pid: number): number | null {
  try {
    if (bootS === undefined) bootS = Number((fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m) || [])[1]) || null;
    if (!bootS) return null;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // the command name may hold spaces
    const ticks = Number(fields[19]); // field 22 of the whole line
    return Number.isFinite(ticks) ? Math.round(bootS + ticks / 100) : null; // USER_HZ is 100 on every Linux we run on
  } catch { return null; }
}
function winStart(pid: number): number | null {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`],
    { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const t = Date.parse((r.stdout || '').trim());
  return r.status === 0 && Number.isFinite(t) ? Math.round(t / 1000) : null;
}
function psStart(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 3000 });
  const t = Date.parse((r.stdout || '').trim());
  return r.status === 0 && Number.isFinite(t) ? Math.round(t / 1000) : null;
}

/** When `pid` started (epoch seconds), or null when it is gone or the OS will not say. Cached a few seconds. */
export function startOf(pid: number): number | null {
  if (pid === process.pid) return self.start;
  const hit = cache.get(pid);
  if (hit && Date.now() - hit.at < 5000) return hit.start;
  const start = process.platform === 'linux' ? linuxStart(pid) : process.platform === 'win32' ? winStart(pid) : psStart(pid);
  cache.set(pid, { at: Date.now(), start });
  return start;
}

/** The process that recorded (pid, start) is still running. A record without a start (older files) is judged by its pid. */
export function alive(pid: unknown, start?: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return typeof start !== 'number' || Math.abs(start - (self.start as number)) <= SLACK_S;
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  if (typeof start !== 'number') return true;
  const now = startOf(pid);
  return now === null ? true : Math.abs(now - start) <= SLACK_S; // it exists, its start unknown: alive
}

function parentOf(pid: number): number | null {
  if (process.platform === 'linux') {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) || null; } catch { return null; }
  }
  if (process.platform === 'win32') return null;
  const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? Number((r.stdout || '').trim()) || null : null;
}

/** This process's ancestors, nearest first, each with its start time — to tell whether a cohorte run is one of them. */
export function ancestors(max = 40): ProcId[] {
  const out: ProcId[] = [];
  for (let pid = parentOf(process.pid); pid && pid > 1 && out.length < max; pid = parentOf(pid)) out.push({ pid, start: startOf(pid) });
  return out;
}

/** Whether a record names this very process. */
export const isSelf = (h: { pid?: unknown; start?: unknown } | null | undefined): boolean =>
  !!h && h.pid === process.pid && (typeof h.start !== 'number' || Math.abs(h.start - (self.start as number)) <= SLACK_S);
