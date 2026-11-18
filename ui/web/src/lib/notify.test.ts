import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../../../shared/api';
import { notifyDecision, notifyText, titleFor } from './notify';

const run = (status: string, pending?: number): StreamEvent => ({ type: 'run', projectId: 'p', id: 'r', status, pending });
describe('notifyDecision', () => {
  it('a new gate while hidden notifies', () => { expect(notifyDecision({ status: 'running', pending: 0 }, run('running', 1), true)).toBe('gate'); });
  it('an unchanged gate does not repeat', () => { expect(notifyDecision({ status: 'running', pending: 1 }, run('running', 1), true)).toBeNull(); });
  it('finishing notifies once', () => {
    expect(notifyDecision({ status: 'running', pending: 0 }, run('done', 0), true)).toBe('finished');
    expect(notifyDecision({ status: 'done', pending: 0 }, run('done', 0), true)).toBeNull();
  });
  it('stays silent while the tab is visible and for jobs', () => {
    expect(notifyDecision({ status: 'running', pending: 0 }, run('running', 2), false)).toBeNull();
    expect(notifyDecision(undefined, { type: 'job', projectId: 'p', id: 'j', status: 'ready' }, true)).toBeNull();
  });
  it('a run first seen with a gate notifies', () => { expect(notifyDecision(undefined, run('running', 1), true)).toBe('gate'); });
});
describe('text', () => {
  it('words the notification', () => {
    expect(notifyText('gate', 'kervo', '/cohorte-build f1', 'running').title).toBe('kervo needs you');
    expect(notifyText('finished', 'kervo', '/x', 'failed').title).toBe('kervo: failed');
  });
  it('titles the tab', () => { expect(titleFor(0)).toBe('Cohorte'); expect(titleFor(2)).toBe('(2) Cohorte'); });
});
