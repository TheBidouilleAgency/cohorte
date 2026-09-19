// A standalone OS process: opens its own connection, starts a read transaction over `events` and holds it open
// (prints "ready" once the read has happened), so the parent can SIGKILL it mid-read. `node:sqlite` in WAL mode
// gives a reader a private snapshot; it must never block a writer's `BEGIN IMMEDIATE` (DESIGN 2.4 "lock-free, safe
// to SIGKILL the reader at any instant").
// `node reader-hold.ts <dbPath>`
import { DatabaseSync } from 'node:sqlite';

const [, , dbPath] = process.argv;
if (!dbPath) {
  console.error('usage: reader-hold.ts <dbPath>');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { open: true, timeout: 5000 });
db.exec('BEGIN');
db.prepare('SELECT * FROM events').all();
process.stdout.write('ready\n');
// Held open on purpose until the parent sends SIGKILL: no `finally`, no cleanup (that is the point of the test).
setInterval(() => undefined, 1000);
