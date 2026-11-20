import { create } from 'zustand';
import type { StreamEvent } from '../../../shared/api';
import { connectStream, type StreamStatus } from '../api/stream';
import { notifyDecision, notifyText, type RunSeen } from '../lib/notify';
import { loadActivity, useActivity } from './activity';
import { useApp } from './app';
import { loadGit } from './git';
import { useJobs } from './jobs';
import { useRun } from './run';
import { useUi } from './ui';
import { pollChat, refreshFlow, useFlow } from './flow';

export const useLive = create<{ status: StreamStatus }>(() => ({ status: 'connecting' }));
export const isLive = (s: StreamStatus): boolean => s === 'live';

const seen = new Map<string, RunSeen>();
let timers: Record<string, ReturnType<typeof setTimeout>> = {};
const debounce = (key: string, ms: number, fn: () => void): void => { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); };

async function maybeNotify(ev: StreamEvent): Promise<void> {
  const prev = seen.get(ev.id);
  if (ev.type === 'run') seen.set(ev.id, { status: ev.status, pending: ev.pending ?? 0 });
  if (!useUi.getState().notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const kind = notifyDecision(prev, ev, document.hidden);
  if (!kind) return;
  if (!useActivity.getState().items.some((i) => i.id === ev.id)) await loadActivity(); // a run we have not listed yet: get its command for the text
  const proj = useApp.getState().projects.find((p) => p.id === ev.projectId);
  const item = useActivity.getState().items.find((i) => i.id === ev.id);
  const { title, body } = notifyText(kind, proj?.title || proj?.name || 'Cohorte', item?.label ?? 'a cohorte command', ev.status);
  try {
    const n = new Notification(title, { body, tag: `cohorte-${ev.id}-${kind}` });
    n.onclick = () => { window.focus(); location.hash = `#/p/${ev.projectId}/run`; n.close(); };
  } catch { /* notifications unavailable */ }
}

/** One batch of change notices: refresh only what they name, debounced. */
export function handleEvents(events: StreamEvent[]): void {
  const app = useApp.getState();
  for (const ev of events) {
    if (ev.type === 'flow') { debounce('flow', 250, refreshFlow); continue; }
    void maybeNotify(ev);
    if (ev.type === 'run' && useFlow.getState().chat?.id === ev.id) debounce(`chat:${ev.id}`, 100, () => { void pollChat(); });
    if (ev.projectId !== app.sel) { if (ev.type === 'run') debounce('flow', 400, refreshFlow); continue; }
    if (ev.type === 'job') {
      const j = useJobs.getState().job;
      if (j && j.id === ev.id) debounce(`job:${ev.id}`, 150, () => { void useJobs.getState().poll(); });
      debounce('detail', 400, () => { void useApp.getState().reloadDetail(); if (useApp.getState().tab === 'worktrees') void loadGit(); });
    } else {
      const r = useRun.getState().run;
      if (r && r.id === ev.id) debounce(`run:${ev.id}`, 100, () => { void useRun.getState().poll(); });
      if (ev.status !== 'running') debounce('detail', 300, () => { void useApp.getState().reloadDetail(); });
      debounce('flow', 400, refreshFlow);
    }
  }
  debounce('activity', 300, () => { void loadActivity(); });
}

let started = false;
/** Starts the stream once. Until it is live the interval pollers do the work (see `isLive`). */
export function startLive(): void {
  if (started) return;
  started = true;
  void loadActivity();
  connectStream({ onEvents: handleEvents, onStatus: (status) => { useLive.setState({ status }); if (status === 'live') void loadActivity(); } });
  setInterval(() => { void loadActivity(); }, 20000);
}
export const _resetTimers = (): void => { timers = {}; };
