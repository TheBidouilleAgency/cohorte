// A standalone OS process: appends `count` events to `runId` one `transact()` at a time, under the given lease.
// `node concurrent-writer.ts <dbPath> <runId> <leaseJson> <count> <label>`
import type { EventId, IsoInstant, RunId } from '@cohorte/base';
import type { LeaseToken } from '@cohorte/persistence/contract';
import { openSqliteStore } from '@cohorte/persistence/sqlite';
import { sealForTest } from '@cohorte/testkit/store-factory';

const [, , dbPathArg, runIdArg, leaseArg, countArg, labelArg] = process.argv;
if (!dbPathArg || !runIdArg || !leaseArg || !countArg || !labelArg) {
  console.error('usage: concurrent-writer.ts <dbPath> <runId> <leaseJson> <count> <label>');
  process.exit(2);
}
const dbPath: string = dbPathArg;
const runId = runIdArg as RunId;
const lease = JSON.parse(leaseArg) as LeaseToken;
const count = Number.parseInt(countArg, 10);
const label: string = labelArg;

async function main(): Promise<void> {
  const store = openSqliteStore({ path: dbPath });
  await store.open();
  for (let index = 0; index < count; index += 1) {
    await store.transact({ runId }, lease, (tx) =>
      tx.appendEvents([
        sealForTest({
          protocolVersion: '1.0',
          eventId: `evt-${label}-${index}` as EventId,
          timestamp: new Date().toISOString() as IsoInstant,
          runId,
          type: 'check.started',
          source: 'cohorte',
          summary: `writer ${label} #${index}`,
          severity: 'info',
          payload: { name: `${label}-${index}`, argv: ['x'], slot: 'main' },
          redactions: [],
        }),
      ]),
    );
  }
  await store.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
