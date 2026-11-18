import { create } from 'zustand';
import type { DockerStatus } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { withGate } from '../lib/gated';
import { onProjectChange, useApp } from './app';
import { useJobs } from './jobs';

interface DockerState { docker: DockerStatus | { error: string } | null; load: () => Promise<void> }

export const useDocker = create<DockerState>((set) => ({
  docker: null,
  async load() {
    const sel = useApp.getState().sel;
    if (!sel) return;
    try { set({ docker: await api.docker(sel) }); } catch (e) { set({ docker: { error: errorMessage(e) } }); }
  },
}));
onProjectChange(() => useDocker.setState({ docker: null }));

export const dockerAct = (action: string, service?: string) => useApp.getState().act(async () => {
  const sel = useApp.getState().sel;
  if (!sel) return;
  if (action === 'down' && !window.confirm('Stop and remove the stack’s containers?\n\nVolumes (your data) are kept.')) return;
  const r = await withGate((confirmed) => api.dockerAct(sel, { action, service, confirmed }));
  useJobs.getState().watch(r.job);
  setTimeout(() => { if (useApp.getState().tab === 'docker') void useDocker.getState().load(); }, 2500);
});
