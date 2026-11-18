import { describe, expect, it } from 'vitest';
import { keyAction, type KeyInfo } from './keys';

const k = (key: string, o: Partial<KeyInfo> = {}): KeyInfo => ({ key, meta: false, ctrl: false, alt: false, typing: false, ...o });
describe('keyAction', () => {
  it('opens the palette even from a field', () => { expect(keyAction(k('k', { meta: true, typing: true }), false)).toEqual({ kind: 'palette' }); expect(keyAction(k('K', { ctrl: true }), false)).toEqual({ kind: 'palette' }); });
  it('g then a letter jumps to a tab', () => {
    expect(keyAction(k('g'), false)).toEqual({ kind: 'chord' });
    expect(keyAction(k('w'), true)).toEqual({ kind: 'tab', tab: 'worktrees' });
    expect(keyAction(k('w'), false)).toBeNull();
  });
  it('ignores typing in a field', () => { expect(keyAction(k('g', { typing: true }), false)).toBeNull(); expect(keyAction(k('?', { typing: true }), false)).toBeNull(); });
  it('? opens help', () => { expect(keyAction(k('?'), false)).toEqual({ kind: 'help' }); });
});
