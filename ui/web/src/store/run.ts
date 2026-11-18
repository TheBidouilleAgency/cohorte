import { create } from 'zustand';
import type { Command, RunView, RunEvent, PendingItem } from '../../../shared/api';
import { ApiError, api } from '../api/client';
import { missingArgPrompt, needsArgument, untrustedPrompt } from '../lib/gate';
import { onProjectChange, useApp } from './app';

export interface RunForm { wt: string; cmd: string; args: string; mode: string }
export type WatchedRun = Omit<RunView, 'events' | 'cursor' | 'pending'> & { events: RunEvent[]; cursor: number; pending: PendingItem[] };

interface RunState {
  commands: Command[] | null; form: Partial<RunForm>; run: WatchedRun | null;
  setForm: (patch: Partial<RunForm>) => void;
  watch: (r: RunView) => void;
  poll: () => Promise<boolean>;
}

const asWatched = (r: RunView): WatchedRun => ({ ...r, events: r.events ?? [], cursor: r.cursor ?? 0, pending: r.pending ?? [] });
export const useRun = create<RunState>((set, get) => ({
  commands: null, form: {}, run: null,
  setForm: (patch) => set({ form: { ...get().form, ...patch } }),
  watch: (r) => set({ run: asWatched(r) }),
  async poll() {
    const cur = get().run;
    const sel = useApp.getState().sel;
    if (!cur || !sel) return false;
    const v = await api.run(sel, cur.id, cur.cursor);
    set({ run: { ...asWatched(v), events: cur.events.concat(v.events ?? []).slice(-1500), cursor: v.cursor ?? cur.cursor } });
    if (v.status !== 'running') { await useApp.getState().reloadDetail(); return false; }
    return true;
  },
}));
onProjectChange(() => useRun.setState({ run: null, form: {} }));

export async function loadCommands(): Promise<void> {
  if (useRun.getState().commands) return;
  try { useRun.setState({ commands: (await api.commands()).commands }); } catch { useRun.setState({ commands: [] }); }
}

export async function startRun(form: RunForm): Promise<void> {
  const sel = useApp.getState().sel;
  if (!sel) return;
  const c = (useRun.getState().commands ?? []).find((x) => x.name === form.cmd);
  if (c && needsArgument(c.argumentHint, form.args) && !window.confirm(missingArgPrompt(c.name, c.argumentHint))) return;
  const body = { worktree: form.wt, command: form.cmd, args: form.args, permissionMode: form.mode };
  await useApp.getState().guard(async () => {
    let r;
    try { r = await api.startRun(sel, body); } catch (e) {
      if (!(e instanceof ApiError) || !e.body.untrusted) throw e;
      if (!window.confirm(untrustedPrompt(e.message, e.body.fix))) throw new Error('cancelled');
      r = await api.startRun(sel, { ...body, acknowledgeUntrusted: true });
    }
    useRun.getState().watch(r.run);
  });
}

export const sendReply = (text: string) => useApp.getState().guard(async () => {
  const sel = useApp.getState().sel; const run = useRun.getState().run;
  if (!sel || !run) return;
  const r = await api.reply(sel, run.id, text);
  useRun.setState({ run: { ...asWatched(r.run), events: run.events.concat(r.run.events?.slice(run.cursor) ?? []), cursor: r.run.cursor ?? run.cursor } });
});

export async function respond(requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string[]>): Promise<void> {
  const sel = useApp.getState().sel; const run = useRun.getState().run;
  if (!sel || !run) return;
  try { await api.respond(sel, run.id, { requestId, behavior, answers }); await useRun.getState().poll(); } catch (e) { useApp.getState().setError(e instanceof Error ? e.message : String(e)); }
}

export async function stopRun(): Promise<void> {
  const sel = useApp.getState().sel; const run = useRun.getState().run;
  if (sel && run) { await api.stopRun(sel, run.id); await useRun.getState().poll(); }
}

/** Opens a past run (kept by the server across restarts) — its feed, and, if it has a session, the reply box. */
export const openRun = (id: string) => useApp.getState().guard(async () => {
  const sel = useApp.getState().sel;
  if (sel) useRun.getState().watch(await api.run(sel, id, 0));
});
