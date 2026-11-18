import { isTab, useApp, type TabId } from './app';
import { loadCommands, useRun, type RunForm } from './run';
import { loadMetrics } from './specs';

/** Switches tab and loads what that tab needs. */
export function goTab(t: TabId): void {
  useApp.getState().setTab(t);
  if (t === 'run') void loadCommands();
  if (t === 'cost') void loadMetrics();
}
export const goTabId = (t: string): void => { if (isTab(t)) goTab(t); };

/** Opens the Run tab with the form filled in. It never starts the run: the form, its confirmations and the gate still apply. */
export function prefillRun(p: Pick<RunForm, 'wt' | 'cmd' | 'args'>): void {
  useRun.getState().setForm(p);
  goTab('run');
}
