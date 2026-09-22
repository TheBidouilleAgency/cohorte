import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Run } from './contracts.ts';

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  create(run: Run) {
    this.db.prepare('INSERT INTO runs VALUES (?, ?)').run(run.id, JSON.stringify(run));
  }
  get(id: string): Run {
    const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);
    if (!row) throw new Error('Unknown run');
    return JSON.parse(row.body as string) as Run;
  }
  save(run: Run, kind: string, detail = '') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run), run.id);
      this.event(run.id, kind, detail);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  event(id: string, kind: string, detail: string) {
    this.db
      .prepare('INSERT INTO events(run_id,at,kind,detail) VALUES (?,?,?,?)')
      .run(id, new Date().toISOString(), kind, detail.slice(0, 16_384));
  }
  events(id: string) {
    return this.db.prepare('SELECT seq,at,kind,detail FROM events WHERE run_id=? ORDER BY seq').all(id);
  }
  close() {
    this.db.close();
  }
}
