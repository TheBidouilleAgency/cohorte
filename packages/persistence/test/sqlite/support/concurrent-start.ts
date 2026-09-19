// A standalone OS process: the `start` dance (4.3 #1) — enqueue the signed start command, and only on a fresh
// enqueue create the IDLE run row, in ONE project transaction. Prints `{"status": "..."}` on stdout.
// `node concurrent-start.ts <dbPath> <runJson> <commandJson>`
import type { RunRecord } from '@cohorte/persistence/contract';
import { openSqliteStore } from '@cohorte/persistence/sqlite';
import type { CommandEnvelope } from '@cohorte/protocol';

const [, , dbPathArg, runRaw, commandRaw] = process.argv;
if (!dbPathArg || !runRaw || !commandRaw) {
  console.error('usage: concurrent-start.ts <dbPath> <runJson> <commandJson>');
  process.exit(2);
}
const dbPath: string = dbPathArg;
const run = JSON.parse(runRaw) as RunRecord;
const command = JSON.parse(commandRaw) as CommandEnvelope<'start'>;

async function main(): Promise<void> {
  const store = openSqliteStore({ path: dbPath });
  await store.open();
  const status = await store.transact('project', null, (tx) => {
    const outcome = tx.enqueueCommand(command);
    if (outcome === 'enqueued') tx.putRun(run);
    return outcome;
  });
  await store.close();
  process.stdout.write(`${JSON.stringify({ status })}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
