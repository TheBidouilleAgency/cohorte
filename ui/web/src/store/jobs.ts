import { create } from 'zustand';
import type { JobView } from '../../../shared/api';
import { api } from '../api/client';
import { onProjectChange, useApp } from './app';

export const LIVE = ['starting', 'running', 'ready'];
export type WatchedJob = JobView & { lines: string[]; cursor: number };

interface JobsState {
  job: WatchedJob | null;
  watch: (j: JobView) => void;
  /** One poll: appends new log lines; reloads the project's detail when the status changed. Returns whether to keep polling. */
  poll: () => Promise<boolean>;
}

export const useJobs = create<JobsState>((set, get) => ({
  job: null,
  watch: (j) => set({ job: { ...j, lines: [], cursor: 0 } }),
  async poll() {
    const cur = get().job;
    const sel = useApp.getState().sel;
    if (!cur || !sel) return false;
    const v = await api.jobLogs(sel, cur.id, cur.cursor);
    const lines = cur.lines.concat(v.lines ?? []).slice(-1500);
    set({ job: { ...v, lines, cursor: v.cursor ?? cur.cursor } });
    const changed = v.status !== cur.status;
    if (changed) await useApp.getState().reloadDetail();
    return LIVE.includes(v.status) || changed;
  },
}));
onProjectChange(() => useJobs.setState({ job: null }));

export const stopJob = (id: string) => useApp.getState().act(async () => { const sel = useApp.getState().sel; if (sel) await api.stopJob(sel, id); });
