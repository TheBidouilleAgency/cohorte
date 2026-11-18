import type { StreamEvent } from '../../../shared/api';

/** Splits what the event stream has delivered so far into complete `data:` frames and the unfinished rest. Comments (`: keep-alive`) and bad JSON are dropped. */
export function parseFrames(buffer: string): { events: StreamEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: StreamEvent[] = [];
  for (const frame of parts) {
    const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try {
      const v: unknown = JSON.parse(data);
      for (const e of Array.isArray(v) ? v : [v]) if (isEvent(e)) events.push(e);
    } catch { /* not ours */ }
  }
  return { events, rest };
}

function isEvent(e: unknown): e is StreamEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (o.type === 'job' || o.type === 'run') && typeof o.id === 'string' && typeof o.projectId === 'string' && typeof o.status === 'string';
}

/** Reconnect delay: 1 s, 2 s, 4 s … capped at 15 s. */
export const backoff = (attempt: number): number => Math.min(15000, 1000 * 2 ** Math.max(0, attempt));
