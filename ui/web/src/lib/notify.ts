import type { StreamEvent } from '../../../shared/api';

export interface RunSeen { status: string; pending: number }
export type NotifyKind = 'gate' | 'finished';

/** Whether a run's change notice deserves a desktop notification: it raised a gate/question, or finished — only while the tab is hidden. */
export function notifyDecision(prev: RunSeen | undefined, ev: StreamEvent, hidden: boolean): NotifyKind | null {
  if (ev.type !== 'run' || !hidden) return null;
  const pending = ev.pending ?? 0;
  if (pending > (prev?.pending ?? 0)) return 'gate';
  if (prev?.status === 'running' && (ev.status === 'done' || ev.status === 'failed')) return 'finished';
  return null;
}

export const notifyText = (kind: NotifyKind, project: string, command: string, status: string): { title: string; body: string } =>
  kind === 'gate' ? { title: `${project} needs you`, body: `${command} is waiting for an approval or an answer` }
    : { title: `${project}: ${status === 'failed' ? 'failed' : 'done'}`, body: command };

/** The tab title: "(2) Cohorte" while approvals are pending. */
export const titleFor = (pending: number): string => (pending > 0 ? `(${pending}) Cohorte` : 'Cohorte');
