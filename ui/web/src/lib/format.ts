export const usd = (n: unknown): string => (typeof n === 'number' ? `$${n.toFixed(2)}` : '–');
export const num = (n: unknown): string => (typeof n === 'number' ? n.toLocaleString() : '–');
export const seconds = (ms: number | null | undefined): string => (ms ? `${Math.round(ms / 1000)}s` : '');

/** "3m ago", "2h ago", "5d ago" — for run history and last commits. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
