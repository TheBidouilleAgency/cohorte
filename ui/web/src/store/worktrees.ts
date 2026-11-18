import { create } from 'zustand';
import type { DockerPreflight, Worktree } from '../../../shared/api';
import { ApiError, api } from '../api/client';
import { withGate } from '../lib/gated';
import { onProjectChange, useApp } from './app';
import { useJobs } from './jobs';

export type Preflight = DockerPreflight & { feature: string; message: string };
export const usePreflight = create<{ preflight: Preflight | null }>(() => ({ preflight: null }));
onProjectChange(() => usePreflight.setState({ preflight: null }));

const sel = () => useApp.getState().sel;

export const startDev = (w: Worktree) => useApp.getState().act(async () => {
  const id = sel(); if (!id) return;
  const r = await withGate((confirmed) => api.startDev(id, { worktree: w.path, confirmed }));
  useJobs.getState().watch(r.job);
});

export const createWorktree = (feature: string, skipDockerCheck = false) => useApp.getState().act(async () => {
  const id = sel(); if (!id) return;
  usePreflight.setState({ preflight: null });
  try {
    const r = await withGate((confirmed) => api.createWorktree(id, { feature, confirmed, skipDockerCheck: skipDockerCheck || undefined }));
    useJobs.getState().watch(r.job);
  } catch (e) {
    if (!(e instanceof ApiError) || !e.body.dockerPreflight) throw e;
    usePreflight.setState({ preflight: { feature, ...e.body.dockerPreflight, message: e.message } });
  }
});

export const removeWorktree = (w: Worktree) => useApp.getState().act(async () => {
  const id = sel(); if (!id) return;
  if (!window.confirm(`Remove the worktree ${w.path}?\n\nGit refuses if it has uncommitted changes. The branch is kept.`)) return;
  const r = await withGate((confirmed) => api.removeWorktree(id, { path: w.path, confirmed }));
  useJobs.getState().watch(r.job);
});
