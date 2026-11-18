/** Keyboard shortcuts: `g` then a letter jumps to a tab. Pure, so the chords are testable. */
export const TAB_CHORDS: Record<string, string> = { o: 'overview', h: 'health', s: 'specs', r: 'run', w: 'worktrees', d: 'docker', c: 'cost' };
export const CHORD_WINDOW_MS = 1200;

export const SHORTCUTS: [string, string][] = [
  ['⌘K / Ctrl+K', 'Command palette'], ['?', 'This help'], ['g o', 'Overview'], ['g h', 'Health'], ['g s', 'Specs'], ['g r', 'Run'],
  ['g w', 'Worktrees'], ['g d', 'Docker'], ['g c', 'Cost'], ['Esc', 'Close a dialog'],
];

export interface KeyInfo { key: string; meta: boolean; ctrl: boolean; alt: boolean; typing: boolean }

export type KeyAction = { kind: 'palette' } | { kind: 'help' } | { kind: 'tab'; tab: string } | { kind: 'chord' } | null;

/** `pendingG`: whether `g` was pressed within the chord window. */
export function keyAction(k: KeyInfo, pendingG: boolean): KeyAction {
  if ((k.meta || k.ctrl) && k.key.toLowerCase() === 'k') return { kind: 'palette' };
  if (k.typing || k.meta || k.ctrl || k.alt) return null;
  if (pendingG && TAB_CHORDS[k.key]) return { kind: 'tab', tab: TAB_CHORDS[k.key] };
  if (k.key === 'g') return { kind: 'chord' };
  if (k.key === '?') return { kind: 'help' };
  return null;
}
