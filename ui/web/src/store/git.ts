import { create } from 'zustand';
import type { ChangedFile, FileDiff, GitResponse } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { onProjectChange, useApp } from './app';

export const useGit = create<{ git: GitResponse | null; error: string | null }>(() => ({ git: null, error: null }));
export const useDiff = create<{ wt: string | null; base: string | null; files: ChangedFile[] | null; file: FileDiff | null; error: string | null }>(() => ({ wt: null, base: null, files: null, file: null, error: null }));
onProjectChange(() => { useGit.setState({ git: null, error: null }); useDiff.setState({ wt: null, base: null, files: null, file: null, error: null }); });

export async function loadGit(): Promise<void> {
  const sel = useApp.getState().sel;
  if (!sel) return;
  try { const g = await api.git(sel); if (useApp.getState().sel === sel) useGit.setState({ git: g, error: null }); } catch (e) { useGit.setState({ error: errorMessage(e) }); }
}

export async function openDiff(wt: string): Promise<void> {
  const sel = useApp.getState().sel;
  if (!sel) return;
  useDiff.setState({ wt, base: null, files: null, file: null, error: null });
  try { const r = await api.diffList(sel, wt); useDiff.setState({ base: r.base, files: r.files }); } catch (e) { useDiff.setState({ error: errorMessage(e) }); }
}
export async function openFileDiff(file: string): Promise<void> {
  const sel = useApp.getState().sel; const wt = useDiff.getState().wt;
  if (!sel || !wt) return;
  try { useDiff.setState({ file: await api.fileDiff(sel, wt, file), error: null }); } catch (e) { useDiff.setState({ error: errorMessage(e) }); }
}
export const closeDiff = (): void => useDiff.setState({ wt: null, base: null, files: null, file: null, error: null });
