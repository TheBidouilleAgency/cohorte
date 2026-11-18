import type { ProjectDetail, ProjectSummary } from '../../../shared/api';
import { TAB_CHORDS } from './keys';

export type PaletteAction = { kind: 'home' } | { kind: 'project'; id: string } | { kind: 'tab'; tab: string } | { kind: 'run'; specId: string };
export interface PaletteItem { id: string; group: string; label: string; hint: string; action: PaletteAction }

const TAB_LABELS: Record<string, string> = { overview: 'Overview', health: 'Health', specs: 'Specs', run: 'Run', worktrees: 'Worktrees', docker: 'Docker', cost: 'Cost' };

export function buildItems(projects: ProjectSummary[], sel: string | null, detail: ProjectDetail | null): PaletteItem[] {
  const items: PaletteItem[] = [{ id: 'home', group: 'Go to', label: 'Home', hint: 'all projects and activity', action: { kind: 'home' } }];
  if (sel) {
    for (const [letter, tab] of Object.entries(TAB_CHORDS)) items.push({ id: `tab:${tab}`, group: 'Go to', label: TAB_LABELS[tab] ?? tab, hint: `g ${letter}`, action: { kind: 'tab', tab } });
    for (const sp of detail?.specs ?? []) {
      const n = sp.pipeline?.next;
      if (n) items.push({ id: `run:${sp.id}`, group: 'Run', label: `Run /${n.command} ${n.args}`, hint: n.why, action: { kind: 'run', specId: sp.id } });
    }
  }
  for (const p of projects) items.push({ id: `p:${p.id}`, group: 'Projects', label: p.title || p.name, hint: p.root, action: { kind: 'project', id: p.id } });
  return items;
}

/** Every whitespace-separated word of the query must appear in the item's label or hint. */
export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((i) => { const hay = `${i.label} ${i.hint}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}
