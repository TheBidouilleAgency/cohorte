export type Theme = 'dark' | 'light';
const KEY = 'cohorte-theme';

export function initialTheme(): Theme {
  try { const v = localStorage.getItem(KEY); if (v === 'dark' || v === 'light') return v; } catch { /* storage blocked */ }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage blocked */ }
}
