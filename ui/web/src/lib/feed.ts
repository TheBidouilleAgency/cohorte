import type { RunEvent } from '../../../shared/api';

/** The text of the last assistant message before event `i` — a result that repeats it is not shown twice. */
export function precedingText(events: RunEvent[], i: number): string | undefined {
  for (let k = i - 1; k >= 0; k--) {
    const e = events[k];
    if (e.kind === 'text') return e.text;
  }
  return undefined;
}

/** Whether a `result` event should print its own text (it often just repeats the final message). */
export const showResultText = (resultText: string, last: string | undefined): boolean => !!resultText && resultText !== last;
