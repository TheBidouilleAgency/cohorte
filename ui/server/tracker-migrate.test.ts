import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tracker, connectObsidian, localDir, serialize, trackerFor, trackerOf } from './tracker';
import type { Ticket } from '../shared/api';

const ticket = (id: string, status: Ticket['status'], extra: Partial<Ticket> = {}): Ticket => ({
  id, title: `Title ${id}`, type: 'feature', status, requester: 'Roro', priority: 'high', size: 'S', created: '2026-11-23', updated: '2026-11-23T20:00:00.000Z',
  parent: null, pr: null, conversation: null, need: `need ${id}`, value: '', criteria: ['works'], outOfScope: [], notes: '', acceptance: null, feedback: [], ...extra,
});

let tmp = ''; let globalDir = ''; let root = ''; let vault = ''; const PID = 'p1';
const prevConfig = process.env.COHORTE_CONFIG;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cohorte-migrate-'));
  globalDir = path.join(tmp, 'claude'); root = path.join(tmp, 'repo'); vault = path.join(tmp, 'vault');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true }); fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'profile.json'), JSON.stringify({ name: 'roro' }));
  process.env.COHORTE_CONFIG = path.join(globalDir, 'cohorte.config.yaml'); // hermetic, for kanban-move.sh too
  const local = new Tracker({ kind: 'local', dir: localDir(globalDir, PID), board: null, reason: '', projectName: 'roro' });
  local.write(ticket('1-dashboard', 'done'));
  local.write(ticket('2-rounds', 'backlog'));
  local.write(ticket('3-video', 'building'));
});
afterEach(() => {
  if (prevConfig === undefined) delete process.env.COHORTE_CONFIG; else process.env.COHORTE_CONFIG = prevConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const section = (board: string, heading: string): string => {
  const text = fs.readFileSync(board, 'utf8');
  const start = text.indexOf(`## ${heading}\n`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? text.indexOf('%% kanban:settings') : next);
};

describe('connecting Obsidian migrates the local tickets', () => {
  it('copies every ticket into the vault, puts its card in its column, keeps the local copies', async () => {
    const r = await connectObsidian(globalDir, root, PID, { vault });
    expect(r.migrated).toBe(3);
    const tr = trackerFor(globalDir, root, PID);
    expect(tr.info.kind).toBe('obsidian');
    expect(tr.list().map((t) => t.id).sort()).toEqual(['1-dashboard', '2-rounds', '3-video']);
    expect(tr.get('2-rounds')?.need).toBe('need 2-rounds');
    expect(section(r.board, 'Done')).toContain('#1-dashboard');
    expect(section(r.board, 'Backlog')).toContain('#2-rounds');
    expect(section(r.board, 'In progress')).toContain('#3-video');
    expect(section(r.board, 'Backlog')).toContain('[[roro/Tickets/2-rounds|Title 2-rounds]]');
    expect(fs.readdirSync(localDir(globalDir, PID)).filter((n) => n.endsWith('.md'))).toHaveLength(3);
  });

  it('is idempotent and lets the vault copy win', async () => {
    await connectObsidian(globalDir, root, PID, { vault });
    const tr = trackerFor(globalDir, root, PID);
    tr.update('2-rounds', { status: 'framing', need: 'edited in the vault' });
    const again = await connectObsidian(globalDir, root, PID, { vault });
    expect(again.migrated).toBe(0);
    expect(tr.get('2-rounds')?.need).toBe('edited in the vault');
    const board = fs.readFileSync(again.board, 'utf8');
    for (const id of ['1-dashboard', '2-rounds', '3-video']) expect(board.split(`#${id}`).length - 1).toBe(1);
  });

  it('skips a ticket the vault already has, by id or renamed (same title and creation date)', async () => {
    const tickets = path.join(vault, 'roro', 'Tickets');
    const pre = new Tracker({ kind: 'obsidian', dir: tickets, board: null, reason: '', projectName: 'roro' });
    pre.write(ticket('dashboard', 'done', { title: 'Title 1-dashboard' })); // renamed by hand
    pre.write(ticket('2-rounds', 'pr', { need: 'vault version' }));
    const r = await connectObsidian(globalDir, root, PID, { vault });
    expect(r.migrated).toBe(1);
    const tr = trackerFor(globalDir, root, PID);
    expect(tr.list().map((t) => t.id).sort()).toEqual(['2-rounds', '3-video', 'dashboard']);
    expect(tr.get('2-rounds')?.need).toBe('vault version');
  });
});

describe('a vault connected without the migration (by hand, or before it existed)', () => {
  const handConnect = (): string => {
    const board = path.join(vault, 'roro', 'Tasks.md');
    fs.mkdirSync(path.join(path.dirname(board), 'Tickets'), { recursive: true });
    fs.writeFileSync(board, '---\nkanban-plugin: board\n---\n\n## Backlog\n\n## In progress\n\n## Done\n');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'cohorte.config.yaml'), `enabled: true\nobsidian:\n  vault_path: ${JSON.stringify(vault)}\nkanban:\n  enabled: true\n  boards:\n    roro:\n      board: "roro/Tasks.md"\n`);
    return board;
  };

  it('does not show an empty list: the local tickets are migrated on the first read', () => {
    handConnect();
    expect(trackerOf(globalDir, root, PID).kind).toBe('obsidian');
    expect(trackerFor(globalDir, root, PID).list()).toHaveLength(3);
  });

  it('migrates only once: a ticket deleted from the vault afterwards stays deleted', () => {
    handConnect();
    const tr = trackerFor(globalDir, root, PID);
    fs.rmSync(path.join(tr.info.dir, '3-video.md'));
    expect(trackerFor(globalDir, root, PID).list().map((t) => t.id).sort()).toEqual(['1-dashboard', '2-rounds']);
  });

  it('leaves a malformed local note behind instead of failing', () => {
    fs.writeFileSync(path.join(localDir(globalDir, PID), 'junk.md'), 'not a ticket');
    fs.writeFileSync(path.join(localDir(globalDir, PID), '4-raw.md'), serialize(ticket('4-raw', 'validate')));
    handConnect();
    expect(trackerFor(globalDir, root, PID).list()).toHaveLength(4);
  });
});
