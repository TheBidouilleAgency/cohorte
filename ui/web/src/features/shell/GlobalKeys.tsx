import { useEffect } from 'react';
import { CHORD_WINDOW_MS, keyAction } from '../../lib/keys';
import { useApp } from '../../store/app';
import { goTabId } from '../../store/nav';
import { useUi } from '../../store/ui';

const typingIn = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/** Palette (Ctrl/⌘ K), help (?), and `g` + letter tab chords. Chords need a selected project; none fire while typing. */
export function GlobalKeys() {
  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      const a = keyAction({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, typing: typingIn(e.target) }, Date.now() - g < CHORD_WINDOW_MS);
      if (!a) return;
      if (a.kind === 'palette') { e.preventDefault(); useUi.getState().setPalette(!useUi.getState().paletteOpen); }
      else if (a.kind === 'help') { e.preventDefault(); useUi.getState().setHelp(true); }
      else if (a.kind === 'chord') g = Date.now();
      else if (useApp.getState().sel) { e.preventDefault(); g = 0; goTabId(a.tab); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
