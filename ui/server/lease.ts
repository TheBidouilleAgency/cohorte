// The lease on a feature: which process may start its runs. One file per feature,
// <dataDir>/leases/<projectId>/<featureId>.lock, created with O_EXCL — so two processes (the UI, a terminal) that
// both want to start a stage cannot both get it — holding the holder's pid and start time (proc.ts). It is removed
// when the holder has nothing of the feature in flight; a holder that died (or whose pid now names another process)
// leaves a stale file, which the next taker replaces. `cohorte take-over` clears it by hand.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { alive, isSelf, self } from './proc';

export interface LeaseHolder { pid: number; start: number | null; by: 'ui' | 'cli'; at: string; token: string }
const SAFE = /^[A-Za-z0-9._-]+$/;

export class Leases {
  constructor(private dir: string) {}

  private file(projectId: string, id: string): string | null {
    return SAFE.test(projectId) && SAFE.test(id) ? path.join(this.dir, projectId, `${id}.lock`) : null;
  }
  private read(f: string): LeaseHolder | null {
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && typeof v.pid === 'number' ? v : null; } catch { return null; }
  }

  /** The live holder, or null (none, or a stale one). */
  holder(projectId: string, id: string): LeaseHolder | null {
    const f = this.file(projectId, id);
    const h = f ? this.read(f) : null;
    return h && alive(h.pid, h.start) ? h : null;
  }
  mine(projectId: string, id: string): boolean { return isSelf(this.holder(projectId, id)); }

  /** Takes the lease (re-entrant). Returns null when this process holds it, else the live holder that refused it. */
  acquire(projectId: string, id: string, by: 'ui' | 'cli'): LeaseHolder | null {
    const f = this.file(projectId, id);
    if (!f) return null;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      const mine: LeaseHolder = { pid: self.pid, start: self.start, by, at: new Date().toISOString(), token: crypto.randomBytes(6).toString('hex') };
      try {
        const fd = fs.openSync(f, 'wx');
        try { fs.writeSync(fd, JSON.stringify(mine)); } finally { fs.closeSync(fd); }
        return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const h = this.read(f);
      if (h && isSelf(h)) return null;
      if (h && alive(h.pid, h.start)) return h;
      // stale (or half-written): move it aside by rename — atomic — and only drop it if it is still the stale one
      const aside = `${f}.stale.${self.pid}.${crypto.randomBytes(3).toString('hex')}`;
      try { fs.renameSync(f, aside); } catch { continue; }
      const moved = this.read(aside);
      if (moved && h && moved.token !== h.token && alive(moved.pid, moved.start)) {
        // someone took it between our read and our rename: put theirs back
        try { fs.linkSync(aside, f); } catch { /* they will retake it */ }
      }
      try { fs.rmSync(aside, { force: true }); } catch { /* ignore */ }
    }
    return this.holder(projectId, id);
  }

  /** Drops the lease if this process holds it. */
  release(projectId: string, id: string): void {
    const f = this.file(projectId, id);
    if (f && isSelf(this.read(f))) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  }
  /** Clears it whoever holds it — `cohorte take-over`, a person's decision. Returns who held it. */
  clear(projectId: string, id: string): LeaseHolder | null {
    const f = this.file(projectId, id);
    if (!f) return null;
    const h = this.read(f);
    try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
    return h;
  }
}
