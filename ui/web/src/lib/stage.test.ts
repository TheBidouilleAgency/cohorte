import { describe, expect, it } from 'vitest';
import type { PipelineInfo, StageState, Worktree } from '../../../shared/api';
import { columnOf, nextLabel, nextPrefill } from './stage';

const pipe = (states: StageState[], next: PipelineInfo['next'] = null): PipelineInfo => ({
  stages: ['spec', 'build', 'review', 'verify', 'ship'].map((key, i) => ({ key, label: key, state: states[i] })), next, verdict: null, loop: null,
});
const wt = (path: string, branch: string | null, main = false): Worktree => ({ path, branch, main, dev: null });

describe('columnOf', () => {
  it('is the first unfinished stage', () => {
    expect(columnOf({ status: 'draft', pipeline: pipe(['current', 'todo', 'todo', 'todo', 'todo']) })).toBe('spec');
    expect(columnOf({ status: 'in-review', pipeline: pipe(['done', 'done', 'blocked', 'todo', 'todo']) })).toBe('review');
  });
  it('skips skipped stages and ends in Closed', () => {
    expect(columnOf({ status: 'in-review', pipeline: pipe(['done', 'done', 'done', 'skipped', 'current']) })).toBe('ship');
    expect(columnOf({ status: 'merged', pipeline: pipe(['done', 'done', 'done', 'done', 'done']) })).toBe('done');
  });
  it('an abandoned spec is closed, one without a pipeline too', () => {
    expect(columnOf({ status: 'abandoned', pipeline: pipe(['done', 'todo', 'todo', 'todo', 'todo']) })).toBe('done');
    expect(columnOf({ status: 'draft' })).toBe('done');
  });
});

describe('nextPrefill', () => {
  const next = { command: 'cohorte-fix', args: 'f1', why: 'x' };
  it('targets the worktree on the spec branch', () => {
    const r = nextPrefill({ branch: 'feat/f1', pipeline: pipe(['done', 'done', 'blocked', 'todo', 'todo'], next) }, [wt('/r', 'main', true), wt('/r-f1', 'feat/f1')]);
    expect(r).toEqual({ wt: '/r-f1', cmd: 'cohorte-fix', args: 'f1' });
  });
  it('falls back to the main checkout, skips bare ones', () => {
    const bare = { ...wt('/bare', null), bare: true };
    expect(nextPrefill({ branch: 'x', pipeline: pipe(['current', 'todo', 'todo', 'todo', 'todo'], next) }, [bare, wt('/r', 'main', true)])?.wt).toBe('/r');
  });
  it('is null when nothing is next or there is no worktree', () => {
    expect(nextPrefill({ branch: '', pipeline: pipe(['done', 'done', 'done', 'done', 'done']) }, [wt('/r', 'main', true)])).toBeNull();
    expect(nextPrefill({ branch: '', pipeline: pipe(['current', 'todo', 'todo', 'todo', 'todo'], next) }, [])).toBeNull();
  });
  it('labels the button', () => { expect(nextLabel({ pipeline: pipe(['current', 'todo', 'todo', 'todo', 'todo'], next) })).toBe('Run /cohorte-fix f1'); });
});
