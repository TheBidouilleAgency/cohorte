// The run manager against a stand-in `claude -p`: it plays a scripted NDJSON sequence, parks each permission ask
// on its stdin, and — like the real CLI — fails every ask with "Stream closed" once that stdin is closed.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { Runs, type Run } from './runs';
import { textsOf } from './agents';
import { proposalsOf } from '../shared/blocks';
import type { RunEvent } from '../shared/api';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohorte-runs-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const fake = path.join(dir, 'fake-claude.js');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const rl = require('readline').createInterface({ input: process.stdin });
const steps = JSON.parse(fs.readFileSync(process.env.FAKE_STEPS, 'utf8'));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let closed = false, go;
const first = new Promise((r) => { go = r; });
const waiting = new Map();
rl.on('line', (l) => {
  const v = JSON.parse(l);
  if (v.type === 'user') go();
  if (v.type === 'control_response') { const w = waiting.get(v.response.request_id); if (w) { waiting.delete(v.response.request_id); w(v.response.response.behavior); } }
});
rl.on('close', () => { closed = true; for (const w of waiting.values()) w('closed'); waiting.clear(); });
(async () => {
  await first;
  let n = 0;
  for (const s of steps) {
    if (s.wait) { await sleep(s.wait); continue; }
    if (s.ask) {
      const id = 'req' + (++n);
      let b = 'closed';
      if (!closed) { out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: s.ask } } }); b = await new Promise((r) => waiting.set(id, r)); }
      out({ type: 'user', parent_tool_use_id: s.parent || null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + id, is_error: b !== 'allow',
        content: b === 'closed' ? 'Tool permission request failed: AbortError: Stream closed' : 'ok' }] } });
      continue;
    }
    out(s);
  }
  while (!closed) await sleep(10);
  process.exit(0);
})();
`);
fs.chmodSync(fake, 0o755);

const lead = (content: unknown[]) => ({ type: 'assistant', parent_tool_use_id: null, session_id: 's1', message: { role: 'assistant', content } });
const fromSub = (parent: string, content: unknown[]) => ({ type: 'assistant', parent_tool_use_id: parent, session_id: 's1', message: { role: 'assistant', content } });
const toolResult = (id: string, text: string, parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, duration_ms: 10, num_turns: 1 });
const ASYNC = 'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a8b38fa2fb1b59df3\nThe agent is working in the background.';

/** Plays `steps`, allowing every ask, and resolves once the run ended (with how long it took). */
function play(steps: unknown[], opts: { quietMs?: number; stallMs?: number } = {}): Promise<{ run: Run; ms: number }> {
  const f = path.join(dir, `steps-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(steps));
  process.env.FAKE_STEPS = f;
  const runs = new Runs({ bin: fake, quietMs: opts.quietMs ?? 80, stallMs: opts.stallMs ?? 10_000 });
  const t0 = Date.now();
  return new Promise((resolve) => {
    runs.onChange = (r) => { for (const p of r.pending.values()) setImmediate(() => runs.respond(r, p.requestId, 'allow')); };
    runs.hooks.onEnd = (r) => resolve({ run: r, ms: Date.now() - t0 });
    runs.start({ projectId: 'p', cwd: dir, command: '/cohorte-fix f1' });
  });
}
const closedAsks = (evs: RunEvent[]) => evs.filter((e) => e.kind === 'tool_result' && /Stream closed/.test(e.text));
const ticket = (i: number) => `\`\`\`cohorte-ticket\n${JSON.stringify({ ref: `t${i}`, title: `Ticket ${i}`, need: 'x'.repeat(3000), criteria: ['a', 'b'] })}\n\`\`\``;

// The stand-in CLI is a shebang script: Windows cannot spawn it (same as scripts/test-flow.mjs).
const onPosix = describe.skipIf(process.platform === 'win32');

