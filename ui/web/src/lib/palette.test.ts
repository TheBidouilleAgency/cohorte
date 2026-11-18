import { describe, expect, it } from 'vitest';
import type { ProjectDetail, ProjectSummary } from '../../../shared/api';
import { buildItems, filterItems } from './palette';

const projects = [{ id: 'aaaaaaaaaa', root: '/x/kervo', name: 'kervo' }, { id: 'bbbbbbbbbb', root: '/x/plica', name: 'plica', title: 'Plica app' }] as ProjectSummary[];
const detail = { specs: [{ id: 'f1', pipeline: { next: { command: 'cohorte-fix', args: 'f1', why: 'review verdict REVISE' } } }, { id: 'f2', pipeline: { next: null } }] } as unknown as ProjectDetail;

describe('palette', () => {
  it('offers Home and projects without a selection', () => { expect(buildItems(projects, null, null).map((i) => i.id)).toEqual(['home', 'p:aaaaaaaaaa', 'p:bbbbbbbbbb']); });
  it('adds tabs and next-step runs for the selected project', () => {
    const ids = buildItems(projects, 'aaaaaaaaaa', detail).map((i) => i.id);
    expect(ids).toContain('tab:worktrees');
    expect(ids).toContain('run:f1');
    expect(ids).not.toContain('run:f2');
  });
  it('filters by every word, case-insensitively, over label and hint', () => {
    const items = buildItems(projects, 'aaaaaaaaaa', detail);
    expect(filterItems(items, 'RUN fix').map((i) => i.id)).toEqual(['run:f1']);
    expect(filterItems(items, 'plica').map((i) => i.id)).toEqual(['p:bbbbbbbbbb']);
    expect(filterItems(items, '')).toHaveLength(items.length);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });
});
