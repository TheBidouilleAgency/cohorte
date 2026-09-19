// ONE transport interface, two codecs (PLAN F-6, DESIGN 3.2): the Node 'ipc' channel — what the spike executed,
// including under sandbox-exec — and LF-delimited JSON over fd 3 (parent -> child) / fd 4 (child -> parent), the
// drop-in alternate for a sandbox backend that cannot pass the IPC fd. The frame schema is the same on both.
import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { err, type Result } from '@cohorte/base';
import {
  type ChildFrame,
  decodeFrame,
  encodeFrame,
  type FrameRejection,
  MAX_FRAME_CHARS,
  type ParentFrame,
} from '../protocol.ts';

export type TransportKind = 'ipc' | 'fd';

export interface FrameTransport {
  /** Resolves once the frame was handed to the channel; `false` when the channel is gone. Never rejects. */
  send(frame: ParentFrame): Promise<boolean>;
  /** Every inbound message, decoded: a frame or a rejection. One listener. */
  onFrame(listener: (decoded: Result<ChildFrame, FrameRejection>) => void): void;
  /** The peer closed the channel (`disconnect` or fd EOF): it died, or it is hostile. */
  onClose(listener: () => void): void;
  close(): void;
}

export function stdioFor(kind: TransportKind): StdioOptions {
  // stdout and stderr are PIPES into the parent, never a raw file (DESIGN 3.2, I7).
  return kind === 'ipc' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'];
}

function ipcTransport(child: ChildProcess): FrameTransport {
  return {
    send: (frame) =>
      new Promise((resolve) => {
        if (!child.connected) return resolve(false);
        try {
          child.send(encodeFrame(frame, 'ipc') as object, (error) => resolve(error === null));
        } catch {
          resolve(false);
        }
      }),
    onFrame: (listener) => void child.on('message', (raw) => listener(decodeFrame('child', raw, 'ipc'))),
    onClose: (listener) => void child.once('disconnect', listener),
    close: () => {
      if (child.connected) child.disconnect();
    },
  };
}

function fdTransport(child: ChildProcess): FrameTransport {
  const toChild = child.stdio[3] as Writable | null | undefined;
  const fromChild = child.stdio[4] as Readable | null | undefined;
  if (!toChild || !fromChild)
    throw new TypeError('fd transport: the child was not spawned with fd 3 and fd 4 as pipes');
  toChild.on('error', () => {});
  return {
    send: (frame) =>
      new Promise((resolve) => {
        if (toChild.destroyed || !toChild.writable) return resolve(false);
        toChild.write(encodeFrame(frame, 'lf'), (error) => resolve(error === null || error === undefined));
      }),
    onFrame: (listener) => {
      let buffer = '';
      let overflow = false;
      fromChild.setEncoding('utf8');
      fromChild.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (overflow) overflow = false;
          else if (line.length > 0) listener(decodeFrame('child', line, 'lf'));
        }
        // A line that never ends is refused once, then dropped up to its end: it is never buffered whole.
        if (buffer.length > MAX_FRAME_CHARS) {
          if (!overflow)
            listener(err({ reason: 'too-large', detail: `a line of more than ${MAX_FRAME_CHARS} characters` }));
          overflow = true;
          buffer = '';
        }
      });
    },
    onClose: (listener) => {
      fromChild.once('end', listener);
      fromChild.once('error', listener);
    },
    close: () => {
      toChild.destroy();
      fromChild.destroy();
    },
  };
}

export function transportFor(kind: TransportKind, child: ChildProcess): FrameTransport {
  return kind === 'ipc' ? ipcTransport(child) : fdTransport(child);
}