onPosix('runs: background subagents keep the permission channel open', () => {
  it('holds input open past the lead\'s result until its async agent reports, and through the turn that follows', async () => {
    const { run } = await play([
      lead([{ type: 'tool_use', id: 'ta', name: 'Agent', input: { subagent_type: 'frontend', description: 'fix lint', run_in_background: true } }]),
      { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'ta', is_backgrounded: true, session_id: 's1' },
      toolResult('ta', ASYNC),
      lead([{ type: 'text', text: 'The frontend agent runs in the background.' }]),
      result('The frontend agent runs in the background.'),
      { wait: 400 }, // way past the quiet delay
      fromSub('ta', [{ type: 'tool_use', id: 'sb1', name: 'Bash', input: { command: 'pnpm lint' } }]),
      { ask: 'pnpm lint', parent: 'ta' },
      fromSub('ta', [{ type: 'text', text: '# HANDOFF — frontend\n```cohorte-plan\n{"summary":"not the lead\'s","criteria":["x"]}\n```' }]),
      { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'ta', status: 'completed', summary: 'done', session_id: 's1' },
      { wait: 400 }, // the lead thinks before its next turn shows
      { ask: 'pnpm check-types' },
      lead([{ type: 'text', text: 'Verdict: SHIP.' }]),
      result('Verdict: SHIP.'),
    ]);
    expect(closedAsks(run.events)).toEqual([]);
    expect(run.events.filter((e) => e.kind === 'resolved')).toHaveLength(2);
    expect(run.events.filter((e) => e.kind === 'result')).toHaveLength(2);
    expect(run.result?.text).toBe('Verdict: SHIP.');
    expect(run.status).toBe('done');
    expect(run.tasks.size).toBe(0);
  });

  it('tracks an async agent and a background shell from their tool_result alone (no task_started)', async () => {
    const { run } = await play([
      lead([{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }, { type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'pnpm test', run_in_background: true } }]),
      toolResult('ta', ASYNC),
      toolResult('tb', 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output'),
      result('dispatched'),
      { wait: 2300 }, // past the 2 s quiet delay any build closed on, whatever quietMs says
      { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'tb', status: 'completed' },
      { wait: 300 },
      { ask: 'cat /tmp/b1.output', parent: 'ta' }, // the agent is still out
      { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'ta', status: 'completed' },
      { wait: 300 },
      { ask: 'git status' },
      result('all in'),
    ]);
    expect(closedAsks(run.events)).toEqual([]);
    expect(run.status).toBe('done');
  });

  it('still closes promptly after a foreground agent', async () => {
    const { run, ms } = await play([
      lead([{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }]),
      { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'ta', is_backgrounded: false },
      toolResult('ta', 'REVIEW REPORT — verdict SHIP'),
      { type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'ta', status: 'completed' }, // already settled
      result('done'),
    ], { stallMs: 5000 });
    expect(run.status).toBe('done');
    expect(ms).toBeLessThan(3000);
  });

  it('does not hold the run open for a background shell that never ends (a dev server)', async () => {
    for (const started of [true, false]) {
      const { run, ms } = await play([
        lead([{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'pnpm dev', run_in_background: true } }]),
        ...(started ? [{ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tb', task_type: 'local_bash', description: 'pnpm dev' }] : []),
        toolResult('tb', 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output'),
        result('the dev server is up'),
      ], { stallMs: 10_000 });
      expect(run.status).toBe('done');
      expect(ms).toBeLessThan(3000);
    }
  });

  it('settles an older CLI\'s placeholder on a completion that names no tool call', async () => {
    const { run, ms } = await play([
      lead([{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }]),
      toolResult('ta', ASYNC), // no task_started: a placeholder
      result('dispatched'),
      { wait: 300 },
      { ask: 'pnpm lint', parent: 'ta' },
      { type: 'system', subtype: 'task_notification', task_id: 'a8b38fa2fb1b59df3', status: 'completed' }, // no tool_use_id
      { wait: 300 },
      { ask: 'git status' },
      result('all in'),
    ], { stallMs: 10_000 });
    expect(closedAsks(run.events)).toEqual([]);
    expect(run.status).toBe('done');
    expect(ms).toBeLessThan(5000);
  });

  it('gives up after the stall timeout when a background task never reports', async () => {
    const { run, ms } = await play([
      lead([{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }]),
      { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'ta', is_backgrounded: true },
      toolResult('ta', ASYNC),
      result('dispatched'),
    ], { stallMs: 600 });
    expect(run.status).toBe('done');
    expect(ms).toBeGreaterThanOrEqual(600);
    expect(run.events.some((e) => e.kind === 'system' && /background agent/.test(e.text))).toBe(true);
  });
});

onPosix('runs: what the lead said is parsed whole, and only what the lead said', () => {
  it('keeps a long lead message whole, so every fenced ticket is filed', async () => {
    const text = `Here is the first version.\n\n${Array.from({ length: 11 }, (_, i) => ticket(i + 1)).join('\n\n')}`;
    expect(text.length).toBeGreaterThan(30_000);
    const { run } = await play([lead([{ type: 'text', text }]), result('ok')]);
    expect(proposalsOf(textsOf(run.events))).toHaveLength(11);
  });

  it('tags a subagent\'s messages and keeps them out of the lead\'s texts', async () => {
    const { run } = await play([
      lead([{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }]),
      fromSub('ta', [{ type: 'text', text: `REVIEW REPORT\n${ticket(1)}` }, { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/x' } }]),
      toolResult('s1', 'file', 'ta'),
      toolResult('ta', 'REVIEW REPORT — done'),
      lead([{ type: 'text', text: ticket(2) }]),
      result('ok'),
    ]);
    const sub = run.events.filter((e) => 'sub' in e && e.sub);
    expect(sub.map((e) => e.kind)).toEqual(['text', 'tool', 'tool_result']);
    expect(textsOf(run.events)).toEqual([ticket(2)]);
    expect(proposalsOf(textsOf(run.events)).map((p) => p.ref)).toEqual(['t2']);
  });
});
