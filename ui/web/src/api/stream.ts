import type { StreamEvent } from '../../../shared/api';
import { backoff, parseFrames } from '../lib/frames';
import { token } from './client';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';
interface Handlers { onEvents: (events: StreamEvent[]) => void; onStatus: (s: StreamStatus) => void }

/**
 * Subscribes to /api/stream with fetch + a stream reader (EventSource cannot send the Bearer header, and the token
 * must not travel in a URL). Reconnects with backoff; after three failures in a row it reports `polling` — the
 * pages' interval pollers take over — and keeps retrying slowly. Returns the unsubscribe function.
 */
export function connectStream({ onEvents, onStatus }: Handlers): () => void {
  let stopped = false;
  let ctl: AbortController | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<void> => {
    ctl = new AbortController();
    try {
      const res = await fetch('/api/stream', { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      attempt = 0;
      onStatus('live');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const { events, rest } = parseFrames(buf);
        buf = rest;
        if (events.length) onEvents(events);
      }
    } catch { /* fall through to the reconnect */ }
    if (stopped) return;
    attempt += 1;
    onStatus(attempt >= 3 ? 'polling' : 'reconnecting');
    timer = setTimeout(() => { void run(); }, backoff(attempt));
  };

  onStatus('connecting');
  void run();
  return () => { stopped = true; clearTimeout(timer); ctl?.abort(); };
}
