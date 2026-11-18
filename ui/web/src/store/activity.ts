import { create } from 'zustand';
import type { ActivityItem } from '../../../shared/api';
import { api } from '../api/client';

export const useActivity = create<{ items: ActivityItem[] }>(() => ({ items: [] }));

export async function loadActivity(): Promise<void> {
  try { useActivity.setState({ items: (await api.activity()).items }); } catch { /* keep the last list */ }
}

export interface ProjectActivity { running: number; pending: number }
/** Per project: how many things run and how many approvals wait. */
export function byProject(items: ActivityItem[]): Record<string, ProjectActivity> {
  const out: Record<string, ProjectActivity> = {};
  for (const i of items) {
    const a = (out[i.projectId] ??= { running: 0, pending: 0 });
    a.running += 1;
    a.pending += i.pending;
  }
  return out;
}
export const pendingTotal = (items: ActivityItem[]): number => items.reduce((n, i) => n + i.pending, 0);
