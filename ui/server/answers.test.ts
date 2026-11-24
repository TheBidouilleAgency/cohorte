// What crosses processes through the run store, and what never does: a question's answer may come from another
// process (recorded `remote`); a permission ask is answered only by the process that runs it — a file dropped in
// answers/ (by an agent's background shell, say) must not approve it. Plus the lease and process identity it rests on.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Runs, remoteAnswerable, type Run } from './runs';
import { RunStore } from './history';
import { Leases } from './lease';
import { alive, isSelf, self, startOf } from './proc';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohorte-answers-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const fake = path.join(dir, 'fake-claude.js');
// asks what FAKE_ASK says (a Bash permission, or an AskUserQuestion), then reports the answer it got and ends
fs.writeFileSync(fake, `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const q = process.env.FAKE_ASK === 'question';
rl.on('line', (l) => {
  const v = JSON.parse(l);
  if (v.type === 'user') {
    out({ type: 'system', subtype: 'init', session_id: 's1' });
    out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: q ? 'AskUserQuestion' : 'Bash',
      input: q ? { questions: [{ question: 'Which?', header: process.env.FAKE_HEADER || 'visible', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] } : { command: 'rm -rf /tmp/x' } } });
  }
  if (v.type === 'control_response') {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'got ' + v.response.response.behavior + ' ' + JSON.stringify(v.response.response.updatedInput && v.response.response.updatedInput.answers || null) }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  }
});
rl.on('close', () => process.exit(0));
`);
fs.chmodSync(fake, 0o755);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(30); } return false; };

function runs(store: string): Runs { return new Runs({ bin: fake, store: new RunStore(store), quietMs: 50 }); }
function start(r: Runs, ask: 'question' | 'permission'): Run {
  process.env.FAKE_ASK = ask;
  return r.start({ projectId: 'p1', cwd: dir, command: '/cohorte-build f1' });
}
const texts = (run: Run) => run.events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('\n');

