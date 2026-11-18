// The machine reports under specs/reports/ arrive as `unknown` (shared/api.ts); these read the few fields the cards show.
export type Rec = Record<string, unknown>;
export const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
export const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface VerifyCheck { name: string; status: string; note: string }
export function verifyChecks(v: Rec): VerifyCheck[] {
  return list(v.checks).map((c) => rec(c)).filter((c): c is Rec => !!c).map((c) => ({ name: text(c.name), status: text(c.status), note: text(c.note) }));
}
export function surfaces(v: Rec): { name: string; state: string }[] {
  const s = rec(v.surfaces);
  if (s) return Object.entries(s).map(([name, state]) => ({ name, state: text(state) }));
  return list(v.surfaces).map((n) => ({ name: text(n), state: '' }));
}

export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export function countBySeverity(rows: { severity: string }[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const r of rows) out[r.severity] = (out[r.severity] ?? 0) + 1;
  return out;
}
