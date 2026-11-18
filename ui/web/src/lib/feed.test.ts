import { describe, expect, it } from 'vitest';
import { precedingText, showResultText } from './feed';
import type { RunEvent } from '../../../shared/api';

const text = (t: string): RunEvent => ({ t: 0, kind: 'text', text: t });
const tool: RunEvent = { t: 0, kind: 'tool', id: '1', name: 'Bash', summary: 'ls' };

describe('feed', () => {
  it('finds the last text before an event, skipping tools', () => {
    const ev = [text('a'), text('b'), tool];
    expect(precedingText(ev, 3)).toBe('b');
    expect(precedingText(ev, 0)).toBeUndefined();
  });
  it('hides a result that repeats the last message', () => {
    expect(showResultText('done', 'done')).toBe(false);
    expect(showResultText('done', 'other')).toBe(true);
    expect(showResultText('', undefined)).toBe(false);
  });
});