describe.skipIf(process.platform === 'win32')('answers across processes', () => {
  it('a permission ask is never approved by a file in answers/', async () => {
    const store = path.join(dir, 'runs-perm');
    const mine = runs(store);
    const run = start(mine, 'permission');
    expect(await until(() => run.pending.size === 1)).toBe(true);
    // what any process of the user could do: drop an "allow" for the ask it can read in the run file
    const answers = path.join(store, 'p1', 'answers');
    fs.mkdirSync(answers, { recursive: true });
    fs.writeFileSync(path.join(answers, `${run.id}.r1.json`), JSON.stringify({ requestId: 'r1', behavior: 'allow', answers: {} }));
    await sleep(800); // several collection rounds
    expect(run.pending.has('r1')).toBe(true);
    // and another process's Runs (the page) refuses to answer it at all
    const other = runs(store);
    await sleep(500);
    const seen = other.get(run.id) as Run;
    expect(seen.pending.get('r1')?.kind).toBe('permission');
    expect(other.respond(seen, 'r1', 'allow')).toBe(false);
    // only the driving process answers it
    expect(mine.respond(run, 'r1', 'deny')).toBe(true);
    expect(await until(() => run.status !== 'running')).toBe(true);
    expect(texts(run)).toContain('got deny');
  });

  it("a question's answer from another process reaches the run, marked remote", async () => {
    const store = path.join(dir, 'runs-q');
    const mine = runs(store);
    const by: string[] = [];
    mine.hooks = { onAnswered: (_r, _p, _b, _a, who) => { by.push(who); } };
    const run = start(mine, 'question');
    expect(await until(() => run.pending.size === 1)).toBe(true);
    // the decider read it (and handed it over): only a question it classified may come from elsewhere
    mine.annotate(run, 'r1', { advice: { choice: 'A', rationale: '', agreement: 0.5, category: 'visible', escalated: 'split vote' } });
    await sleep(100);
    const other = runs(store);
    const seen = other.get(run.id) as Run;
    expect(seen.pending.get('r1')?.kind).toBe('question');
    expect(other.respond(seen, 'r1', 'allow', { 'Which?': 'B' })).toBe(true);
    expect(await until(() => run.status !== 'running')).toBe(true);
    expect(texts(run)).toContain('"Which?":"B"');
    expect(by).toEqual(['remote']);
  });

  it('a question the decider holds is out of reach of another process', async () => {
    const store = path.join(dir, 'runs-held');
    const mine = runs(store);
    mine.hooks = { onQuestion: () => true }; // the decider takes it
    const run = start(mine, 'question');
    expect(await until(() => run.pending.size === 1)).toBe(true);
    await sleep(100);
    const other = runs(store);
    const seen = other.get(run.id) as Run;
    expect(seen.pending.get('r1')?.deciding).toBe(true);
    expect(other.respond(seen, 'r1', 'allow', { 'Which?': 'A' })).toBe(false);
    mine.stop(run);
  });

  it('a security, irreversible or cost question — or one of the ship stage — is answered only where its run runs', async () => {
    const q = (header: string, category?: string) => ({ kind: 'question' as const, questions: [{ question: 'x', header, multiSelect: false, options: [] }],
      advice: category ? { choice: null, rationale: '', agreement: 0, category, escalated: '' } : undefined });
    expect(remoteAnswerable({ meta: { role: 'stage', stage: 'build' } }, q('visible', 'visible'))).toBe(true);
    expect(remoteAnswerable({ meta: { role: 'stage', stage: 'build' } }, q('visible'))).toBe(false); // the agent's own label, not classified by the decider
    for (const h of ['security', 'Irreversible', 'cost']) expect(remoteAnswerable({ meta: { role: 'stage', stage: 'fix' } }, q(h))).toBe(false);
    expect(remoteAnswerable({ meta: { role: 'stage', stage: 'fix' } }, q('visible', 'security'))).toBe(false);
    expect(remoteAnswerable({ meta: { role: 'stage', stage: 'ship' } }, q('visible', 'visible'))).toBe(false);
    // end to end: the store's answer file for a security question is not applied, and another process cannot write one
    const store = path.join(dir, 'runs-sec');
    const mine = runs(store);
    process.env.FAKE_HEADER = 'security';
    const run = start(mine, 'question');
    delete process.env.FAKE_HEADER;
    expect(await until(() => run.pending.size === 1)).toBe(true);
    await sleep(100);
    const other = runs(store);
    expect(other.respond(other.get(run.id) as Run, 'r1', 'allow', { 'Which?': 'A' })).toBe(false);
    fs.mkdirSync(path.join(store, 'p1', 'answers'), { recursive: true });
    fs.writeFileSync(path.join(store, 'p1', 'answers', `${run.id}.r1.json`), JSON.stringify({ requestId: 'r1', behavior: 'allow', answers: { 'Which?': 'A' } }));
    await sleep(700);
    expect(run.pending.has('r1')).toBe(true);
    mine.stop(run);
  });

  it('agents of a run carry COHORTE_RUN_ID (the CLI refuses them every transition)', async () => {
    const envDump = path.join(dir, 'env-dump.js');
    fs.writeFileSync(envDump, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(path.join(dir, 'env.json'))}, JSON.stringify({ id: process.env.COHORTE_RUN_ID, p: process.env.COHORTE_RUN_PROJECT }));\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n`);
    fs.chmodSync(envDump, 0o755);
    const r = new Runs({ bin: envDump });
    const run = r.start({ projectId: 'p9', cwd: dir, command: '/cohorte-build f1' });
    expect(await until(() => fs.existsSync(path.join(dir, 'env.json')))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8'))).toEqual({ id: run.id, p: 'p9' });
    r.stop(run);
  });
});

describe.skipIf(process.platform === 'win32')('process identity and the lease', () => {
  it('a pid is alive only with its start time', async () => {
    expect(alive(self.pid, self.start)).toBe(true);
    expect(alive(self.pid, 1000)).toBe(false); // our pid, someone else's start: a reused pid
    expect(isSelf({ pid: self.pid, start: 1000 })).toBe(false);
    const child = spawn('sleep', ['20'], { stdio: 'ignore' });
    await sleep(200);
    const st = startOf(child.pid as number);
    expect(typeof st).toBe('number');
    expect(alive(child.pid, st)).toBe(true);
    expect(alive(child.pid, (st as number) - 3600)).toBe(false);
    child.kill();
    expect(await until(() => !alive(child.pid, st))).toBe(true);
  });

  it('the lease is taken by one process at a time, and a stale one is replaced', async () => {
    const L = new Leases(path.join(dir, 'leases'));
    expect(L.acquire('p1', 'f1', 'ui')).toBeNull();
    expect(L.acquire('p1', 'f1', 'ui')).toBeNull(); // re-entrant
    expect(L.mine('p1', 'f1')).toBe(true);
    const file = path.join(dir, 'leases', 'p1', 'f1.lock');
    // a live other holder
    const child = spawn('sleep', ['20'], { stdio: 'ignore' });
    await sleep(200);
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, start: startOf(child.pid as number), by: 'cli', at: '', token: 'a' }));
    expect(L.acquire('p1', 'f1', 'ui')?.pid).toBe(child.pid);
    L.release('p1', 'f1'); // not ours: kept
    expect(fs.existsSync(file)).toBe(true);
    // the same pid recorded with another start (a reboot reused it): stale, replaced
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, start: 1000, by: 'cli', at: '', token: 'b' }));
    expect(L.holder('p1', 'f1')).toBeNull();
    expect(L.acquire('p1', 'f1', 'ui')).toBeNull();
    expect(L.mine('p1', 'f1')).toBe(true);
    L.release('p1', 'f1');
    expect(fs.existsSync(file)).toBe(false);
    child.kill();
  });

  it('a filesystem that cannot link (FAT, a network share) still gets exclusive, whole locks', () => {
    const L = new Leases(path.join(dir, 'leases3'));
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    try {
      expect(L.acquire('p1', 'f3', 'ui')).toBeNull();
      expect(spy).toHaveBeenCalled(); // the link really failed: the fallback took it
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'leases3', 'p1', 'f3.lock'), 'utf8')).pid).toBe(process.pid);
      expect(L.acquire('p1', 'f3', 'ui')).toBeNull(); // re-entrant
      L.release('p1', 'f3');
      expect(fs.existsSync(path.join(dir, 'leases3', 'p1', 'f3.lock'))).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('a lock being written (unreadable, young) is live; an old unreadable one is stale', () => {
    const L = new Leases(path.join(dir, 'leases2'));
    const file = path.join(dir, 'leases2', 'p1', 'f2.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(L.holder('p1', 'f2')).not.toBeNull();
    expect(L.acquire('p1', 'f2', 'ui')).not.toBeNull(); // not taken from under its writer
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
    expect(L.holder('p1', 'f2')).toBeNull();
    expect(L.acquire('p1', 'f2', 'ui')).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(process.pid); // whole, never empty
  });
});
