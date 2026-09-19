// U1.10 — DESIGN 4.4 step 10's reconciliation note: "note content for each of the five situations (the approved
// case in its three outcomes: executed / binding-changed / denied-by-gate)". Pure text builder (D5): no store, no
// ports.
import { describe, expect, test } from 'vitest';
import { buildReconciliationNoteText, type NoteItem } from '../../src/resume/note.ts';
import { approvalId2, artifactId2, asAgentId, effectId2, sha256Of, toolCallId2 } from './support.ts';

const agentId = asAgentId('a1');

describe('buildReconciliationNoteText — the five situations', () => {
  test('nothing in flight: still a fact, never an instruction', () => {
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 1, items: [] });
    expect(text).toContain('nothing of yours was in flight');
    expect(text).not.toMatch(/please|re-issue|try again/i);
  });

  test('not-executed', () => {
    const items: NoteItem[] = [{ situation: 'not-executed', toolCallId: toolCallId2(1, 1), tool: 'run_command' }];
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 1, items });
    expect(text).toContain('run_command');
    expect(text).toContain('was not executed');
  });

  test('completed: the recorded result is carried, the work is kept', () => {
    const items: NoteItem[] = [
      {
        situation: 'completed',
        toolCallId: toolCallId2(1, 2),
        tool: 'write_file',
        resultSummary: 'wrote 12 bytes to a.txt',
      },
    ];
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 1, items });
    expect(text).toContain('completed before the restart');
    expect(text).toContain('wrote 12 bytes to a.txt');
  });

  test('compensated: names the checkpoint and the saved patch artifact', () => {
    const items: NoteItem[] = [
      {
        situation: 'compensated',
        effectId: effectId2('1'),
        checkpointSha: 'c'.repeat(40),
        patch: {
          artifactId: artifactId2('1'),
          kind: 'diff',
          path: 'w1.patch',
          sha256: sha256Of('d'.repeat(64)),
          bytes: 5,
        },
      },
    ];
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 1, items });
    expect(text).toContain('c'.repeat(40));
    expect(text).toContain(artifactId2('1'));
    expect(text).toContain('discarded');
  });

  test('in-doubt: neither assumed to have run nor not to have run, never auto re-issued', () => {
    const items: NoteItem[] = [
      { situation: 'in-doubt', effectId: effectId2('2'), kind: 'tool.run_command', replayClass: 'at-most-once' },
    ];
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 1, items });
    expect(text).toContain('Do not assume it ran');
    expect(text).toContain('do not assume it did not run');
    expect(text).toContain('will not be re-issued automatically');
  });

  test('approved: executed — states a fact, never "please re-issue"', () => {
    const items: NoteItem[] = [
      {
        situation: 'approved',
        approvalId: approvalId2('1'),
        toolCallId: toolCallId2(1, 3),
        tool: 'run_command',
        outcome: 'executed',
        resultSummary: 'exit 0',
      },
    ];
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 1, items });
    expect(text).toContain('was approved and has been executed');
    expect(text).toContain('exit 0');
  });

  test('approved: binding-changed — NOT executed, tells the agent to re-request rather than assume', () => {
    const items: NoteItem[] = [
      {
        situation: 'approved',
        approvalId: approvalId2('2'),
        toolCallId: toolCallId2(1, 4),
        tool: 'write_file',
        outcome: 'binding-changed',
      },
    ];
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 1, items });
    expect(text).toContain('was approved but NOT executed');
    expect(text).toContain('workspace changed since you asked');
  });

  test('approved: denied-by-gate', () => {
    const items: NoteItem[] = [
      {
        situation: 'approved',
        approvalId: approvalId2('3'),
        toolCallId: toolCallId2(1, 5),
        tool: 'run_command',
        outcome: 'denied-by-gate',
      },
    ];
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 1, items });
    expect(text).toContain('was denied');
  });

  test('multiple situations render as one note, one line each, in order', () => {
    const items: NoteItem[] = [
      { situation: 'not-executed', toolCallId: toolCallId2(1, 1), tool: 'a' },
      { situation: 'in-doubt', effectId: effectId2('9'), kind: 'tool.run_command', replayClass: 'idempotent' },
    ];
    const text = buildReconciliationNoteText({ agentId, fromIncarnation: 2, items });
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(text).toContain('incarnation 3');
  });
});
