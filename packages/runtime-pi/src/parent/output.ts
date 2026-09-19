// The child's stdout and stderr (DESIGN 3.2). They are never parsed and never reach a raw file: the engine can print
// refresh or login error bodies that hold token material, so every line goes through the sealed logger. Bounded:
// a line is cut at 64 KiB, an incarnation gets 1 MiB, then ONE "truncated" line; the pipes are still drained, so a
// flooding child neither blocks nor grows the parent.

import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export const OUTPUT_LINE_CAP = 64 * 1024;
export const OUTPUT_INCARNATION_CAP = 1024 * 1024;

export interface OutputBudget {
  left: number;
  truncated: boolean;
}
export const newOutputBudget = (): OutputBudget => ({ left: OUTPUT_INCARNATION_CAP, truncated: false });

export function drainChildOutput(
  stream: Readable,
  name: 'stdout' | 'stderr',
  budget: OutputBudget,
  write: (line: string, stream: 'stdout' | 'stderr') => void,
): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let skippingLongLine = false;

  const emit = (line: string): void => {
    if (budget.truncated || line.length === 0) return;
    if (line.length > budget.left) {
      budget.truncated = true;
      budget.left = 0;
      write(`[child output truncated after ${OUTPUT_INCARNATION_CAP} bytes for this incarnation]`, name);
      return;
    }
    budget.left -= line.length;
    write(line, name);
  };

  const feed = (text: string): void => {
    if (budget.truncated) return;
    pending += text;
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      if (skippingLongLine) skippingLongLine = false;
      else emit(line);
    }
    if (pending.length > OUTPUT_LINE_CAP) {
      if (!skippingLongLine) emit(`${pending.slice(0, OUTPUT_LINE_CAP)} [line cut at ${OUTPUT_LINE_CAP} bytes]`);
      skippingLongLine = true;
      pending = '';
    }
  };

  stream.on('data', (chunk: Buffer) => feed(decoder.write(chunk)));
  stream.on('end', () => {
    feed(decoder.end());
    if (!skippingLongLine) emit(pending);
    pending = '';
  });
  stream.on('error', () => {});
}
