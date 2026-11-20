import { create } from 'zustand';
import type { FoundingView, NewProjectBody, RemoteInfo } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { onProjectChange, selectProject, useApp } from './app';
import { openChat, pollChat, useFlow } from './flow';
import { useJobs } from './jobs';

/** New project: the form on Home, the founding page of a project being founded, and the code-host card. */
interface FoundingState {
  /** The New project form is open (Home). `existing` pre-fills it for a repo that does not use cohorte yet. */
  form: null | { mode: NewProjectBody['mode']; path?: string };
  view: FoundingView | null;
  remote: RemoteInfo | null; remoteFor: string | null; remoteBusy: boolean;
}
export const useFounding = create<FoundingState>(() => ({ form: null, view: null, remote: null, remoteFor: null, remoteBusy: false }));
onProjectChange(() => useFounding.setState({ view: null, remote: null, remoteFor: null }));

const sel = (): string | null => useApp.getState().sel;
const guard = (fn: () => Promise<void>) => useApp.getState().guard(fn);

export const openNewProject = (mode: NewProjectBody['mode'] = 'idea', path?: string): void => {
  useFounding.setState({ form: { mode, path } });
  if (useApp.getState().sel) useApp.setState({ sel: null, detail: null });
};
export const closeNewProject = (): void => useFounding.setState({ form: null });

export const createProject = (body: NewProjectBody) => guard(async () => {
  const r = await api.newProject(body);
  useFounding.setState({ form: null, view: r.founding });
  await useApp.getState().refresh();
  await selectProject(r.project.id);
  await openChat(r.founding.currentRunId);
});

export async function loadFounding(): Promise<void> {
  const id = sel(); if (!id) return;
  try {
    const v = await api.founding(id);
    if (sel() !== id) return;
    const prev = useFounding.getState().view;
    useFounding.setState({ view: v });
    // follow the agent the founding talks with now
    const chat = useFlow.getState().chat;
    const want = v.currentRunId || v.stages[v.stages.length - 1]?.runId || null;
    if (want && (!chat || (prev?.currentRunId !== v.currentRunId && chat.id !== want))) await openChat(want);
    if (v.phase === 'done' || v.phase === 'abandoned') await useApp.getState().refresh();
  } catch { /* not founding (any more) */ }
}

export const foundingReply = (text: string) => guard(async () => {
  const id = sel(); if (!id) return;
  useFounding.setState({ view: await api.foundingReply(id, text) });
  await pollChat();
});
export const foundingCheckpoint = (action: string, text?: string) => guard(async () => {
  const id = sel(); if (!id) return;
  const v = await api.foundingCheckpoint(id, { action, text });
  useFounding.setState({ view: v });
  if (v.currentRunId) await openChat(v.currentRunId);
  if (action === 'abandon') await useApp.getState().refresh();
});

export async function loadRemote(force = false): Promise<void> {
  const id = sel(); if (!id) return;
  if (!force && useFounding.getState().remoteFor === id) return;
  useFounding.setState({ remoteBusy: true });
  try { const r = await api.remote(id); if (sel() === id) useFounding.setState({ remote: r, remoteFor: id }); } catch (e) { useApp.getState().setError(errorMessage(e)); }
  useFounding.setState({ remoteBusy: false });
}
export const connectRemote = (body: { kind: 'github' | 'url'; name?: string; visibility?: string; url?: string }) => guard(async () => {
  const id = sel(); if (!id) return;
  const r = await api.connectRemote(id, body);
  useJobs.getState().watch(r.job);
});
